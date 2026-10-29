import {TYPES,type Connection} from "tedious";
import {executeQuery} from "../db";
import {parsePeriod} from "../usage/period";
import {dayStartUtc,darwinDay} from "../usage/days";
import {loadPerformance} from "./store";
import type {ImprovementMetric,PerformanceImprovement,PerformanceReport} from "./types";
export const IMPROVEMENT_METRICS:readonly ImprovementMetric[]=["stalled","backlog","medianDays","p90Days"];
export function improvementValue(report:PerformanceReport,metric:ImprovementMetric){return metric==="stalled"?report.stalled:metric==="backlog"?report.backlog:report.current[metric];}
export function validateImprovement(body:Record<string,unknown>){
 if(typeof body.title!=="string"||!body.title.trim()||body.title.length>180)return "Add a title of 180 characters or less.";
 if(!Number.isInteger(body.ownerId)||Number(body.ownerId)<1||Number(body.ownerId)>2147483647)return "Choose an accountable staff member.";
 if(!IMPROVEMENT_METRICS.some(metric=>metric===body.metric))return "Choose a supported improvement metric.";
 if(typeof body.target!=="number"||!Number.isFinite(body.target)||body.target<0||body.target>1000000)return "Target must be a finite non-negative number below 1,000,000.";
 if((body.metric==="stalled"||body.metric==="backlog")&&!Number.isInteger(body.target))return "A job-count target must be a whole number.";
 if(typeof body.reviewOn!=="string"||!dayStartUtc(body.reviewOn))return "Choose a review date.";
 if(body.reviewOn<darwinDay(new Date()))return "The review date cannot be before today.";
 if(typeof body.days!=="number"||![7,30,90].includes(body.days))return "Choose a 7, 30 or 90 day measurement window.";
 if(body.buildingId!==null&&(!Number.isSafeInteger(body.buildingId)||Number(body.buildingId)===0||Math.abs(Number(body.buildingId))>2147483647))return "Choose a valid building, or all buildings.";
 if(body.note!==undefined&&(typeof body.note!=="string"||body.note.length>2000))return "Keep the note under 2,000 characters.";
 return null;
}
export async function improvementRows(connection:Connection){
 const rows=await executeQuery(connection,"SELECT ImprovementId,DataJson,Revision,Status,CreatedAt,UpdatedAt,CreatedBy FROM dbo.PerformanceImprovements ORDER BY CreatedAt DESC");
 return rows.map(row=>({...JSON.parse(String(row.DataJson)),id:Number(row.ImprovementId),revision:Number(row.Revision),status:String(row.Status),createdBy:String(row.CreatedBy),updatedAt:new Date(String(row.UpdatedAt)).toISOString()} as PerformanceImprovement));
}
export async function improvementReport(connection:Connection,days:number,buildingId:number|null){const parsed=parsePeriod(new URLSearchParams({days:String(days)}));if("error"in parsed)throw new Error(parsed.error);return loadPerformance(connection,parsed.period,buildingId);}
export async function activeImprovementOwner(connection:Connection,id:number){const rows=await executeQuery(connection,"SELECT DisplayName FROM dbo.AppUsers WHERE UserID=@Id AND IsActive=1 AND Role IS NOT NULL AND EntraOid IS NOT NULL",[{name:"Id",type:TYPES.Int,value:id}]);return rows.length?String(rows[0].DisplayName):null;}
