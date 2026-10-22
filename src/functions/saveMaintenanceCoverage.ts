import { app, HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { TYPES, type Connection } from 'tedious';
import { authorizeWrite, badRequest, conflict, inTransaction, notFound, readJsonBody, txFail, txOk } from '../assetRegisterSupport';
import { errorResponse } from '../auth';
import { closeConnection, createRequestConnection, executeQuery, type SqlParam } from '../db';
import { MANAGE_SERVICE_SCHEDULES_ROLES } from '../facilitiesRoles';
import { parseCoverageInput } from '../maintenanceCoverage';
export async function saveMaintenanceCoverage(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
 const auth=await authorizeWrite(request,MANAGE_SERVICE_SCHEDULES_ROLES);if(!auth.ok)return auth.response;
 const body=await readJsonBody(request);if(!body)return badRequest('JSON object required');
 let input;try{input=parseCoverageInput(body);}catch(error){return badRequest((error as Error).message);}
 let connection: Connection|undefined;
 try{
  connection=await createRequestConnection(auth.token);const conn=connection;
  const result=await inTransaction(conn,async()=>{
   const params:SqlParam[]=[{name:'Building',type:TYPES.Int,value:input.buildingId}];
   if(!(await executeQuery(conn,'SELECT BuildingID FROM dbo.Buildings WITH (UPDLOCK,HOLDLOCK) WHERE BuildingID=@Building AND Active=1',params)).length)return txFail(notFound('Building unavailable'));
   const before=(await executeQuery(conn,'SELECT PlanJson,Revision FROM dbo.MaintenanceCoverage WITH (UPDLOCK,HOLDLOCK) WHERE BuildingId=@Building',params))[0];
   if((before?.Revision??0)!==input.revision)return txFail(conflict('Coverage changed. Reload before saving.'));
   const ids=[...new Set(input.trades.flatMap(trade=>trade.contractorIds))];
   if(ids.length){const contractors=await executeQuery(conn,'SELECT ContractorID,Active,Suspended FROM dbo.Contractors WHERE ContractorID IN (SELECT CAST(value AS INT) FROM OPENJSON(@Ids))',[{name:'Ids',type:TYPES.NVarChar,value:JSON.stringify(ids)}]);
    const previousTrades: {trade:string;contractorIds:number[]}[]=before?JSON.parse(before.PlanJson):[];
    if(input.trades.some(trade=>trade.contractorIds.some(id=>!contractors.some(row=>row.ContractorID===id&&((row.Active&&!row.Suspended)||previousTrades.some(previous=>previous.trade.toLocaleLowerCase('en-AU')===trade.trade.toLocaleLowerCase('en-AU')&&previous.contractorIds.includes(id)))))))return txFail(badRequest('New assignments require an active, unsuspended contractor'));
   }
   const revision=input.revision+1;params.push({name:'Plan',type:TYPES.NVarChar,value:JSON.stringify(input.trades)},{name:'Revision',type:TYPES.Int,value:revision},{name:'Actor',type:TYPES.NVarChar,value:auth.caller.name},{name:'Oid',type:TYPES.NVarChar,value:auth.caller.oid},{name:'Before',type:TYPES.NVarChar,value:before?.PlanJson??null});
   await executeQuery(conn,before?'UPDATE dbo.MaintenanceCoverage SET PlanJson=@Plan,Revision=@Revision,UpdatedAt=SYSUTCDATETIME(),UpdatedBy=@Actor,UpdatedByOid=@Oid WHERE BuildingId=@Building':'INSERT dbo.MaintenanceCoverage(BuildingId,PlanJson,Revision,UpdatedBy,UpdatedByOid) VALUES (@Building,@Plan,@Revision,@Actor,@Oid)',params);
   await executeQuery(conn,'INSERT dbo.MaintenanceCoverageAudit(BuildingId,Revision,BeforeJson,AfterJson,ActorName,ActorOid) VALUES (@Building,@Revision,@Before,@Plan,@Actor,@Oid)',params);
   return txOk({saved:true,revision});
  });return result.ok?{status:200,jsonBody:result.value}:result.response;
 }catch(error){context.error('Maintenance coverage save failed',error);return errorResponse('Could not save contractor coverage',error);}finally{if(connection)closeConnection(connection);}
}
app.http('saveMaintenanceCoverage',{authLevel:'anonymous',handler:saveMaintenanceCoverage,methods:['POST']});
