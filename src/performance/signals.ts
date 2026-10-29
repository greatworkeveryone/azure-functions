import {TYPES,type Connection} from "tedious";
import {executeQuery} from "../db";
import type {UsagePeriod} from "../usage/period";
export const WORKFLOW_OPERATIONS=["job-save","job-update","inspection-save","inspection-complete","schedule-save","document-save","leave-save","decision-submit","quote-save","invoice-save"] as const;
export const WORKFLOW_OUTCOMES=["ok","validation","conflict","permission","server","network","other"] as const;
export interface WorkflowSignal {id:string;operation:typeof WORKFLOW_OPERATIONS[number];outcome:typeof WORKFLOW_OUTCOMES[number];durationMs:number;}
export function parseSignals(value:unknown):WorkflowSignal[]|null{
 if(!Array.isArray(value)||value.length<1||value.length>20)return null;
 const parsed:WorkflowSignal[]=[];
 for(const item of value){if(!item||typeof item!=="object"||Array.isArray(item))return null;const row=item as Record<string,unknown>;
  if(Object.keys(row).some(key=>!["id","operation","outcome","durationMs"].includes(key))||typeof row.id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(row.id)||!WORKFLOW_OPERATIONS.some(key=>key===row.operation)||!WORKFLOW_OUTCOMES.some(key=>key===row.outcome)||typeof row.durationMs!=="number"||!Number.isInteger(row.durationMs)||row.durationMs<0||row.durationMs>120000)return null;
  parsed.push({...row,id:row.id.toLowerCase()} as unknown as WorkflowSignal);
 }return parsed;
}
export async function storeSignals(connection:Connection,userId:number,signals:WorkflowSignal[]){
 // One set-based insert; duplicate event IDs are ignored, so transport retries do not inflate attempts.
 await executeQuery(connection,`INSERT dbo.WorkflowSignals(EventId,UserId,Operation,Outcome,DurationMs)
 SELECT s.Id,@UserId,s.Operation,s.Outcome,s.DurationMs FROM OPENJSON(@Signals) WITH(Id UNIQUEIDENTIFIER '$.id',Operation NVARCHAR(40) '$.operation',Outcome NVARCHAR(24) '$.outcome',DurationMs INT '$.durationMs') s
 WHERE NOT EXISTS(SELECT 1 FROM dbo.WorkflowSignals WITH(UPDLOCK,HOLDLOCK) WHERE EventId=s.Id)`,[{name:"UserId",type:TYPES.Int,value:userId},{name:"Signals",type:TYPES.NVarChar,value:JSON.stringify([...new Map(signals.map(signal=>[signal.id,signal])).values()])}]);
}
export async function loadFriction(connection:Connection,period:UsagePeriod){
 const params=[{name:"From",type:TYPES.DateTime2,value:period.fromUtc},{name:"To",type:TYPES.DateTime2,value:period.toUtc}];
 const rows=await executeQuery(connection,`SELECT Operation,Outcome,COUNT(*) AS Attempts,AVG(CAST(DurationMs AS FLOAT)) AS AverageMs,MIN(RecordedAt) AS FirstAt,MAX(RecordedAt) AS LastAt FROM dbo.WorkflowSignals WHERE RecordedAt>=@From AND RecordedAt<@To GROUP BY Operation,Outcome ORDER BY Operation,Outcome`,params);
 const latency=await executeQuery(connection,`SELECT DISTINCT Operation,PERCENTILE_CONT(0.5) WITHIN GROUP(ORDER BY DurationMs) OVER(PARTITION BY Operation) AS MedianMs,PERCENTILE_CONT(0.9) WITHIN GROUP(ORDER BY DurationMs) OVER(PARTITION BY Operation) AS P90Ms FROM dbo.WorkflowSignals WHERE RecordedAt>=@From AND RecordedAt<@To`,params);
 return {generatedAt:new Date().toISOString(),period:{from:period.from,to:period.to,days:period.days},outcomes:rows.map(row=>({operation:String(row.Operation),outcome:String(row.Outcome),attempts:Number(row.Attempts),averageMs:Number(row.AverageMs),firstAt:new Date(String(row.FirstAt)).toISOString(),lastAt:new Date(String(row.LastAt)).toISOString()})),latency:latency.map(row=>({operation:String(row.Operation),medianMs:Number(row.MedianMs),p90Ms:Number(row.P90Ms)}))};
}
