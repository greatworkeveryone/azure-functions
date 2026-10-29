import {buildPerformance,percentile} from './model';
import {parsePeriod} from '../usage/period';
import type {PerformanceEvent,PerformanceJob} from './types';
const now=new Date('2026-10-29T14:30:00Z'); // Darwin midnight, end of 29 October
const parsed=parsePeriod(new URLSearchParams({from:'2026-10-23',to:'2026-10-29'}),now);
if('error'in parsed)throw Error(parsed.error);
const period=parsed.period;
const job=(overrides:Partial<PerformanceJob>={}):PerformanceJob=>({id:1,title:'Repair',buildingId:7,buildingName:'Example',status:'Work',awaitingRole:'facilities',kind:'facilities',category:'Electrical',priority:'Normal',createdAt:'2026-10-22T14:30:00Z',completedAt:null,statusSince:null,stalledAt:null,expectedAt:null,stalled:false,reason:null,...overrides});
const event=(id:number,at:string,status:string|null,overrides:Partial<PerformanceEvent>={}):PerformanceEvent=>({id,jobId:1,at,status,awaitingRole:null,stalled:null,...overrides});
it('uses Darwin boundaries, zero fills days and excludes the exclusive end',()=>{
 const report=buildPerformance([job(),job({id:2,createdAt:'2026-10-22T14:29:59Z'}),job({id:3,createdAt:'2026-10-29T14:30:00Z'})],[],period,now);
 expect(report.current.received).toBe(1);expect(report.previous.received).toBe(1);expect(report.daily).toHaveLength(7);expect(report.daily[0]).toEqual({day:'2026-10-23',received:1,completed:0});
});
it('counts completed and reopened distinct jobs without claiming they are still closed',()=>{
 const events=[event(1,'2026-10-23T14:30:00Z','Done'),event(2,'2026-10-24T14:30:00Z','Done'),event(3,'2026-10-25T14:30:00Z','Work'),event(4,'2026-10-26T14:30:00Z','Done'),event(5,'2026-10-27T14:30:00Z','Work')];
 const report=buildPerformance([job()],events,period,now);
 expect(report.current).toMatchObject({received:1,completed:1,reopened:1,cohortCompleted:0,medianDays:4,p90Days:4,resolutionSample:1});expect(report.backlog).toBe(1);expect(report.daily.reduce((sum,row)=>sum+row.completed,0)).toBe(1);
});
it('does not treat duplicate Done annotations as a later completion',()=>{
 const report=buildPerformance([job({status:'Done'})],[event(1,'2026-10-23T14:30:00Z','Done'),event(2,'2026-10-24T14:30:00Z','Done')],period,now);
 expect(report.current.medianDays).toBe(1);expect(report.current.cohortCompleted).toBe(1);
});
it('uses a valid current completion fallback, excludes impossible dates, and keeps empty samples null',()=>{
 const report=buildPerformance([job({status:'Done',completedAt:'2026-10-24T14:30:00Z'}),job({id:2,status:'Done',completedAt:'2026-10-21T14:30:00Z'})],[],period,now);
 expect(report.current.completed).toBe(1);expect(report.coverage.missingCompletionDates).toBe(1);expect(report.current.medianDays).toBe(2);expect(report.coverage.unknownStageHours).toBe(48+168);
 expect(buildPerformance([],[],period,now).current.medianDays).toBeNull();expect(percentile([1,3,9,11],.5)).toBe(6);expect(percentile([1,3,9,11],.9)).toBe(11);
});
it('clips state/team intervals and preserves unknown history rather than blaming a team',()=>{
 const report=buildPerformance([job()],[event(1,'2026-10-23T14:30:00Z','Quote',{awaitingRole:'facilities'}),event(2,'2026-10-24T14:30:00Z',null,{awaitingRole:'director'}),event(3,'2026-10-25T14:30:00Z','Work'),event(4,'2026-10-30T14:30:00Z','Done')],period,now);
 expect(report.coverage.unknownStageHours).toBe(24);expect(report.stages.find(row=>row.key==='Quotes')?.elapsedHours).toBe(48);expect(report.teamElapsed).toEqual([{team:'facilities',hours:24},{team:'director',hours:24},{team:'Unrecorded',hours:96}]);
});
it('a state before the window carries in; close ends the elapsed clock despite a stale stall flag',()=>{
 const report=buildPerformance([job({createdAt:'2026-10-01T00:00:00Z',status:'Done',stalled:true})],[event(1,'2026-10-20T14:30:00Z','Quote',{stalled:true}),event(2,'2026-10-23T14:30:00Z','Done')],period,now);
 expect(report.stages.find(row=>row.key==='Stalled')?.elapsedHours).toBe(24);expect(report.stalled).toBe(0);expect(report.coverage.unknownStageHours).toBe(0);
});
it('anchors current state only when typed status history is absent and keeps invalid ages unknown',()=>{
 const report=buildPerformance([job({statusSince:'2026-10-27T14:30:00Z',expectedAt:'2026-10-28T14:30:00Z'}),job({id:2,status:'Tenant',statusSince:'2026-11-01T00:00:00Z'})],[],period,now);
 expect(report.stages.find(row=>row.key==='In progress')?.elapsedHours).toBe(48);expect(report.overdue).toBe(1);expect(report.stalled).toBe(1);expect(report.records[1].ageDays).toBeNull();
});
it('matches the elapsed portion of the previous window when today is incomplete',()=>{
 const midday=new Date('2026-10-29T02:30:00Z'); // Darwin noon
 const report=buildPerformance([job({createdAt:'2026-10-22T10:30:00Z'}),job({id:2,createdAt:'2026-10-22T01:30:00Z'})],[],period,midday);
 expect(report.previous.received).toBe(1); // late afternoon in the previous period is not compared with noon today
});
it('breaks simultaneous transitions by event ID and ignores pre-creation events',()=>{
 const report=buildPerformance([job()],[event(0,'2026-10-01T00:00:00Z','Done'),event(2,'2026-10-23T14:30:00Z','Work'),event(1,'2026-10-23T14:30:00Z','Quote')],period,now);
 expect(report.current.completed).toBe(0);expect(report.stages.find(row=>row.key==='In progress')?.elapsedHours).toBe(144);
});
it('does not call a valid later completion a missing date when reviewing an older reporting period',()=>{
 const older=parsePeriod(new URLSearchParams({from:'2026-10-01',to:'2026-10-07'}),now);if('error'in older)throw Error(older.error);
 const report=buildPerformance([job({createdAt:'2026-10-01T00:00:00Z',status:'Done',completedAt:'2026-10-20T00:00:00Z'})],[],older.period,now);
 expect(report.current.completed).toBe(0);expect(report.coverage.missingCompletionDates).toBe(0);
});
