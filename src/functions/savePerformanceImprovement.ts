import {app,type HttpRequest,type HttpResponseInit,type InvocationContext} from "@azure/functions";
import {TYPES} from "tedious";
import {verifiedIdentityFromRequest} from "../auth";
import {closeConnection,createRequestConnection,executeQuery} from "../db";
import {inTransaction,readJsonBody,txFail,txOk} from "../assetRegisterSupport";
import {performanceAccess} from "../performance/http";
import {activeImprovementOwner,improvementReport,improvementValue,validateImprovement} from "../performance/improvements";
import {PerformanceScopeTooLarge} from "../performance/store";
import type {ImprovementMetric} from "../performance/types";
export async function savePerformanceImprovement(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit>{
 const auth=await performanceAccess(request,true);if("response"in auth)return auth.response;
 const actor=await verifiedIdentityFromRequest(request);if(!actor)return {status:401};
 const body=await readJsonBody(request);if(!body)return {status:400,jsonBody:{error:"An improvement is required."}};
 const updating=body.id!==undefined;
 if(updating&&(!Number.isSafeInteger(body.id)||Number(body.id)<1||Number(body.id)>2147483647||!Number.isSafeInteger(body.revision)||Number(body.revision)<1||Number(body.revision)>=2147483647))return {status:400,jsonBody:{error:"A valid id and revision are required."}};
 if(!updating){const problem=validateImprovement(body);if(problem)return {status:400,jsonBody:{error:problem}};}
 else if(!["open","closed","archived"].includes(String(body.status))||typeof body.note!=="string"||!body.note.trim()||body.note.length>2000)return {status:400,jsonBody:{error:"Choose a status and add a review note under 2,000 characters."}};
 let connection;
 try{connection=await createRequestConnection(auth.token);const conn=connection;
  const result=await inTransaction(conn,async()=>{
   let before:Record<string,unknown>|null=null,revision=1,id=Number(body.id),next:Record<string,unknown>;
   if(updating){const rows=await executeQuery(conn,"SELECT DataJson,Revision,Status FROM dbo.PerformanceImprovements WITH(UPDLOCK,HOLDLOCK) WHERE ImprovementId=@Id",[{name:"Id",type:TYPES.Int,value:id}]);if(!rows.length)return txFail({status:404,jsonBody:{error:"Improvement not found."}});if(Number(rows[0].Revision)!==body.revision)return txFail({status:409,jsonBody:{error:"This improvement changed. Reload before saving; keep your review note."}});if(rows[0].Status==="archived")return txFail({status:409,jsonBody:{error:"Archived improvements are read-only."}});before={...JSON.parse(String(rows[0].DataJson)),status:rows[0].Status};revision=Number(body.revision)+1;next={...before,status:body.status,note:body.note};
   if(["title","ownerId","target","reviewOn"].some(key=>body[key]!==undefined&&body[key]!==before?.[key])){
    for(const key of ["title","ownerId","target","reviewOn"])if(body[key]!==undefined)next[key]=body[key];
    const problem=validateImprovement(next);if(problem)return txFail({status:400,jsonBody:{error:problem}});
    const ownerName=await activeImprovementOwner(conn,Number(next.ownerId));if(!ownerName)return txFail({status:400,jsonBody:{error:"Choose an active owner."}});next.ownerName=ownerName;
   }
   if(body.status==="closed"){
    const report=await improvementReport(conn,Number(next.days),next.buildingId as number|null);
    const value=improvementValue(report,next.metric as ImprovementMetric);
    next.reviewedAt=report.generatedAt;next.reviewedValue=value;next.reviewCoverage=report.coverage;next.outcome=value===null?"inconclusive":value<=Number(next.target)?"met":"not_met";
   }else if(body.status==="open"){delete next.reviewedValue;delete next.reviewedAt;delete next.outcome;delete next.reviewCoverage;} }
   else{const ownerName=await activeImprovementOwner(conn,Number(body.ownerId));if(!ownerName)return txFail({status:400,jsonBody:{error:"The owner must be an active staff member."}});const report=await improvementReport(conn,Number(body.days),body.buildingId as number|null);const metric=body.metric as ImprovementMetric,baseline=improvementValue(report,metric);if(baseline===null)return txFail({status:400,jsonBody:{error:"This metric has no reliable baseline yet. Choose another metric or collect more history."}});next={title:String(body.title).trim(),ownerId:body.ownerId,ownerName,metric,target:body.target,reviewOn:body.reviewOn,buildingId:body.buildingId,days:body.days,note:body.note??"",baseline,baselineAt:report.generatedAt,definitionVersion:report.version,baselineCoverage:report.coverage,status:"open"};}
   const params=[{name:"Data",type:TYPES.NVarChar,value:JSON.stringify(next)},{name:"Revision",type:TYPES.Int,value:revision},{name:"Status",type:TYPES.NVarChar,value:String(next.status)},{name:"Actor",type:TYPES.NVarChar,value:actor.name}];
   if(updating)await executeQuery(conn,"UPDATE dbo.PerformanceImprovements SET DataJson=@Data,Revision=@Revision,Status=@Status,UpdatedAt=SYSUTCDATETIME(),UpdatedBy=@Actor WHERE ImprovementId=@Id",[...params,{name:"Id",type:TYPES.Int,value:id}]);
   else{const rows=await executeQuery(conn,"INSERT dbo.PerformanceImprovements(DataJson,Revision,Status,CreatedBy,UpdatedBy) OUTPUT INSERTED.ImprovementId VALUES(@Data,@Revision,@Status,@Actor,@Actor)",params);id=Number(rows[0].ImprovementId);}
   await executeQuery(conn,"INSERT dbo.PerformanceImprovementHistory(ImprovementId,Revision,BeforeJson,AfterJson,ActorOid,ActorName) VALUES(@Id,@Revision,@Before,@After,@Oid,@Actor)",[{name:"Id",type:TYPES.Int,value:id},{name:"Revision",type:TYPES.Int,value:revision},{name:"Before",type:TYPES.NVarChar,value:before?JSON.stringify(before):null},{name:"After",type:TYPES.NVarChar,value:JSON.stringify(next)},{name:"Oid",type:TYPES.NVarChar,value:actor.oid},{name:"Actor",type:TYPES.NVarChar,value:actor.name}]);
   return txOk({id,revision});
  });return result.ok?{status:200,jsonBody:result.value}:result.response;
 }catch(error){if(error instanceof PerformanceScopeTooLarge)return {status:413,jsonBody:{error:error.message}};context.error("Improvement save failed",error);return {status:500,jsonBody:{error:"Could not save the improvement. Your draft has been kept."}};}finally{if(connection)closeConnection(connection);}
}
app.http("savePerformanceImprovement",{methods:["POST"],authLevel:"anonymous",handler:savePerformanceImprovement});
