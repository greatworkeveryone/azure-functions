import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { TYPES, type Connection } from 'tedious';
import { ACTION_ROLES } from '../action-roles';
import { AppRole, errorResponse, forbiddenResponse, rolesForRequest, rolesPassGate } from '../auth';
import { authorizeWrite, badRequest, conflict, inTransaction, notFound, readJsonBody, txFail, txOk, type Caller } from '../assetRegisterSupport';
import { closeConnection, createRequestConnection, executeQuery, type SqlParam, type SqlRow } from '../db';
import { VIEW_ASSETS_ROLES } from '../assetRegister';
import { canReadEvent } from '../majorEvents';
import { DOCUMENT_MANAGERS, documentDateStatus, parseDocumentInput, type RegisteredDocumentInput } from '../documentRegister';
import { deleteBlob, downloadBlob, uploadBlob } from '../blob-storage';
import { assertBlobName, REGISTER_DOCUMENT_SHAPE, WR_ATTACHMENTS_SHAPES } from '../blob-names';
import { showTestData } from '../test-data';
import { getProcedures } from './getProcedures';
import { checkRateLimit } from '../rateLimit';

const TENANCY_ROLES = [AppRole.ACCOUNTS,AppRole.ACCOUNTS_APPROVAL,AppRole.ADMIN,AppRole.DIRECTOR];
const str = (name: string,value: unknown): SqlParam => ({ name,type:TYPES.NVarChar,value });
const int = (name: string,value: number | null): SqlParam => ({ name,type:TYPES.Int,value });
const iso = (value: unknown) => value ? new Date(value as string).toISOString().slice(0,10) : null;
const idOf = (value: unknown) => typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 2147483647 ? Number(value) : null;
const COLS = 'd.DocumentId,d.Title,d.Kind,d.ServiceCategory,d.BuildingId,d.TenantId,d.IssuedOn,d.ExpiresOn,d.ReviewDue,d.OwnerName,d.Notes,d.FileName,d.BlobName,d.ContentType,d.SizeBytes,d.Revision,d.CreatedAt,d.CreatedBy,d.CreatedByOid,d.UpdatedAt,d.ArchivedAt';
interface State { connection: Connection; roles: string[]; caller: Caller; showTest: boolean }
interface RegisterItem { id: string; source: string; sourceId: string; title: string; kind: string; category: string; buildingIds: number[]; tenantId: number | null; tenantName: string | null; issuedOn: string | null; expiresOn: string | null; reviewDue: string | null; dateBasis: string; ownerName: string; href: string; canEdit: boolean; status: string; notes?: string; revision?: number; fileName?: string }
const canTenancy = (s: State) => rolesPassGate(s.roles,TENANCY_ROLES);
const canOperational = (s: State) => rolesPassGate(s.roles,VIEW_ASSETS_ROLES);
const canEdit = (s: State,r: SqlRow) => r.CreatedByOid === s.caller.oid || s.roles.some(role => DOCUMENT_MANAGERS.some(allowed => allowed === role));
async function rowFor(s: State,id: number,lock = false) {
 const LOCK = lock ? 'WITH (UPDLOCK,HOLDLOCK)' : '';
 return (await executeQuery(s.connection,`SELECT ${COLS},t.IsTest AS TenantIsTest,t.ArchivedAt AS TenantArchivedAt FROM dbo.RegisterDocuments d ${LOCK} LEFT JOIN dbo.Tenants t ON t.TenantId=d.TenantId WHERE d.DocumentId=@Id`,[int('Id',id)]))[0];
}
function readable(s: State,r: SqlRow) { return canOperational(s) && !r.ArchivedAt && (!r.TenantId || (canTenancy(s) && !r.TenantArchivedAt && (!r.TenantIsTest || s.showTest))); }
function registerItem(s: State,r: SqlRow): RegisterItem {
 return { id:`register:${r.DocumentId}`,source:'register',sourceId:String(r.DocumentId),title:r.Title,kind:r.Kind,category:r.ServiceCategory,buildingIds:r.BuildingId === null ? [] : [Number(r.BuildingId)],tenantId:r.TenantId ?? null,tenantName:r.TenantName ?? null,issuedOn:iso(r.IssuedOn),expiresOn:iso(r.ExpiresOn),reviewDue:iso(r.ReviewDue),dateBasis:'Document expiry / review',ownerName:r.OwnerName,href:`/documentation?documentId=${r.DocumentId}`,canEdit:canEdit(s,r),status:'recorded',notes:r.Notes,revision:r.Revision,fileName:r.FileName };
}
async function validateScope(s: State,v: RegisteredDocumentInput): Promise<string | null> {
 if (v.buildingId !== null && !(await executeQuery(s.connection,'SELECT BuildingID FROM dbo.Buildings WHERE BuildingID=@Id AND Active=1',[int('Id',v.buildingId)])).length) return 'Building is missing or inactive';
 if (v.tenantId) {
  if (!canTenancy(s)) return 'Your role cannot attach documents to a tenancy';
  const row = (await executeQuery(s.connection,'SELECT TenantId,BuildingId,IsTest FROM dbo.Tenants WHERE TenantId=@Id AND ArchivedAt IS NULL',[int('Id',v.tenantId)]))[0];
  if (!row || row.BuildingId !== v.buildingId || (row.IsTest && !s.showTest)) return 'Tenancy is unavailable or belongs to another building';
 }
 return null;
}
function params(v: RegisteredDocumentInput): SqlParam[] { return [str('Title',v.title),str('Kind',v.kind),str('Category',v.category),int('Building',v.buildingId),int('Tenant',v.tenantId),str('Issue',v.issuedOn),str('Expiry',v.expiresOn),str('Review',v.reviewDue),str('Owner',v.ownerName),str('Notes',v.notes)]; }
async function audit(s: State,id: number,action: string,snapshot: unknown) { await executeQuery(s.connection,'INSERT dbo.RegisterDocumentAudit (DocumentId,Action,SnapshotJson,ActorName,ActorOid) VALUES (@Id,@Action,@Snapshot,@Name,@Oid)',[int('Id',id),str('Action',action),str('Snapshot',JSON.stringify(snapshot)),str('Name',s.caller.name),str('Oid',s.caller.oid)]); }
type Work = (request: HttpRequest,state: State,context: InvocationContext) => Promise<HttpResponseInit>;
async function withDocumentRegister(request: HttpRequest,context: InvocationContext,write: boolean,work: Work): Promise<HttpResponseInit> {
 const auth = await authorizeWrite(request,write ? ACTION_ROLES.editRegisterDocuments.gate : ACTION_ROLES.viewDocumentation.gate);
 if (!auth.ok) return auth.response;
 const roles = await rolesForRequest(request);
 const limited = checkRateLimit(`documentation:${auth.caller.oid}`,{limit:90,windowMs:60_000});
 if (!limited.allowed) return {status:429,headers:{'Retry-After':'60'},jsonBody:{error:'Please wait before trying again'}};
 let connection: Connection | undefined;
 try { connection = await createRequestConnection(auth.token); const result = await work(request,{connection,roles,caller:auth.caller,showTest:await showTestData(request)},context); result.headers={...result.headers,'Cache-Control':'no-store'}; return result; }
 catch(e) { context.error('Documentation request failed',e instanceof Error ? e.message : 'unknown error'); return errorResponse('Documentation request failed',e); }
 finally { if(connection) closeConnection(connection); }
}
export async function getDocumentRegister(req: HttpRequest,ctx: InvocationContext): Promise<HttpResponseInit> { return withDocumentRegister(req,ctx,false,async (request,s,context) => {
 const items: RegisterItem[]=[]; let truncated=false;
 if (canOperational(s)) {
  const rows = await executeQuery(s.connection,`SELECT TOP(2000) ${COLS},t.LegalName AS TenantName,t.IsTest AS TenantIsTest,t.ArchivedAt AS TenantArchivedAt FROM dbo.RegisterDocuments d LEFT JOIN dbo.Tenants t ON t.TenantId=d.TenantId WHERE d.ArchivedAt IS NULL AND (d.TenantId IS NULL OR (@Tenancy=1 AND t.ArchivedAt IS NULL AND (t.IsTest=0 OR @ShowTest=1))) ORDER BY d.UpdatedAt DESC`,[{name:'Tenancy',type:TYPES.Bit,value:canTenancy(s)},{name:'ShowTest',type:TYPES.Bit,value:s.showTest}]);
  items.push(...rows.filter(r=>readable(s,r)).map(r=>registerItem(s,r))); truncated ||= rows.length===2000;
 }
 // Reuse the source reader's audience, draft and endorsement rules, then return metadata only.
 const procedures = await getProcedures(request,context);
 if (procedures.status !== 200) return procedures;
 for (const p of (procedures.jsonBody as {procedures: {slug:string;category:string;owner?:string;versions:{title:string;status:string;reviewDue?:string;publishedAt?:string;createdAt?:string}[]}[]}).procedures) {
  const v=p.versions.find(v=>v.status==='published') ?? p.versions.find(v=>v.status==='draft'); if(!v) continue;
  items.push({id:`procedure:${p.slug}`,source:'procedure',sourceId:p.slug,title:v.title,kind:'procedure',category:p.category,buildingIds:[],tenantId:null,tenantName:null,issuedOn:iso(v.publishedAt ?? v.createdAt),expiresOn:null,reviewDue:v.reviewDue ?? null,dateBasis:'Procedure review',ownerName:p.owner ?? '',href:`/procedures/${encodeURIComponent(p.slug)}`,canEdit:false,status:v.status==='draft' ? 'unendorsed' : 'endorsed'});
 }
 if(canTenancy(s)) {
  const rows=await executeQuery(s.connection,`SELECT TOP(2000) a.Id,a.OriginalName,a.UploadedAt,t.TenantId,t.LegalName,t.BuildingId,t.Expiry FROM dbo.TenancyAttachments ta JOIN dbo.Attachments a ON a.Id=ta.AttachmentID JOIN dbo.Tenants t ON t.TenantId=ta.TenantId WHERE a.ArchivedAt IS NULL AND t.ArchivedAt IS NULL AND (t.IsTest=0 OR @ShowTest=1) ORDER BY a.UploadedAt DESC`,[{name:'ShowTest',type:TYPES.Bit,value:s.showTest}]); truncated ||= rows.length===2000;
  for(const r of rows) items.push({id:`tenancy:${r.TenantId}:${r.Id}`,source:'tenancy',sourceId:String(r.Id),title:r.OriginalName,kind:'tenancy_document',category:'Tenancy / lease',buildingIds:[Number(r.BuildingId)],tenantId:Number(r.TenantId),tenantName:r.LegalName,issuedOn:iso(r.UploadedAt),expiresOn:iso(r.Expiry),reviewDue:null,dateBasis:'Linked lease expiry (not file validity)',ownerName:'',href:`/tenancy?tenantId=${r.TenantId}`,canEdit:false,status:'recorded'});
 }
 if(canOperational(s)) {
  const rows=await executeQuery(s.connection,'SELECT TOP(2000) EventId,Title,Domain,Audience,EventClass,OwnerName,PlanJson,StartsAt FROM dbo.MajorEvents ORDER BY UpdatedAt DESC'); truncated ||= rows.length===2000;
  for(const r of rows) if(canReadEvent(s.roles,r.Domain,r.Audience)) items.push({id:`event:${r.EventId}`,source:'event',sourceId:String(r.EventId),title:`${r.Title} — document pack`,kind:'event_pack',category:'Event / disaster pack',buildingIds:JSON.parse(r.PlanJson).buildingIds,tenantId:null,tenantName:null,issuedOn:iso(r.StartsAt),expiresOn:null,reviewDue:null,dateBasis:'Event start',ownerName:r.OwnerName,href:`/events/${r.EventClass==='project'?'projects':r.EventClass}?eventId=${r.EventId}`,canEdit:false,status:'live_pack'});
 }
 const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Darwin',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 return {status:200,jsonBody:{items:items.map(item=>({...item,dateStatus:documentDateStatus(item.expiresOn,item.reviewDue,today)})),truncated,today}};
 }); }
export async function uploadRegisterDocument(req: HttpRequest,ctx: InvocationContext): Promise<HttpResponseInit> { return withDocumentRegister(req,ctx,true,async (request,s) => {
 let form: FormData; try {form=await request.formData();}catch{return badRequest('Upload a file and metadata');}
 let input: RegisteredDocumentInput;try{input=parseDocumentInput(JSON.parse(String(form.get('metadata') ?? '{}')));}catch(e){return badRequest((e as Error).message);}
 const file=form.get('file') as File | null;
 if(!file || typeof file.arrayBuffer!=='function') return badRequest('File required');
 if(!['application/pdf','image/jpeg','image/png','image/webp'].includes(file.type)) return {status:415,jsonBody:{error:'Use PDF, JPEG, PNG or WebP'}};
 if(file.size<1 || file.size>10*1024*1024) return {status:413,jsonBody:{error:'Use a file up to 10 MB'}};
 const invalid=await validateScope(s,input); if(invalid) return badRequest(invalid);
 const bytes=Buffer.from(await file.arrayBuffer());
 const matches=file.type==='application/pdf'?bytes.subarray(0,5).toString()==='%PDF-':file.type==='image/jpeg'?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:file.type==='image/png'?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP';
 if(!matches) return badRequest('File contents do not match the selected type');
 const fileName=file.name.replace(/[\x00-\x1f\x7f/\\]/g,'_').slice(0,200)||'document';
 let blob: string|undefined; let committed=false;
 try {
  const uploaded=await uploadBlob(bytes,fileName,file.type,'documentation');blob=uploaded.blobName;
  const result=await inTransaction(s.connection,async()=>{
   const invalid=await validateScope(s,input);if(invalid)return txFail(badRequest(invalid));
   const rows=await executeQuery(s.connection,`INSERT dbo.RegisterDocuments (Title,Kind,ServiceCategory,BuildingId,TenantId,IssuedOn,ExpiresOn,ReviewDue,OwnerName,Notes,FileName,BlobName,ContentType,SizeBytes,CreatedBy,CreatedByOid) OUTPUT INSERTED.DocumentId VALUES (@Title,@Kind,@Category,@Building,@Tenant,@Issue,@Expiry,@Review,@Owner,@Notes,@File,@Blob,@Type,@Size,@Name,@Oid)`,[...params(input),str('File',fileName),str('Blob',uploaded.blobName),str('Type',file.type),int('Size',bytes.length),str('Name',s.caller.name),str('Oid',s.caller.oid)]);
   const id=Number(rows[0].DocumentId);await audit(s,id,'created',input);return txOk({documentId:id});
  });committed=result.ok;return result.ok?{status:201,jsonBody:result.value}:result.response;
 }finally{if(blob&&!committed)await deleteBlob(blob).catch(()=>undefined);}
 }); }
export async function updateRegisterDocument(req: HttpRequest,ctx: InvocationContext): Promise<HttpResponseInit> { return withDocumentRegister(req,ctx,true,async(request,s)=>{
 const body=await readJsonBody(request); const id=idOf(String(body?.documentId ?? ''));
 if(!id||!Number.isInteger(body?.revision))return badRequest('Document ID and revision required');
 let input: RegisteredDocumentInput;try{input=parseDocumentInput(body!);}catch(e){return badRequest((e as Error).message);}
 const result=await inTransaction(s.connection,async()=>{
  const row=await rowFor(s,id,true);if(!row||!readable(s,row))return txFail(notFound('Document not found'));
  if(!canEdit(s,row))return txFail(forbiddenResponse('Only the uploader or a manager may edit document metadata'));
  if(row.Revision!==body!.revision)return txFail(conflict('Document changed; refresh before editing'));
  // Ownership/scope is fixed on upload so a metadata edit cannot expose a private tenancy file.
  if(row.BuildingId!==input.buildingId||row.TenantId!==input.tenantId)return txFail(badRequest('Building and tenancy scope cannot change in a metadata edit'));
  await executeQuery(s.connection,'UPDATE dbo.RegisterDocuments SET Title=@Title,Kind=@Kind,ServiceCategory=@Category,IssuedOn=@Issue,ExpiresOn=@Expiry,ReviewDue=@Review,OwnerName=@Owner,Notes=@Notes,Revision=Revision+1,UpdatedAt=SYSUTCDATETIME() WHERE DocumentId=@Id',[int('Id',id),...params(input)]);
  await audit(s,id,'metadata_changed',{before:{title:row.Title,kind:row.Kind,category:row.ServiceCategory,issuedOn:iso(row.IssuedOn),expiresOn:iso(row.ExpiresOn),reviewDue:iso(row.ReviewDue),ownerName:row.OwnerName,notes:row.Notes},after:input});return txOk({saved:true});
 });return result.ok?{status:200,jsonBody:result.value}:result.response;
 }); }
export async function downloadRegisterDocument(req: HttpRequest,ctx: InvocationContext): Promise<HttpResponseInit> {return withDocumentRegister(req,ctx,false,async(request,s)=>{
 const id=idOf(request.query.get('documentId'));const source=request.query.get('source');if(!id)return badRequest('Document ID required');let row: SqlRow|undefined;
 if(source==='register'){row=await rowFor(s,id);if(!row||!readable(s,row))return notFound('Document not found');assertBlobName(row.BlobName,REGISTER_DOCUMENT_SHAPE);}
 else if(source==='tenancy'){
  if(!canTenancy(s))return forbiddenResponse('Tenancy access required'); const tenant=idOf(request.query.get('tenantId'));if(!tenant)return badRequest('Tenancy required');
  row=(await executeQuery(s.connection,'SELECT a.BlobName,a.OriginalName AS FileName FROM dbo.TenancyAttachments ta JOIN dbo.Attachments a ON a.Id=ta.AttachmentID JOIN dbo.Tenants t ON t.TenantId=ta.TenantId WHERE ta.TenantId=@Tenant AND a.Id=@Id AND a.ArchivedAt IS NULL AND t.ArchivedAt IS NULL AND (t.IsTest=0 OR @ShowTest=1)',[int('Id',id),int('Tenant',tenant),{name:'ShowTest',type:TYPES.Bit,value:s.showTest}]))[0];if(!row)return notFound('Document not found');assertBlobName(row.BlobName,WR_ATTACHMENTS_SHAPES);
 }else return badRequest('Unknown document source');
 return {status:200,body:await downloadBlob(row.BlobName),headers:{'Content-Type':'application/octet-stream','Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(row.FileName)}`,'X-Content-Type-Options':'nosniff'}};
 });}
app.http("getDocumentRegister",{authLevel:'anonymous',handler:getDocumentRegister,methods:['GET']});
app.http("uploadRegisterDocument",{authLevel:'anonymous',handler:uploadRegisterDocument,methods:['POST']});
app.http("updateRegisterDocument",{authLevel:'anonymous',handler:updateRegisterDocument,methods:['POST']});
app.http("downloadRegisterDocument",{authLevel:'anonymous',handler:downloadRegisterDocument,methods:['GET']});
