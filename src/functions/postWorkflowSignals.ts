import {app,type HttpRequest,type HttpResponseInit,type InvocationContext} from "@azure/functions";
import {ACTION_ROLES} from "../action-roles";
import {extractToken,oidFromToken,requireRole,rolesForRequest} from "../auth";
import {closeConnection,createRequestConnection} from "../db";
import {usageTrackingOn} from "../usage/config";
import {readCappedBody} from "../usage/body";
import {usageFlagEnabledFor} from "../usage/flag";
import {userIdForOid} from "../usage/ingest";
import {allowUsageBatch} from "../usage/rateLimit";
import {parseSignals,storeSignals} from "../performance/signals";
export async function postWorkflowSignals(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit>{
 const token=extractToken(request);if(!token)return {status:401};const denied=await requireRole(request,ACTION_ROLES.recordWorkflowSignals.gate);if(denied)return denied;
 if(!usageTrackingOn())return {status:204};const oid=oidFromToken(token);if(!oid)return {status:204};
 const read=await readCappedBody(request,12000);if("tooLarge"in read)return {status:413};let body:unknown;try{body=JSON.parse(read.text);}catch{return {status:400,jsonBody:{error:"Invalid signal batch."}};}
 const signals=parseSignals(body);if(!signals)return {status:400,jsonBody:{error:"Only allowlisted, content-free request outcomes are accepted."}};
 let connection;
 try{connection=await createRequestConnection(token);const userId=await userIdForOid(connection,oid);if(userId===null||!await usageFlagEnabledFor(connection,await rolesForRequest(request)))return {status:204};if(!allowUsageBatch(userId))return {status:429,headers:{"Retry-After":"60"}};await storeSignals(connection,userId,signals);return {status:204};}
 catch(error){context.error("Workflow signal write failed",error);return {status:500,jsonBody:{error:"Could not record request outcomes."}};}finally{if(connection)closeConnection(connection);}
}
app.http("postWorkflowSignals",{methods:["POST"],authLevel:"anonymous",handler:postWorkflowSignals});
