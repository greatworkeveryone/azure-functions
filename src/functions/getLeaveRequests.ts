import { app,HttpRequest,HttpResponseInit,InvocationContext } from '@azure/functions';
import { TYPES } from 'tedious';
import { authorizeWrite } from '../assetRegisterSupport';
import { LEAVE_READ_ROLES,leaveApprovers } from '../leavePolicy';
import { loadPeople } from '../peopleWorkflow';
import { closeConnection,createRequestConnection,executeQuery } from '../db';
export async function getLeaveRequests(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit>{
 const auth=await authorizeWrite(request,LEAVE_READ_ROLES);if(!auth.ok)return auth.response;
 let connection;try{connection=await createRequestConnection(auth.token);const data=await loadPeople(connection),self=data.staff.find(person=>person.oid===auth.caller.oid);
  if(!self)return {status:403,jsonBody:{error:'An active staff record is required'}};
  const rows=await executeQuery(connection,`SELECT TOP(501) RequestId,UserId,Kind,CONVERT(VARCHAR(10),StartDate,23) AS StartDate,CONVERT(VARCHAR(10),EndDate,23) AS EndDate,Hours,Note,Status,Revision,CreatedAt,DecidedBy,DecisionNote FROM dbo.LeaveRequests WHERE UserId=@User OR Status='pending' ORDER BY RequestId DESC`,[{name:'User',type:TYPES.Int,value:self.id}]);
  const visible=rows.filter(row=>row.UserId===self.id||data.staff.some(person=>person.id===row.UserId&&leaveApprovers(person,data.staff,data.links).some(manager=>manager.id===self.id)));
  return {status:200,headers:{'Cache-Control':'no-store'},jsonBody:{selfId:self.id,approvers:leaveApprovers(self,data.staff,data.links).map(({id,name})=>({id,name})),truncated:rows.length>500,requests:visible.slice(0,500).map(row=>({id:row.RequestId,userId:row.UserId,name:data.staff.find(person=>person.id===row.UserId)?.name??'Former staff member',kind:row.Kind,startDate:row.StartDate,endDate:row.EndDate,hours:Number(row.Hours),note:row.Note,status:row.Status,revision:row.Revision,createdAt:row.CreatedAt,decidedBy:row.DecidedBy,decisionNote:row.DecisionNote,canDecide:row.UserId!==self.id&&row.Status==='pending'}))}};
 }catch(error){context.error('Leave read failed',error);return {status:500,jsonBody:{error:'Could not load leave requests'}};}finally{if(connection)closeConnection(connection);}
}
app.http('getLeaveRequests',{methods:['GET'],authLevel:'anonymous',handler:getLeaveRequests});
