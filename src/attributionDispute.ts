// Decision 16: a live attribution dispute suspends outgoing POs/MYOB sends.
import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "./db";

export async function hasOpenAttributionDispute(connection: Connection, jobId: number): Promise<boolean> {
  const rows = await executeQuery(connection, `SELECT TOP (1) EscalationId FROM dbo.Escalations
    WHERE SubjectType = 'approval_attribution'
      AND PolicyKey IN ('quote.attribution_disputed', 'po.variance_disputed')
      AND Status IN ('open', 'acknowledged')
      AND RIGHT(SubjectId, LEN(@JobSuffix)) = @JobSuffix`, [
    { name: "JobSuffix", type: TYPES.NVarChar, value: `@${jobId}` },
  ]);
  return rows.length > 0;
}
export const ATTRIBUTION_DISPUTE_MESSAGE = "A manager has disputed an approval on this job. Resolve the dispute in For you before sending a purchase order.";
