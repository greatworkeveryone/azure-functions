import {TYPES,type Connection} from "tedious";
import {executeQuery} from "../db";
import {addDays,darwinDay,dayStartUtc} from "../usage/days";
/** Only this opt-in telemetry table; no business, improvement or audit records are eligible. */
export async function purgeWorkflowSignals(connection:Connection,days:number,dryRun:boolean,now=new Date()){
 const cutoff=dayStartUtc(addDays(darwinDay(now),-Math.max(30,days)))!;
 const params=[{name:"Cutoff",type:TYPES.DateTime2,value:cutoff}];
 const exists=await executeQuery(connection,"SELECT OBJECT_ID(N'dbo.WorkflowSignals',N'U') AS TableId");if(!exists[0]?.TableId)return {eligible:0,deleted:0};
 const rows=await executeQuery(connection,"SELECT COUNT_BIG(*) AS N FROM dbo.WorkflowSignals WHERE RecordedAt<@Cutoff",params);const eligible=Number(rows[0]?.N??0);let deleted=0;
 if(!dryRun)for(let batch=0;batch<40;batch++){const removed=await executeQuery(connection,"DELETE TOP(5000) FROM dbo.WorkflowSignals WHERE RecordedAt<@Cutoff; SELECT @@ROWCOUNT AS N",params);const count=Number(removed[0]?.N??0);deleted+=count;if(count<5000)break;}
 return {eligible,deleted};
}
