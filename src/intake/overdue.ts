// Requests nobody has acknowledged inside the promise Facilities set (TR1). Read by the escalation sweep.
//
// A priority with no target is never listed, and a target only counts requests that arrived after it was set, so
// setting one never raises the backlog. The clock is business hours on the Darwin calendar, like the policy's.

import type { Connection } from "tedious";
import { executeQuery } from "../db";
import { addBusinessHours, holidaysFromEnv } from "../escalation/businessTime";
import { intakePriority } from "./state";

export const REQUEST_POLICY = "request.unacknowledged";
export const REQUEST_SUBJECT_TYPE = "work_request";

export interface OverdueRequest {
  dueAt: Date;
  priority: string;
  workRequestId: number;
}

/** The open, unacknowledged requests, with the priority they are filed under. The priority-to-target mapping is intakePriority (state.ts), applied in TS so there is one copy of it. */
const UNACKNOWLEDGED_SQL = `
  SELECT wr.WorkRequestID, wr.CreatedAt, COALESCE(o.Priority, wr.Priority) AS Priority
    FROM dbo.WorkRequests wr
    LEFT JOIN dbo.WorkRequestOverrides o ON o.WorkRequestID = wr.WorkRequestID
   WHERE ISNULL(wr.IntakeState, N'received') = N'received'
     AND wr.ActualCompletionDate IS NULL
     AND NOT EXISTS (SELECT 1 FROM dbo.Jobs j WHERE j.WorkRequestID = wr.WorkRequestID)`;

const TARGETS_SQL = `SELECT Priority, AckWithinBusinessHours AS Hours, SetAt FROM dbo.IntakeResponseTargets WHERE AckWithinBusinessHours IS NOT NULL AND SetAt IS NOT NULL`;

export async function listOverdueRequests(connection: Connection, now: Date = new Date()): Promise<OverdueRequest[]> {
  const targets = new Map((await executeQuery(connection, TARGETS_SQL) ?? []).map((row) => [String(row.Priority), row]));
  if (targets.size === 0) return [];
  const rows = await executeQuery(connection, UNACKNOWLEDGED_SQL);
  const holidays = holidaysFromEnv();
  const overdue: OverdueRequest[] = [];
  for (const row of rows ?? []) {
    if (!(row.CreatedAt instanceof Date)) continue;
    const priority = intakePriority(row.Priority);
    const target = targets.get(priority);
    // A target only counts requests that arrived after it was set.
    if (!target || !(target.SetAt instanceof Date) || row.CreatedAt.getTime() < target.SetAt.getTime()) continue;
    const dueAt = addBusinessHours(row.CreatedAt, Number(target.Hours), holidays);
    if (dueAt.getTime() <= now.getTime()) overdue.push({ dueAt, priority, workRequestId: Number(row.WorkRequestID) });
  }
  return overdue.sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime() || a.workRequestId - b.workRequestId);
}

/** When one received request is due, or null when its priority has no target (or it came before the target was set). */
export function dueAtFor(createdAt: Date | null, hours: number | null, setAt: Date | null): Date | null {
  if (createdAt === null || hours === null || setAt === null || createdAt.getTime() < setAt.getTime()) return null;
  return addBusinessHours(createdAt, hours, holidaysFromEnv());
}
