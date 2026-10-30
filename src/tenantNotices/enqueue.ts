// Which job transitions tell the tenant, and the outbox row that records it (TR4, PLAN §15).
//
// The trigger. The job status machine (jobStatusMachine.ts) has no attendance date or time anywhere in the data, so
// "attendance booked" is the moment a contractor is engaged: the job enters Work (quote approved, PO raised, or a
// contract job authorised), which is what "scheduled / in works" means in this machine. "Completed" is the same
// definition the service schedules use (isWorkCompletion: on to accounts approval, or Done). A bounce through the
// Tenant block back to Work is not a new booking.
//
// The outbox. The row is inserted by the transition's own connection, inside its transaction, so a rolled-back
// transition leaves no notice. The unique index on (JobId, Event) makes it once per job and event whatever retries.
// A failure here is logged and swallowed: a notice must never stop a job moving.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { isWorkCompletion } from "../serviceScheduleRuns";
import { noticesMode, type NoticeEvent } from "./config";

export interface TransitionState {
  awaitingRole: string | null;
  status: string | null;
}

export function noticeEventFor(from: TransitionState | null, to: TransitionState | null): NoticeEvent | null {
  if (!from || !to) return null;
  const toDone = isWorkCompletion(to.status, to.awaitingRole);
  if (toDone && !isWorkCompletion(from.status, from.awaitingRole)) return "completed";
  if (to.status === "Work" && from.status !== "Work" && from.status !== "Tenant") return "attendance";
  return null;
}

const ENQUEUE_SQL = `INSERT INTO dbo.TenantNotices (JobId, WorkRequestId, TenantId, Event)
  SELECT j.JobID, j.WorkRequestID, j.TenantID, @Event
    FROM dbo.Jobs j
   WHERE j.JobID = @JobId AND j.WorkRequestID IS NOT NULL AND j.IsTest = 0
     AND NOT EXISTS (SELECT 1 FROM dbo.TenantNotices n WHERE n.JobId = j.JobID AND n.Event = @Event)`;

/** Records that this job's tenant is owed a notice. Does nothing while the switch is off. Never throws. */
export async function enqueueTenantNotice(connection: Connection, jobId: number, from: TransitionState | null, to: TransitionState | null): Promise<boolean> {
  if (noticesMode() === "off") return false;
  const event = noticeEventFor(from, to);
  if (event === null) return false;
  try {
    await executeQuery(connection, ENQUEUE_SQL, [
      { name: "JobId", type: TYPES.Int, value: jobId },
      { name: "Event", type: TYPES.NVarChar, value: event },
    ]);
    return true;
  } catch (error) {
    console.warn("enqueueTenantNotice:", error instanceof Error ? error.message : String(error));
    return false;
  }
}
