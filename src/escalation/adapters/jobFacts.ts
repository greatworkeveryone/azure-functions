// Reads jobs as the rules in jobRules.ts see them. One query shape for every
// job policy: the live jobs for the sweep, or a single job for a condition
// check. "Quote requested" is stored as JobRequestedContractors rows (AddedAt is
// the only timestamp; RequestSent is a tick with none), a quote received is a
// Quotes row, and an invoice waiting is an incoming JobInvoices row still
// 'pending'.

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "../../db";
import { jobKindOf } from "../../jobKinds";
import type { JobFacts } from "./jobRules";

const JOB_FACTS_SELECT = `SELECT j.JobID, j.BuildingID, b.BuildingName, j.Title, j.Status, j.Priority, j.Kind,
    j.AssignedTo, j.AssignedToUserID, j.CreatedAt, j.StatusSince, j.AcknowledgedAt,
    j.ExpectedProgressUpdate, j.IsArchived,
    (SELECT COUNT(*) FROM dbo.JobRequestedContractors rc WHERE rc.JobID = j.JobID) AS RequestedContractors,
    (SELECT MIN(rc.AddedAt) FROM dbo.JobRequestedContractors rc WHERE rc.JobID = j.JobID) AS FirstQuoteRequestAt,
    (SELECT COUNT(*) FROM dbo.Quotes q WHERE q.JobID = j.JobID) AS QuoteCount,
    (SELECT COUNT(*) FROM dbo.JobInvoices ji
       WHERE ji.JobID = j.JobID AND ji.Direction = 'incoming' AND ji.Status = 'pending') AS PendingInvoices,
    (SELECT MIN(COALESCE(ji.ReceivedAt, ji.CreatedAt)) FROM dbo.JobInvoices ji
       WHERE ji.JobID = j.JobID AND ji.Direction = 'incoming' AND ji.Status = 'pending') AS OldestPendingInvoiceAt
  FROM dbo.Jobs j
  LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID`;

const LIVE_JOBS_SQL = `${JOB_FACTS_SELECT} WHERE j.IsArchived = 0 AND j.Status <> 'Done'`;
const ONE_JOB_SQL = `${JOB_FACTS_SELECT} WHERE j.JobID = @JobID`;

const asDate = (value: unknown): Date | null => (value instanceof Date ? value : null);

export function toJobFacts(row: SqlRow): JobFacts {
  const assignedTo = typeof row.AssignedTo === "string" && row.AssignedTo.trim() !== "" ? row.AssignedTo.trim() : null;
  return {
    acknowledgedAt: asDate(row.AcknowledgedAt),
    // Jobs assigned by name before AssignedToUserID existed still have an owner.
    assigned: row.AssignedToUserID !== null && row.AssignedToUserID !== undefined ? true : assignedTo !== null,
    assignedTo,
    buildingId: row.BuildingID === null || row.BuildingID === undefined ? null : Number(row.BuildingID),
    buildingName: typeof row.BuildingName === "string" ? row.BuildingName : null,
    createdAt: row.CreatedAt as Date,
    expectedProgressUpdate: asDate(row.ExpectedProgressUpdate),
    firstQuoteRequestAt: asDate(row.FirstQuoteRequestAt),
    isArchived: Boolean(row.IsArchived),
    jobId: Number(row.JobID),
    kind: jobKindOf(row.Kind),
    oldestPendingInvoiceAt: asDate(row.OldestPendingInvoiceAt),
    pendingInvoices: Number(row.PendingInvoices ?? 0),
    priority: typeof row.Priority === "string" ? row.Priority : null,
    quoteCount: Number(row.QuoteCount ?? 0),
    requestedContractors: Number(row.RequestedContractors ?? 0),
    status: String(row.Status),
    statusSince: asDate(row.StatusSince),
    title: typeof row.Title === "string" ? row.Title : `Job #${row.JobID}`,
  };
}

/** Every job not archived and not Done. */
export async function loadLiveJobFacts(connection: Connection): Promise<JobFacts[]> {
  return (await executeQuery(connection, LIVE_JOBS_SQL)).map(toJobFacts);
}

/** One job, live or not; null when there is no such job. */
export async function loadJobFacts(connection: Connection, jobId: number): Promise<JobFacts | null> {
  const rows = await executeQuery(connection, ONE_JOB_SQL, [{ name: "JobID", type: TYPES.Int, value: jobId }]);
  return rows.length === 0 ? null : toJobFacts(rows[0]);
}

/** Whether the job is live and a decision on it has handed on a next step that is
 *  not yet closed (migration 138): what keeps a job.next_step escalation alive. */
export async function hasOpenNextStep(connection: Connection, jobId: number): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `SELECT CASE WHEN EXISTS (
       SELECT 1 FROM dbo.JobDecisions d
       JOIN dbo.Jobs j ON j.JobID = d.JobId
       WHERE d.JobId = @JobID AND d.NextStep IS NOT NULL AND d.NextStepClosedAt IS NULL
         AND j.IsArchived = 0 AND j.Status <> N'Done'
     ) THEN 1 ELSE 0 END AS IsOpen`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  return Number(rows[0]?.IsOpen ?? 0) === 1;
}

const CHUNK = 500;

/** When the newest email linked to each job arrived in Floorplan (Emails.CreatedAt,
 *  our own clock, so a late-ingested message is never missed). Archived emails
 *  were dismissed by a person and don't count. */
export async function latestEmailArrivals(connection: Connection, jobIds: readonly number[]): Promise<Map<number, Date>> {
  const result = new Map<number, Date>();
  for (let start = 0; start < jobIds.length; start += CHUNK) {
    const chunk = jobIds.slice(start, start + CHUNK);
    const params: SqlParam[] = chunk.map((id, index) => ({ name: `J${index}`, type: TYPES.Int, value: id }));
    const placeholders = chunk.map((_, index) => `@J${index}`).join(", ");
    const rows = await executeQuery(
      connection,
      `SELECT e.MatchedJobID AS JobID, MAX(e.CreatedAt) AS LatestAt
       FROM dbo.Emails e
       WHERE e.MatchedJobID IN (${placeholders}) AND e.Status <> 'archived'
       GROUP BY e.MatchedJobID`,
      params,
    );
    for (const row of rows) {
      const at = asDate(row.LatestAt);
      if (at) result.set(Number(row.JobID), at);
    }
  }
  return result;
}
