import {app,type HttpRequest,type HttpResponseInit,type InvocationContext} from "@azure/functions";
import {closeConnection,createRequestConnection} from "../db";
import {performanceAccess,performanceParams} from "../performance/http";
import {loadFriction} from "../performance/signals";
import {usageTrackingOn} from "../usage/config";
export async function getWorkflowFriction(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit>{
 const auth=await performanceAccess(request);if("response"in auth)return auth.response;const params=performanceParams(request.query);if("error"in params)return {status:400,jsonBody:{error:params.error}};
 let connection;try{connection=await createRequestConnection(auth.token);return {status:200,headers:{"Cache-Control":"no-store"},jsonBody:{...await loadFriction(connection,params.period),trackingEnabled:usageTrackingOn()}};}
 catch(error){context.error("Workflow friction read failed",error);return {status:500,jsonBody:{error:"Could not load recorded request outcomes."}};}finally{if(connection)closeConnection(connection);}
}
app.http("getWorkflowFriction",{methods:["GET"],authLevel:"anonymous",handler:getWorkflowFriction});
