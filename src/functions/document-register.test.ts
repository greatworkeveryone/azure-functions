import {HttpRequest,type InvocationContext} from '@azure/functions';
import {AppRole} from '../auth';
import {commitTransaction,executeQuery} from '../db';
import {deleteBlob,uploadBlob} from '../blob-storage';
import {downloadRegisterDocument,getDocumentRegister,updateRegisterDocument,uploadRegisterDocument} from './document-register';
jest.mock('@azure/functions',()=>({...jest.requireActual('@azure/functions'),app:{http:jest.fn()}}));
let roles:string[]=['facilities'];
jest.mock('../auth',()=>({...jest.requireActual('../auth'),extractToken:()=> 'token',requireRole:async(_r:unknown,allowed:string[])=>jest.requireActual('../auth').rolesPassGate(roles,allowed)?null:{status:403},rolesForRequest:async()=>roles,verifiedIdentityFromRequest:async()=>({name:'Verified Staff',oid:'verified-oid'})}));
jest.mock('../db',()=>({createRequestConnection:jest.fn(async()=>({})),closeConnection:jest.fn(),executeQuery:jest.fn(),beginTransaction:jest.fn().mockResolvedValue(undefined),commitTransaction:jest.fn().mockResolvedValue(undefined),rollbackTransaction:jest.fn().mockResolvedValue(undefined)}));
jest.mock('../test-data',()=>({showTestData:async()=>false}));
jest.mock('../rateLimit',()=>({checkRateLimit:()=>({allowed:true})}));
jest.mock('../blob-storage',()=>({downloadBlob:jest.fn(),uploadBlob:jest.fn(),deleteBlob:jest.fn()}));
jest.mock('./getProcedures',()=>({getProcedures:jest.fn(async()=>({status:200,jsonBody:{procedures:[{slug:'public-sop',category:'General',versions:[{title:'Public SOP',status:'draft'}]}]}}))}));
const query=jest.mocked(executeQuery),context={error:jest.fn(),warn:jest.fn()} as unknown as InvocationContext;
const req=(body:unknown={},query='')=>new HttpRequest({method:'POST',url:`http://localhost/api/docs${query}`,headers:{'Content-Type':'application/json'},body:{string:JSON.stringify(body)}});
beforeEach(()=>{jest.clearAllMocks();roles=[AppRole.FACILITIES];query.mockResolvedValue([]);});
it('does not query tenancy attachments for facilities staff',async()=>{const r=await getDocumentRegister(req(),context);expect(r.status).toBe(200);expect(query.mock.calls.some(([,sql])=>sql.includes('dbo.TenancyAttachments'))).toBe(false);});
it('gives a user-only role the source-controlled procedures and no operational documents',async()=>{roles=[AppRole.USER];const r=await getDocumentRegister(req(),context);expect((r.jsonBody as {items:unknown[]}).items).toHaveLength(1);expect(query).not.toHaveBeenCalled();});
it('does not leak private event-pack metadata through the unified register',async()=>{query.mockImplementation(async(_c,sql)=>sql.includes('FROM dbo.MajorEvents')?[{EventId:1,Title:'Private IT incident',Domain:'financial',Audience:'managers',PlanJson:'{"buildingIds":[-7]}'}]:[]);const r=await getDocumentRegister(req(),context);expect(JSON.stringify(r.jsonBody)).not.toContain('Private IT incident');});
it('checks tenancy access again at download time',async()=>{expect((await downloadRegisterDocument(req({},'?source=tenancy&documentId=7&tenantId=2'),context)).status).toBe(403);expect(query).not.toHaveBeenCalled();});
it('does not expose a tenancy-linked registered certificate to facilities staff',async()=>{query.mockResolvedValue([{DocumentId:1,TenantId:2,BuildingId:-7}]);expect((await downloadRegisterDocument(req({},'?source=register&documentId=1'),context)).status).toBe(404);});
it('rejects stale metadata edits before changing the file or record',async()=>{
 roles=[AppRole.DIRECTOR];query.mockResolvedValue([{DocumentId:1,TenantId:null,BuildingId:-7,Revision:2,CreatedByOid:'other'}]);
 const result=await updateRegisterDocument(req({documentId:1,revision:1,title:'Certificate',kind:'certificate',category:'General',buildingId:-7,tenantId:null,ownerName:'Facilities'}),context);
 expect(result.status).toBe(409);expect(query.mock.calls.some(([,sql])=>sql.startsWith('UPDATE'))).toBe(false);
});
it('does not let a staff member edit someone else’s certificate metadata',async()=>{query.mockResolvedValue([{DocumentId:1,TenantId:null,BuildingId:-7,Revision:1,CreatedByOid:'other'}]);expect((await updateRegisterDocument(req({documentId:1,revision:1,title:'Certificate',kind:'certificate',category:'General',buildingId:-7,ownerName:'Facilities'}),context)).status).toBe(403);});

it('hides registered evidence when its linked tenancy is archived',async()=>{roles=[AppRole.DIRECTOR];query.mockResolvedValue([{DocumentId:1,TenantId:2,BuildingId:-7,TenantArchivedAt:new Date()}]);expect((await downloadRegisterDocument(req({},'?source=register&documentId=1'),context)).status).toBe(404);});

const BLOB='documentation/11111111-1111-4111-8111-111111111111.pdf';
const upload=()=>({formData:async()=>new Map<string,unknown>([['metadata',JSON.stringify({title:'Certificate',kind:'certificate',category:'General',buildingId:null,tenantId:null,ownerName:'Facilities'})],['file',{type:'application/pdf',name:'cert.pdf',size:9,arrayBuffer:async()=>Buffer.from('%PDF-test')}]])}) as unknown as HttpRequest;
const refCheck=(sql:string)=>sql.includes('FROM dbo.RegisterDocuments WHERE BlobName=@Blob');
describe('upload cleanup only deletes a file no row references',()=>{
 beforeEach(()=>{roles=[AppRole.DIRECTOR];jest.mocked(uploadBlob).mockResolvedValue({blobName:BLOB} as never);jest.mocked(deleteBlob).mockResolvedValue(undefined);});
 it('deletes the new file when the insert failed and no row references it',async()=>{
  query.mockImplementation(async(_c,sql)=>{if(sql.startsWith('INSERT dbo.RegisterDocuments '))throw new Error('insert failed');return [];});
  expect((await uploadRegisterDocument(upload(),context)).status).toBe(500);
  expect(deleteBlob).toHaveBeenCalledWith(BLOB);
 });
 it('keeps the file when COMMIT succeeded but its acknowledgement was lost',async()=>{
  query.mockImplementation(async(_c,sql)=>sql.startsWith('INSERT dbo.RegisterDocuments ')?[{DocumentId:5}]:refCheck(sql)?[{DocumentId:5}]:[]);
  jest.mocked(commitTransaction).mockRejectedValueOnce(new Error('connection reset'));
  expect((await uploadRegisterDocument(upload(),context)).status).toBe(500);
  expect(deleteBlob).not.toHaveBeenCalled();expect(context.warn).toHaveBeenCalledWith(expect.stringContaining(BLOB));
 });
 it('keeps the file when the reference check itself fails',async()=>{
  query.mockImplementation(async(_c,sql)=>{if(sql.startsWith('INSERT dbo.RegisterDocuments '))throw new Error('insert failed');if(refCheck(sql))throw new Error('connection closed');return [];});
  expect((await uploadRegisterDocument(upload(),context)).status).toBe(500);
  expect(deleteBlob).not.toHaveBeenCalled();expect(context.warn).toHaveBeenCalledWith(expect.stringContaining('reference check failed'));
 });
});
