import {app,type HttpRequest,type HttpResponseInit,type InvocationContext} from "@azure/functions";
import {TYPES} from "tedious";
import {closeConnection,createRequestConnection,executeQuery} from "../db";
import {performanceAccess} from "../performance/http";
import {improvementRows} from "../performance/improvements";
export async function getPerformanceImprovements(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit>{
 const auth=await performanceAccess(request);if("response"in auth)return auth.response;
 const raw=request.query.get("id");if(raw!==null&&(!/^\d+$/.test(raw)||Number(raw)<1||!Number.isSafeInteger(Number(raw))||Number(raw)>2147483647))return {status:400,jsonBody:{error:"Invalid improvement id."}};
 let connection;
 try{connection=await createRequestConnection(auth.token);const improvements=await improvementRows(connection);const history=raw===null?[]:await executeQuery(connection,"SELECT Revision,BeforeJson,AfterJson,ActorName,RecordedAt FROM dbo.PerformanceImprovementHistory WHERE ImprovementId=@Id ORDER BY Revision",[{name:"Id",type:TYPES.Int,value:Number(raw)}]);return {status:200,headers:{"Cache-Control":"no-store"},jsonBody:{improvements,history:history.map(row=>({revision:row.Revision,before:row.BeforeJson?JSON.parse(String(row.BeforeJson)):null,after:JSON.parse(String(row.AfterJson)),actor:row.ActorName,at:new Date(String(row.RecordedAt)).toISOString()}))}};}
 catch(error){context.error("Improvements read failed",error);return {status:500,jsonBody:{error:"Could not load improvements."}};}finally{if(connection)closeConnection(connection);}
}
app.http("getPerformanceImprovements",{methods:["GET"],authLevel:"anonymous",handler:getPerformanceImprovements});
