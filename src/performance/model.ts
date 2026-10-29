import {addDays,darwinDay,daysBetween} from "../usage/days";
import type {UsagePeriod} from "../usage/period";
import type {PerformanceEvent,PerformanceJob,PerformanceMetric,PerformanceReport,PerformanceStage} from "./types";
const DAY=86400000;
const STAGES=["Intake","Quotes","Approval","In progress","Tenant","Stalled","Closed","Unclassified"];
const statusStage=(status:string|null,stalled:boolean)=>status==="Done"?"Closed":stalled?"Stalled":({New:"Intake",Quote:"Quotes","Awaiting Approval":"Approval",Work:"In progress",Tenant:"Tenant",Done:"Closed"}[status??""]??"Unclassified");
const time=(value:string|null)=>value===null?NaN:Date.parse(value);
export function percentile(values:number[],percent:number):number|null{if(!values.length)return null;const sorted=[...values].sort((a,b)=>a-b);return percent===0.5&&sorted.length%2===0?(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2:sorted[Math.max(0,Math.ceil(percent*sorted.length)-1)];}
function completions(job:PerformanceJob,events:PerformanceEvent[],end:number){
 const recorded:number[]=[];let prior:string|null=null;for(const event of events){if(time(event.at)>=end)break;if(event.status!==null){if(event.status==="Done"&&prior!=="Done")recorded.push(time(event.at));prior=event.status;}}
 if(!recorded.length&&job.status==="Done"&&Number.isFinite(time(job.completedAt))&&time(job.completedAt)<end&&time(job.completedAt)>=time(job.createdAt))recorded.push(time(job.completedAt));
 return recorded;
}
function metrics(jobs:PerformanceJob[],eventMap:Map<number,PerformanceEvent[]>,from:number,to:number):PerformanceMetric{
 let received=0,completed=0,reopened=0,cohortCompleted=0;const durations:number[]=[];
 for(const job of jobs){const events=eventMap.get(job.id)??[],created=time(job.createdAt),cohort=created>=from&&created<to;if(cohort)received++;
  const done=completions(job,events,to),latest=done.at(-1);
  if(latest!==undefined&&latest>=from){completed++;if(latest>=created)durations.push((latest-created)/DAY);}
  let wasDone=false,opened=false;for(const event of events){const at=time(event.at);if(at>=to)break;if(event.status){if(wasDone&&event.status!=="Done"&&at>=from)opened=true;wasDone=event.status==="Done";}}if(opened)reopened++;
  if(cohort&&latest!==undefined&&!events.some(event=>event.status&&event.status!=="Done"&&time(event.at)>latest&&time(event.at)<to))cohortCompleted++;
 }
 return {received,completed,reopened,medianDays:percentile(durations,0.5),p90Days:percentile(durations,0.9),resolutionSample:durations.length,cohortCompleted};
}
/** Pure reconstruction. Unknown initial history stays unknown; all intervals are clipped. */
export function buildPerformance(jobs:PerformanceJob[],events:PerformanceEvent[],period:UsagePeriod,now=new Date()):PerformanceReport & {records:PerformanceReport["evidence"]}{
 const end=Math.min(period.toUtc.getTime(),now.getTime()),start=period.fromUtc.getTime(),priorStart=start-period.days*DAY;
 const eventMap=new Map<number,PerformanceEvent[]>();const jobMap=new Map(jobs.map(job=>[job.id,job]));
 for(const event of events){const job=jobMap.get(event.jobId);if(job&&time(event.at)>=time(job.createdAt)){const list=eventMap.get(job.id)??[];list.push(event);eventMap.set(job.id,list);}}
 for(const history of eventMap.values())history.sort((a,b)=>time(a.at)-time(b.at)||a.id-b.id);
 const current=metrics(jobs,eventMap,start,end),previous=metrics(jobs,eventMap,priorStart,start-(period.toUtc.getTime()-end));
 const daily=Array.from({length:period.days},(_,i)=>({day:addDays(period.from,i),received:0,completed:0}));
 const dailyByDay=new Map(daily.map(day=>[day.day,day]));
 const elapsed=new Map(STAGES.map(key=>[key,0])),teamHours=new Map<string,number>();let unknown=0,historyJobs=0;
 const evidence:PerformanceReport["evidence"]=[],records:PerformanceReport["evidence"]=[];
 for(const job of jobs){const history=eventMap.get(job.id)??[];if(history.some(event=>event.status!==null))historyJobs++;
  const created=time(job.createdAt);if(created>=start&&created<end){const day=dailyByDay.get(darwinDay(new Date(created)));if(day)day.received++;}
  const done=completions(job,history,end).at(-1);if(done!==undefined&&done>=start){const day=dailyByDay.get(darwinDay(new Date(done)));if(day)day.completed++;}
  let cursor=Math.max(start,created),status:string|null=null,stalled=false,team:string|null=null;
  const transitions=[...history];
  if(!history.some(event=>event.status)&&job.statusSince&&time(job.statusSince)<end)transitions.push({id:Number.MAX_SAFE_INTEGER,jobId:job.id,at:job.statusSince,status:job.status,stalled:job.stalled,awaitingRole:job.awaitingRole});
  if(job.status==="Done"&&!history.some(event=>event.status==="Done")&&Number.isFinite(time(job.completedAt))&&time(job.completedAt)>=created&&time(job.completedAt)<end)transitions.push({id:Number.MAX_SAFE_INTEGER,jobId:job.id,at:job.completedAt!,status:"Done",stalled:false,awaitingRole:null});
  transitions.sort((a,b)=>time(a.at)-time(b.at)||a.id-b.id);
  const add=(until:number)=>{if(until<=cursor)return;const key=statusStage(status,stalled),hours=(until-cursor)/3600000;if(key==="Unclassified")unknown+=hours;else if(key!=="Closed"){elapsed.set(key,(elapsed.get(key)??0)+hours);teamHours.set(team??"Unrecorded",(teamHours.get(team??"Unrecorded")??0)+hours);}cursor=until;};
  for(const event of transitions){const at=time(event.at);if(at>=end)break;if(at>cursor)add(at);if(event.status!==null){status=event.status;team=event.awaitingRole;}if(event.stalled!==null)stalled=event.stalled;if(event.awaitingRole!==null)team=event.awaitingRole;}
  add(end);
  const stage=statusStage(job.status,job.stalled),anchor=job.stalled?time(job.stalledAt):time(job.statusSince);
  const flags=metrics([job],eventMap,start,end);
  const record={...job,stage,ageDays:Number.isFinite(anchor)&&anchor>=created&&anchor<=now.getTime()?(now.getTime()-anchor)/DAY:null,overdue:job.status!=="Done"&&Number.isFinite(time(job.expectedAt))&&time(job.expectedAt)<now.getTime(),received:flags.received>0,completed:flags.completed>0,reopened:flags.reopened>0};
  records.push(record);if(job.status!=="Done")evidence.push(record);
 }
 evidence.sort((a,b)=>Number(b.stalled)-Number(a.stalled)||Number(b.overdue)-Number(a.overdue)||(b.ageDays??-1)-(a.ageDays??-1)||a.id-b.id);
 const stages:PerformanceStage[]=STAGES.filter(key=>key!=="Closed").map(key=>{const rows=evidence.filter(row=>row.stage===key),ages=rows.flatMap(row=>row.ageDays===null?[]:[row.ageDays]);return {key,label:key,count:rows.length,oldestDays:ages.length?Math.max(...ages):null,medianDays:percentile(ages,0.5),elapsedHours:elapsed.get(key)??0};});
 const breakdowns:PerformanceReport["breakdowns"]=[];
 for(const dimension of ["building","category","priority","kind","reason","team"] as const){const groups=new Map<string,typeof evidence>();for(const row of evidence){const key=dimension==="building"?String(row.buildingId):dimension==="team"?(row.awaitingRole??"Unrecorded"):dimension==="reason"?(row.status==="Tenant"?"Waiting on tenant":row.stalled?row.reason??"Unrecorded":"Not stalled"):row[dimension]||"Unrecorded";const group=groups.get(key)??[];group.push(row);groups.set(key,group);}for(const [key,rows] of groups)breakdowns.push({dimension,key,label:dimension==="building"?rows[0].buildingName:key,open:rows.length,stalled:rows.filter(row=>row.stalled||row.status==="Tenant").length,overdue:rows.filter(row=>row.overdue).length});}
 return {version:1,generatedAt:now.toISOString(),period:{from:period.from,to:period.to,days:period.days},previousPeriod:{from:addDays(period.from,-period.days),to:addDays(period.from,-1),days:daysBetween(addDays(period.from,-period.days),addDays(period.from,-1))+1},buildingId:null,current,previous,backlog:evidence.length,stalled:evidence.filter(row=>row.stalled||row.status==="Tenant").length,overdue:evidence.filter(row=>row.overdue).length,daily,stages,teamElapsed:[...teamHours].map(([team,hours])=>({team,hours})),breakdowns,evidence,evidenceTotal:evidence.length,evidencePage:0,records,coverage:{jobs:jobs.length,historyJobs,unknownStageHours:unknown,missingCompletionDates:jobs.filter(job=>job.status==="Done"&&!completions(job,eventMap.get(job.id)??[],now.getTime()+1).length).length,scope:"All non-test, non-archived jobs"},repeats:[]};
}
