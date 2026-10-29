export interface PerformanceJob {
 id:number;title:string;buildingId:number;buildingName:string;status:string;awaitingRole:string|null;kind:string;category:string;priority:string;
 createdAt:string;completedAt:string|null;statusSince:string|null;stalledAt:string|null;expectedAt:string|null;stalled:boolean;reason:string|null;
}
export interface PerformanceEvent {id:number;jobId:number;at:string;status:string|null;awaitingRole:string|null;stalled:boolean|null;}
export interface PerformancePeriod {from:string;to:string;days:number;}
export interface PerformanceMetric {received:number;completed:number;reopened:number;medianDays:number|null;p90Days:number|null;resolutionSample:number;cohortCompleted:number;}
export interface PerformanceStage {key:string;label:string;count:number;oldestDays:number|null;medianDays:number|null;elapsedHours:number;}
export interface PerformanceEvidence extends PerformanceJob {stage:string;ageDays:number|null;overdue:boolean;received:boolean;completed:boolean;reopened:boolean;}
export interface PerformanceReport {
 version:1;generatedAt:string;period:PerformancePeriod;previousPeriod:PerformancePeriod;buildingId:number|null;
 current:PerformanceMetric;previous:PerformanceMetric;backlog:number;stalled:number;overdue:number;
 daily:{day:string;received:number;completed:number}[];stages:PerformanceStage[];teamElapsed:{team:string;hours:number}[];
 breakdowns:{dimension:"building"|"category"|"priority"|"kind"|"reason"|"team";key:string;label:string;open:number;stalled:number;overdue:number}[];
 evidence:PerformanceEvidence[];evidenceTotal:number;evidencePage:number;coverage:{jobs:number;historyJobs:number;unknownStageHours:number;missingCompletionDates:number;scope:"All non-test, non-archived jobs"};
 repeats:{assetId:number;name:string;buildingId:number;jobIds:number[]}[];
}
export type ImprovementMetric="stalled"|"backlog"|"medianDays"|"p90Days";
export interface PerformanceImprovement {
 id:number;title:string;ownerId:number;ownerName:string;metric:ImprovementMetric;target:number;reviewOn:string;buildingId:number|null;days:number;
 baseline:number;baselineAt:string;status:"open"|"closed"|"archived";revision:number;note:string;createdBy:string;updatedAt:string;reviewedValue?:number|null;reviewedAt?:string;outcome?:"met"|"not_met"|"inconclusive";
}
