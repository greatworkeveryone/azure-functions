import {app,type HttpRequest,type HttpResponseInit,type InvocationContext} from "@azure/functions";
import {closeConnection,createRequestConnection} from "../db";
import {performanceAccess,performanceParams} from "../performance/http";
import {loadPerformance,PerformanceScopeTooLarge} from "../performance/store";
export async function getFloorplanPerformance(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit>{
 const auth=await performanceAccess(request);if("response"in auth)return auth.response;
 const params=performanceParams(request.query);if("error"in params)return {status:400,jsonBody:{error:params.error}};
 const list=request.query.get("list")??"backlog",page=Number(request.query.get("page")??0),stage=request.query.get("stage");
 const dimension=request.query.get("dimension"),key=request.query.get("key");
 if(!["backlog","stalled","overdue","received","completed","reopened"].includes(list)||!Number.isSafeInteger(page)||page<0||page>100000||dimension!==null&&!["building","category","priority","kind","reason","team"].includes(dimension)||key!==null&&key.length>200||(dimension===null)!==(key===null)||stage!==null&&!["Intake","Quotes","Approval","In progress","Tenant","Stalled","Unclassified"].includes(stage))return {status:400,jsonBody:{error:"Invalid evidence filter or page."}};
 let connection;
 try{connection=await createRequestConnection(auth.token);const analysis=await loadPerformance(connection,params.period,params.buildingId);
 const matching=analysis.records.filter(row=>{
  if(list==="backlog"&&row.status==="Done"||list==="stalled"&&!(row.status!=="Done"&&(row.stalled||row.status==="Tenant"))||list==="overdue"&&!row.overdue||list==="received"&&!row.received||list==="completed"&&!row.completed||list==="reopened"&&!row.reopened)return false;
  if(stage!==null&&row.stage!==stage)return false;
  if(dimension!==null&&key!==null){const value=dimension==="building"?String(row.buildingId):dimension==="team"?(row.awaitingRole??"Unrecorded"):dimension==="reason"?(row.status==="Tenant"?"Waiting on tenant":row.stalled?row.reason??"Unrecorded":"Not stalled"):dimension==="category"?(row.category||"Unrecorded"):dimension==="kind"?(row.kind||"Unrecorded"):(row.priority||"Unrecorded");if(value!==key)return false;}
  return true;
 }).sort((a,b)=>(b.ageDays??-1)-(a.ageDays??-1)||a.id-b.id);
 const {records:_,...report}=analysis;return {status:200,headers:{"Cache-Control":"no-store"},jsonBody:{...report,evidence:matching.slice(page*50,page*50+50),evidenceTotal:matching.length,evidencePage:page}};}
 catch(error){if(error instanceof PerformanceScopeTooLarge)return {status:413,jsonBody:{error:error.message}};context.error("Floorplan performance failed",error);return {status:500,jsonBody:{error:"Could not load Floorplan performance. Try again."}};}
 finally{if(connection)closeConnection(connection);}
}
app.http("getFloorplanPerformance",{methods:["GET"],authLevel:"anonymous",handler:getFloorplanPerformance});
