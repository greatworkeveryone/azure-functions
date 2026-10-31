// "My requests": the requests this tenancy submitted through its links, newest first, each with a
// status timeline (TR3). Scope is the resolved TenantId only. Staff notes, costs, contractors and
// other people's details never leave: only the fields below are selected.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { categoryLabel } from "./constants";
import { timelineFor, type JobFacts, type Timeline } from "./timeline";

export interface TenantRequestApi {
  category: string;
  categoryLabel: string;
  description: string;
  location: string;
  photoCount: number;
  reference: string;
  requestId: number;
  submittedAt: string;
  timeline: Timeline;
  urgency: string;
}

export const referenceFor = (workRequestId: number): string => `FP-${Math.abs(workRequestId)}`;

// Job facts come from the jobs raised from the request (Jobs.WorkRequestID, test jobs excluded). Booked is the job
// at Work or Tenant (the TR4 attendance moment); complete is Done, or on to accounts approval (isWorkCompletion).
const SELECT_REQUESTS = `SELECT TOP (50) w.WorkRequestID, w.Details, w.ExactLocation, w.Priority, w.Status, w.CreatedAt,
       w.ActualCompletionDate, w.IntakeState AS IntakeState,
       (SELECT COUNT(*) FROM dbo.TenantRequestPhotos p WHERE p.WorkRequestID = w.WorkRequestID AND p.TenantId = w.SourceTenantId) AS PhotoCount,
       w.TenantCategory,
       (SELECT COUNT(*) FROM dbo.Jobs j WHERE j.WorkRequestID = w.WorkRequestID AND j.IsTest = 0) AS JobCount,
       (SELECT COUNT(*) FROM dbo.Jobs j WHERE j.WorkRequestID = w.WorkRequestID AND j.IsTest = 0
           AND j.Status IN (N'Work', N'Tenant', N'Done', N'Awaiting Approval') AND NOT (j.Status = N'Awaiting Approval' AND ISNULL(j.AwaitingRole, N'') <> N'accounts')) AS JobsBooked,
       (SELECT COUNT(*) FROM dbo.Jobs j WHERE j.WorkRequestID = w.WorkRequestID AND j.IsTest = 0
           AND (j.Status = N'Done' OR (j.Status = N'Awaiting Approval' AND j.AwaitingRole = N'accounts'))) AS JobsComplete
  FROM dbo.WorkRequests w
 WHERE w.SourceTenantId = @TenantId AND w.SourceKind = N'tenant_link'
 ORDER BY w.CreatedAt DESC, w.WorkRequestID DESC`;

const jobFacts = (row: Record<string, unknown>): JobFacts => {
  const count = Number(row.JobCount ?? 0);
  return { allComplete: count > 0 && Number(row.JobsComplete ?? 0) === count, anyBooked: Number(row.JobsBooked ?? 0) > 0, hasJob: count > 0 };
};

export async function listTenantRequests(connection: Connection, tenantId: number): Promise<TenantRequestApi[]> {
  const rows = await executeQuery(connection, SELECT_REQUESTS, [{ name: "TenantId", type: TYPES.Int, value: tenantId }]);
  return rows.map((row) => {
    const id = Number(row.WorkRequestID);
    const category = typeof row.TenantCategory === "string" ? row.TenantCategory : "other";
    const submitted = row.CreatedAt instanceof Date ? row.CreatedAt : new Date(0);
    return {
      category,
      categoryLabel: categoryLabel(category),
      description: String(row.Details ?? ""),
      location: String(row.ExactLocation ?? ""),
      photoCount: Number(row.PhotoCount ?? 0),
      reference: referenceFor(id),
      requestId: id,
      submittedAt: submitted.toISOString(),
      timeline: timelineFor({ completedAt: row.ActualCompletionDate, intakeState: row.IntakeState, job: jobFacts(row), native: id < 0, status: row.Status, submittedAt: submitted }),
      urgency: String(row.Priority ?? "").toLowerCase(),
    };
  });
}
