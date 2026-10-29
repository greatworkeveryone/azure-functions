import {app,type HttpRequest,type HttpResponseInit,type InvocationContext} from "@azure/functions";
import {TYPES} from "tedious";
import {closeConnection,createRequestConnection,executeQuery} from "../db";
import {performanceAccess,performanceParams} from "../performance/http";
export async function getFloorplanAdoption(request:HttpRequest,context:InvocationContext):Promise<HttpResponseInit>{
 const auth=await performanceAccess(request);if("response"in auth)return auth.response;const params=performanceParams(request.query);if("error"in params)return {status:400,jsonBody:{error:params.error}};
 const list=request.query.get("list")??"started",page=Number(request.query.get("page")??0);if(!["started","completed"].includes(list)||!Number.isSafeInteger(page)||page<0||page>100000)return {status:400,jsonBody:{error:"Invalid inspection evidence page."}};
 const whereSql=list==="started"?"i.CreatedAt>=@From AND i.CreatedAt<@To":"i.Status='complete' AND i.CompletedAt>=@From AND i.CompletedAt<@To";
 const sqlParams=[{name:"From",type:TYPES.DateTime2,value:params.period.fromUtc},{name:"To",type:TYPES.DateTime2,value:params.period.toUtc},{name:"Building",type:TYPES.Int,value:params.buildingId},{name:"Offset",type:TYPES.Int,value:page*50}];
 let connection;try{connection=await createRequestConnection(auth.token);
  const rows=await executeQuery(connection,`SELECT COUNT(CASE WHEN CreatedAt>=@From AND CreatedAt<@To THEN 1 END) AS Started,COUNT(CASE WHEN Status='complete' AND CompletedAt>=@From AND CompletedAt<@To THEN 1 END) AS Completed,COUNT(CASE WHEN Status='draft' AND CreatedAt>=@From AND CreatedAt<@To THEN 1 END) AS Drafts FROM dbo.Inspections WHERE IsTest=0 AND Status<>'merged' AND (@Building IS NULL OR BuildingId=@Building)`,sqlParams);
  const jobs=await executeQuery(connection,"SELECT COUNT(*) AS Jobs FROM dbo.Jobs WHERE IsTest=0 AND IsArchived=0 AND SourceInspectionId IS NOT NULL AND CreatedAt>=@From AND CreatedAt<@To AND (@Building IS NULL OR BuildingID=@Building)",sqlParams);
  const evidence=await executeQuery(connection,`SELECT i.Id,i.Title,b.BuildingName,i.Status,i.CreatedAt,i.CompletedAt FROM dbo.Inspections i LEFT JOIN dbo.Buildings b ON b.BuildingID=i.BuildingId WHERE i.IsTest=0 AND i.Status<>'merged' AND (@Building IS NULL OR i.BuildingId=@Building) AND ${whereSql} ORDER BY i.CreatedAt DESC,i.Id DESC OFFSET @Offset ROWS FETCH NEXT 50 ROWS ONLY`,sqlParams);
  return {status:200,headers:{"Cache-Control":"no-store"},jsonBody:{generatedAt:new Date().toISOString(),period:{from:params.period.from,to:params.period.to,days:params.period.days},started:Number(rows[0]?.Started??0),completed:Number(rows[0]?.Completed??0),drafts:Number(rows[0]?.Drafts??0),jobsFromInspections:Number(jobs[0]?.Jobs??0),list,page,evidence:evidence.map(row=>({id:Number(row.Id),title:String(row.Title??`Inspection ${row.Id}`),building:String(row.BuildingName??"Building unrecorded"),status:String(row.Status)}))}};
 }catch(error){context.error("Operational adoption read failed",error);return {status:500,jsonBody:{error:"Could not load operational adoption records."}};}finally{if(connection)closeConnection(connection);}
}
app.http("getFloorplanAdoption",{methods:["GET"],authLevel:"anonymous",handler:getFloorplanAdoption});
