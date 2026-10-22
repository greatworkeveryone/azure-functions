import { app,HttpRequest,HttpResponseInit,InvocationContext } from '@azure/functions';
import { authorize } from '../assetRegisterSupport';
import { REPORTING_ROLES } from '../leavePolicy';
import { loadPeople } from '../peopleWorkflow';
import { closeConnection,createRequestConnection } from '../db';
export async function getStaffReporting(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit>{
 const auth=await authorize(request,REPORTING_ROLES);if(!auth.ok)return auth.response;
 let connection;try{connection=await createRequestConnection(auth.token);const data=await loadPeople(connection);return {status:200,headers:{'Cache-Control':'no-store'},jsonBody:{...data,staff:data.staff.map(({id,name,role})=>({id,name,role}))}};}catch(error){context.error('Reporting read failed',error);return {status:500,jsonBody:{error:'Could not load the reporting structure'}};}finally{if(connection)closeConnection(connection);}
}
app.http('getStaffReporting',{methods:['GET'],authLevel:'anonymous',handler:getStaffReporting});
