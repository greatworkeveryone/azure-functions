import {TYPES,type Connection} from "tedious";
import {executeQuery} from "../db";
import {buildPerformance} from "./model";
import type {UsagePeriod} from "../usage/period";
import type {PerformanceEvent,PerformanceJob} from "./types";
const MAX_JOBS=20000,MAX_EVENTS=200000;
const REASONS=new Set(["Contractor not replying","Waiting on parts","Waiting on tenant","Weather","RP approval","Quote pending","Access required","Permits / council","Materials backorder","Other"]);
const iso=(value:unknown):string|null=>value===null||value===undefined?null:new Date(String(value)).toISOString();
export class PerformanceScopeTooLarge extends Error{}
export async function loadPerformance(connection:Connection,period:UsagePeriod,buildingId:number|null,now=new Date()){
 const rows=await executeQuery(connection,`SELECT TOP (20001) j.JobID,j.Title,j.BuildingID,b.BuildingName,j.Status,j.AwaitingRole,j.Kind,j.Category,j.Priority,j.CreatedAt,j.CompletionDate,j.StatusSince,j.StalledAt,j.ExpectedProgressUpdate,j.IsStalled,j.StalledReason
 FROM dbo.Jobs j LEFT JOIN dbo.Buildings b ON b.BuildingID=j.BuildingID
 WHERE ISNULL(j.IsTest,0)=0 AND ISNULL(j.IsArchived,0)=0 AND j.CreatedAt<=@Now AND (@Building IS NULL OR j.BuildingID=@Building) ORDER BY j.JobID`,[{name:"Building",type:TYPES.Int,value:buildingId},{name:"Now",type:TYPES.DateTime2,value:now}]);
 if(rows.length>MAX_JOBS)throw new PerformanceScopeTooLarge("Choose a building: the portfolio exceeds the 20,000-job analysis limit.");
 const jobs:PerformanceJob[]=rows.map(row=>({id:Number(row.JobID),title:String(row.Title),buildingId:Number(row.BuildingID),buildingName:String(row.BuildingName??`Building ${row.BuildingID}`),status:String(row.Status),awaitingRole:row.AwaitingRole==null?null:(String(row.AwaitingRole).trim()||null),kind:String(row.Kind??"facilities"),category:String(row.Category??"Unrecorded"),priority:String(row.Priority??"Unrecorded"),createdAt:iso(row.CreatedAt)!,completedAt:iso(row.CompletionDate),statusSince:iso(row.StatusSince),stalledAt:iso(row.StalledAt),expectedAt:iso(row.ExpectedProgressUpdate),stalled:Boolean(row.IsStalled),reason:row.StalledReason&&REASONS.has(String(row.StalledReason))?String(row.StalledReason):null}));
 const events=await executeQuery(connection,`SELECT TOP (200001) e.JobEventID,e.JobID,e.CreatedAt,e.NewStatus,e.NewAwaitingRole,e.IsStalled FROM dbo.JobEvents e
 WHERE e.JobID IN (SELECT CAST(value AS INT) FROM OPENJSON(@Ids)) AND (e.NewStatus IS NOT NULL OR e.NewAwaitingRole IS NOT NULL OR e.IsStalled IS NOT NULL) AND e.CreatedAt<=@Now ORDER BY e.JobID,e.CreatedAt,e.JobEventID`,[{name:"Ids",type:TYPES.NVarChar,value:JSON.stringify(jobs.map(job=>job.id))},{name:"Now",type:TYPES.DateTime2,value:now}]);
 if(events.length>MAX_EVENTS)throw new PerformanceScopeTooLarge("Choose a building: the scope exceeds the 200,000-event analysis limit.");
 const history:PerformanceEvent[]=events.map(row=>({id:Number(row.JobEventID),jobId:Number(row.JobID),at:iso(row.CreatedAt)!,status:row.NewStatus==null?null:String(row.NewStatus),awaitingRole:row.NewAwaitingRole==null?null:String(row.NewAwaitingRole),stalled:row.IsStalled==null?null:Boolean(row.IsStalled)}));
 const report=buildPerformance(jobs,history,period,now);report.buildingId=buildingId;
 const assets=await executeQuery(connection,`SELECT ja.AssetId,a.Name,a.BuildingId,ja.JobId FROM dbo.JobAssets ja JOIN dbo.Assets a ON a.AssetId=ja.AssetId WHERE ja.JobId IN (SELECT CAST(value AS INT) FROM OPENJSON(@Ids)) AND ja.UnlinkedAt IS NULL AND a.ArchivedAt IS NULL`,[{name:"Ids",type:TYPES.NVarChar,value:JSON.stringify(jobs.filter(job=>Date.parse(job.createdAt)>=period.fromUtc.getTime()&&Date.parse(job.createdAt)<period.toUtc.getTime()).map(job=>job.id))}]);
 const repeats=new Map<number,typeof report.repeats[number]>();for(const row of assets){const id=Number(row.AssetId),entry=repeats.get(id)??{assetId:id,name:String(row.Name),buildingId:Number(row.BuildingId),jobIds:[]};if(!entry.jobIds.includes(Number(row.JobId)))entry.jobIds.push(Number(row.JobId));repeats.set(id,entry);}report.repeats=[...repeats.values()].filter(row=>row.jobIds.length>1).sort((a,b)=>b.jobIds.length-a.jobIds.length);
 return report;
}
