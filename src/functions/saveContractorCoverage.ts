import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { TYPES, type Connection } from 'tedious';
import { authorizeWrite, badRequest, conflict, inTransaction, notFound, readJsonBody, txFail, txOk } from '../assetRegisterSupport';
import { errorResponse } from '../auth';
import { closeConnection, createRequestConnection, executeQuery, type SqlParam } from '../db';
import { MANAGE_SERVICE_SCHEDULES_ROLES } from '../facilitiesRoles';
import { parseContractorCoverage } from '../contractorCoverage';
export async function saveContractorCoverage(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
 const auth=await authorizeWrite(request,MANAGE_SERVICE_SCHEDULES_ROLES);if(!auth.ok)return auth.response;
 const body=await readJsonBody(request);if(!body)return badRequest('JSON object required');
 let input;try{input=parseContractorCoverage(body);}catch(error){return badRequest((error as Error).message);}
 let connection: Connection|undefined;
 try{
  connection=await createRequestConnection(auth.token);const conn=connection;
  const result=await inTransaction(conn,async()=>{
   const params:SqlParam[]=[{name:'Contractor',type:TYPES.Int,value:input.contractorId}];
   const contractor=(await executeQuery(conn,'SELECT ContractorID,Active,Suspended FROM dbo.Contractors WITH (UPDLOCK,HOLDLOCK) WHERE ContractorID=@Contractor',params))[0];
   if(!contractor)return txFail(notFound('Contractor unavailable'));
   const before=(await executeQuery(conn,'SELECT CoverageJson,Revision FROM dbo.ContractorCoverage WITH (UPDLOCK,HOLDLOCK) WHERE ContractorId=@Contractor',params))[0];
   if((before?.Revision??0)!==input.revision)return txFail(conflict('Availability changed. Reload before saving.'));
   const revision=input.revision+1;params.push({name:'Plan',type:TYPES.NVarChar,value:JSON.stringify({regions:input.regions,trades:input.trades})},{name:'Revision',type:TYPES.Int,value:revision},{name:'Actor',type:TYPES.NVarChar,value:auth.caller.name},{name:'Oid',type:TYPES.NVarChar,value:auth.caller.oid},{name:'Before',type:TYPES.NVarChar,value:before?.CoverageJson??null});
   await executeQuery(conn,before?'UPDATE dbo.ContractorCoverage SET CoverageJson=@Plan,Revision=@Revision,UpdatedAt=SYSUTCDATETIME(),UpdatedBy=@Actor,UpdatedByOid=@Oid WHERE ContractorId=@Contractor':'INSERT dbo.ContractorCoverage(ContractorId,CoverageJson,Revision,UpdatedBy,UpdatedByOid) VALUES (@Contractor,@Plan,@Revision,@Actor,@Oid)',params);
   await executeQuery(conn,'INSERT dbo.ContractorCoverageAudit(ContractorId,Revision,BeforeJson,AfterJson,ActorName,ActorOid) VALUES (@Contractor,@Revision,@Before,@Plan,@Actor,@Oid)',params);
   return txOk({saved:true,revision});
  });return result.ok?{status:200,jsonBody:result.value}:result.response;
 }catch(error){context.error('Contractor availability save failed',error);return errorResponse('Could not save contractor availability',error);}finally{if(connection)closeConnection(connection);}
}
app.http('saveContractorCoverage',{authLevel:'anonymous',handler:saveContractorCoverage,methods:['POST']});
