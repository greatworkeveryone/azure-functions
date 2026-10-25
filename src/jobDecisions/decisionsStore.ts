// The SQL side of the answers to decision requests (jobs plan A2, migration 138):
// reading and writing dbo.JobDecisions, ending a request as answered, and the few
// facts about a job a response needs (who raised it, who has it) and the two writes
// it makes to the job itself (who has it now, what it says in the history).
// Everything is parameterised; the only text interpolated into SQL is built here
// from literal fragments.

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "../db";
import { rowVersionToBuffer, rowVersionToText } from "../escalation/store";
import { isOutcome, type Outcome } from "./respond";

export type StepClosedKind = "done" | "replaced";

export interface DecisionRow {
  decisionId: number;
  /** YYYY-MM-DD; defer only. */
  deferUntil: string | null;
  jobId: number;
  nextStep: string | null;
  /** How the next step ended; null while it is open (and for a decision with none). */
  nextStepClosed: { at: Date; byId: number | null; byName: string; kind: StepClosedKind; note: string | null } | null;
  nextStepDueAt: Date | null;
  nextStepOwnerRole: string | null;
  nextStepOwnerUserId: number | null;
  outcome: Outcome;
  rationale: string;
  /** The request raised when a deferral came due; null until it has. */
  reaskRequestId: number | null;
  requestId: number;
  respondedAt: Date;
  respondedById: number | null;
  respondedByName: string;
  /** Base64; send it back with a change so a stale one is a 409. */
  rowVersion: string;
}

const DECISION_COLUMNS = `DecisionId, RequestId, JobId, Outcome, Rationale, NextStep, NextStepOwnerUserId, NextStepOwnerRole, NextStepDueAt,
  DeferUntil, ReaskRequestId, RespondedById, RespondedByName, RespondedAt, NextStepClosedAt, NextStepClosedKind, NextStepClosedById,
  NextStepClosedByName, NextStepClosedNote, RowVersion`;

const asDate = (value: unknown): Date | null => (value instanceof Date ? value : null);
const asNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const asString = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

/** A DATE column as YYYY-MM-DD: the driver gives a Date at midnight UTC. */
function dateKey(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return typeof value === "string" && value !== "" ? value.slice(0, 10) : null;
}

export function toDecisionRow(raw: SqlRow): DecisionRow {
  const outcome = String(raw.Outcome);
  const closedAt = asDate(raw.NextStepClosedAt);
  return {
    decisionId: Number(raw.DecisionId),
    deferUntil: dateKey(raw.DeferUntil),
    jobId: Number(raw.JobId),
    nextStep: asString(raw.NextStep),
    nextStepClosed: closedAt
      ? {
          at: closedAt,
          byId: asNumber(raw.NextStepClosedById),
          byName: String(raw.NextStepClosedByName ?? ""),
          kind: raw.NextStepClosedKind === "replaced" ? "replaced" : "done",
          note: asString(raw.NextStepClosedNote),
        }
      : null,
    nextStepDueAt: asDate(raw.NextStepDueAt),
    nextStepOwnerRole: asString(raw.NextStepOwnerRole),
    nextStepOwnerUserId: asNumber(raw.NextStepOwnerUserId),
    outcome: isOutcome(outcome) ? outcome : "approve",
    rationale: String(raw.Rationale),
    reaskRequestId: asNumber(raw.ReaskRequestId),
    requestId: Number(raw.RequestId),
    respondedAt: raw.RespondedAt as Date,
    respondedById: asNumber(raw.RespondedById),
    respondedByName: String(raw.RespondedByName),
    rowVersion: rowVersionToText(raw.RowVersion),
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One decision by id. `forUpdate` holds the row until the transaction ends. */
export async function getDecisionRow(connection: Connection, decisionId: number, options: { forUpdate?: boolean } = {}): Promise<DecisionRow | null> {
  const LOCK_HINT = options.forUpdate ? "WITH (UPDLOCK, ROWLOCK)" : "";
  const rows = await executeQuery(connection, `SELECT ${DECISION_COLUMNS} FROM dbo.JobDecisions ${LOCK_HINT} WHERE DecisionId = @DecisionId`, [
    { name: "DecisionId", type: TYPES.Int, value: decisionId },
  ]);
  return rows.length === 0 ? null : toDecisionRow(rows[0]);
}

/** SQL Server's "Invalid object name": the table is not there (migration 138 not applied). */
const INVALID_OBJECT_NAME = 208;

/**
 * The two reads the screen's read endpoint makes (getJobDecisionRequest, which A1
 * already serves) find nothing, rather than fail, in a database that has not had
 * migration 138 applied: a build that is ahead of its migration still shows the
 * request, as it did. The endpoints that write need the table and fail without it.
 */
async function readDecisions(connection: Connection, sql: string, params: SqlParam[]): Promise<SqlRow[]> {
  try {
    return await executeQuery(connection, sql, params);
  } catch (error) {
    if ((error as { number?: unknown } | null)?.number === INVALID_OBJECT_NAME) return [];
    throw error;
  }
}

/** The decision that answered a request, if it has been answered. */
export async function decisionForRequest(connection: Connection, requestId: number): Promise<DecisionRow | null> {
  const rows = await readDecisions(connection, `SELECT ${DECISION_COLUMNS} FROM dbo.JobDecisions WHERE RequestId = @RequestId`, [
    { name: "RequestId", type: TYPES.Int, value: requestId },
  ]);
  return rows.length === 0 ? null : toDecisionRow(rows[0]);
}

/** The newest decision on a job. */
export async function latestDecisionForJob(connection: Connection, jobId: number): Promise<DecisionRow | null> {
  const rows = await readDecisions(connection, `SELECT TOP 1 ${DECISION_COLUMNS} FROM dbo.JobDecisions WHERE JobId = @JobId ORDER BY DecisionId DESC`, [
    { name: "JobId", type: TYPES.Int, value: jobId },
  ]);
  return rows.length === 0 ? null : toDecisionRow(rows[0]);
}

/** The decisions on a job whose next step is still open, newest first. Normally one
 *  or none: a later decision closes the step an earlier one handed on. */
export async function openNextSteps(connection: Connection, jobId: number): Promise<DecisionRow[]> {
  const rows = await executeQuery(
    connection,
    `SELECT ${DECISION_COLUMNS} FROM dbo.JobDecisions
     WHERE JobId = @JobId AND NextStep IS NOT NULL AND NextStepClosedAt IS NULL
     ORDER BY DecisionId DESC`,
    [{ name: "JobId", type: TYPES.Int, value: jobId }],
  );
  return rows.map(toDecisionRow);
}

/** Whether a deferral on this job is still waiting for its day: a defer decision not
 *  yet asked again, and no later request on the job (which would have taken its
 *  place). While one is, the job is not finished. */
export async function hasScheduledReask(connection: Connection, jobId: number): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `SELECT CASE WHEN EXISTS (
       SELECT 1 FROM dbo.JobDecisions d
       WHERE d.JobId = @JobId AND d.Outcome = N'defer' AND d.ReaskRequestId IS NULL
         AND NOT EXISTS (SELECT 1 FROM dbo.JobDecisionRequests r WHERE r.JobId = d.JobId AND r.RequestId > d.RequestId)
     ) THEN 1 ELSE 0 END AS Scheduled`,
    [{ name: "JobId", type: TYPES.Int, value: jobId }],
  );
  return Number(rows[0]?.Scheduled ?? 0) === 1;
}

export interface DueDeferral {
  decisionId: number;
  /** The Darwin day the question comes back, YYYY-MM-DD. */
  deferUntil: string;
  jobId: number;
  requestId: number;
}

/**
 * The deferrals whose day has come (by date: the caller applies the hour) and that
 * have not been asked again: a live job and no request on it since. Oldest first. A
 * database that has not had migration 138 applied has none, so a build that is ahead
 * of the migration sweeps as it did.
 */
export async function dueDeferrals(connection: Connection, today: string, limit: number): Promise<DueDeferral[]> {
  let rows: SqlRow[];
  try {
    rows = await executeQuery(
      connection,
      `SELECT TOP (@Limit) d.DecisionId, d.JobId, d.RequestId, d.DeferUntil
       FROM dbo.JobDecisions d
       JOIN dbo.Jobs j ON j.JobID = d.JobId
       WHERE d.Outcome = N'defer' AND d.ReaskRequestId IS NULL AND d.DeferUntil <= @Today
         AND j.IsArchived = 0 AND j.Status <> N'Done'
         AND NOT EXISTS (SELECT 1 FROM dbo.JobDecisionRequests r WHERE r.JobId = d.JobId AND r.RequestId > d.RequestId)
       ORDER BY d.DeferUntil, d.DecisionId`,
      [
        { name: "Limit", type: TYPES.Int, value: limit },
        { name: "Today", type: TYPES.Date, value: today },
      ],
    );
  } catch (error) {
    if ((error as { number?: unknown } | null)?.number === INVALID_OBJECT_NAME) return [];
    throw error;
  }
  return rows.map((row) => ({
    decisionId: Number(row.DecisionId),
    deferUntil: dateKey(row.DeferUntil) ?? today,
    jobId: Number(row.JobId),
    requestId: Number(row.RequestId),
  }));
}

/** Whether the job has a request newer than this one (pending, answered or withdrawn). */
export async function hasLaterRequest(connection: Connection, jobId: number, afterRequestId: number): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `SELECT CASE WHEN EXISTS (SELECT 1 FROM dbo.JobDecisionRequests WHERE JobId = @JobId AND RequestId > @RequestId) THEN 1 ELSE 0 END AS HasLater`,
    [
      { name: "JobId", type: TYPES.Int, value: jobId },
      { name: "RequestId", type: TYPES.Int, value: afterRequestId },
    ],
  );
  return Number(rows[0]?.HasLater ?? 0) === 1;
}

export interface JobParties {
  assignedTo: string | null;
  assignedToUserId: number | null;
  createdBy: string | null;
  /** The creator's Entra object id (Jobs.CreatedById); null on a legacy row. */
  createdById: string | null;
}

/** Who raised the job and who has it. Null when there is no such job. */
export async function jobParties(connection: Connection, jobId: number): Promise<JobParties | null> {
  const rows = await executeQuery(
    connection,
    `SELECT AssignedTo, AssignedToUserID, CreatedBy, CreatedById FROM dbo.Jobs WHERE JobID = @JobID`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    assignedTo: asString(row.AssignedTo),
    assignedToUserId: asNumber(row.AssignedToUserID),
    createdBy: asString(row.CreatedBy),
    createdById: asString(row.CreatedById),
  };
}

/** The active user with this Entra object id, if any. */
export async function activeUserIdByOid(connection: Connection, oid: string): Promise<number | null> {
  const rows = await executeQuery(connection, `SELECT UserID FROM dbo.AppUsers WHERE EntraOid = @Oid AND IsActive = 1`, [
    { name: "Oid", type: TYPES.NVarChar, value: oid },
  ]);
  return rows.length === 0 ? null : Number(rows[0].UserID);
}

// ── Writes ───────────────────────────────────────────────────────────────────

export interface NewDecision {
  deferUntil: string | null;
  jobId: number;
  nextStep: string | null;
  nextStepDueAt: Date | null;
  nextStepOwnerRole: string | null;
  nextStepOwnerUserId: number | null;
  outcome: Outcome;
  rationale: string;
  requestId: number;
  respondedAt: Date;
  respondedById: number | null;
  respondedByName: string;
}

/** Inserts a decision and returns its id. A request is answered once: the unique
 *  index refuses a second, which the caller reads as a lost race. */
export async function insertDecision(connection: Connection, decision: NewDecision): Promise<number> {
  const rows = await executeQuery(
    connection,
    `INSERT INTO dbo.JobDecisions
       (RequestId, JobId, Outcome, Rationale, NextStep, NextStepOwnerUserId, NextStepOwnerRole, NextStepDueAt, DeferUntil,
        RespondedById, RespondedByName, RespondedAt)
     OUTPUT INSERTED.DecisionId
     VALUES
       (@RequestId, @JobId, @Outcome, @Rationale, @NextStep, @NextStepOwnerUserId, @NextStepOwnerRole, @NextStepDueAt, @DeferUntil,
        @RespondedById, @RespondedByName, @RespondedAt)`,
    [
      { name: "RequestId", type: TYPES.Int, value: decision.requestId },
      { name: "JobId", type: TYPES.Int, value: decision.jobId },
      { name: "Outcome", type: TYPES.NVarChar, value: decision.outcome },
      { name: "Rationale", type: TYPES.NVarChar, value: decision.rationale },
      { name: "NextStep", type: TYPES.NVarChar, value: decision.nextStep },
      { name: "NextStepOwnerUserId", type: TYPES.Int, value: decision.nextStepOwnerUserId },
      { name: "NextStepOwnerRole", type: TYPES.NVarChar, value: decision.nextStepOwnerRole },
      { name: "NextStepDueAt", type: TYPES.DateTime2, value: decision.nextStepDueAt, options: { scale: 3 } },
      { name: "DeferUntil", type: TYPES.Date, value: decision.deferUntil },
      { name: "RespondedById", type: TYPES.Int, value: decision.respondedById },
      { name: "RespondedByName", type: TYPES.NVarChar, value: decision.respondedByName },
      { name: "RespondedAt", type: TYPES.DateTime2, value: decision.respondedAt, options: { scale: 3 } },
    ],
  );
  return Number(rows[0].DecisionId);
}

/** Ends a pending request as answered, if it is still pending and still the version
 *  the caller read. False when it is not. */
export async function markRequestAnswered(connection: Connection, requestId: number, expectedRowVersion: string): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.JobDecisionRequests SET State = N'answered'
     OUTPUT INSERTED.RequestId
     WHERE RequestId = @RequestId AND State = N'pending' AND RowVersion = @RowVersion`,
    [
      { name: "RequestId", type: TYPES.Int, value: requestId },
      { name: "RowVersion", type: TYPES.Binary, value: rowVersionToBuffer(expectedRowVersion) },
    ],
  );
  return rows.length > 0;
}

export interface StepClosing {
  at: Date;
  byId: number | null;
  byName: string;
  /** When given, the step is only closed if the decision is still this version. */
  expectedRowVersion?: string | null;
  kind: StepClosedKind;
  note: string | null;
}

const CLOSE_SET = `NextStepClosedAt = @At, NextStepClosedKind = @Kind, NextStepClosedById = @ById, NextStepClosedByName = @By, NextStepClosedNote = @Note`;
const CLOSE_ANY_VERSION = `UPDATE dbo.JobDecisions SET ${CLOSE_SET} OUTPUT INSERTED.DecisionId WHERE DecisionId = @DecisionId AND NextStep IS NOT NULL AND NextStepClosedAt IS NULL`;
const CLOSE_THIS_VERSION = `UPDATE dbo.JobDecisions SET ${CLOSE_SET} OUTPUT INSERTED.DecisionId WHERE DecisionId = @DecisionId AND NextStep IS NOT NULL AND NextStepClosedAt IS NULL AND RowVersion = @RowVersion`;

/** Closes a decision's open next step, once. False when it was not open (or, when a
 *  version is given, no longer that version). */
export async function closeNextStep(connection: Connection, decisionId: number, closing: StepClosing): Promise<boolean> {
  const versioned = typeof closing.expectedRowVersion === "string" && closing.expectedRowVersion !== "";
  const params: SqlParam[] = [
    { name: "DecisionId", type: TYPES.Int, value: decisionId },
    { name: "At", type: TYPES.DateTime2, value: closing.at, options: { scale: 3 } },
    { name: "Kind", type: TYPES.NVarChar, value: closing.kind },
    { name: "ById", type: TYPES.Int, value: closing.byId },
    { name: "By", type: TYPES.NVarChar, value: closing.byName },
    { name: "Note", type: TYPES.NVarChar, value: closing.note },
  ];
  if (versioned) params.push({ name: "RowVersion", type: TYPES.Binary, value: rowVersionToBuffer(closing.expectedRowVersion as string) });
  const rows = await executeQuery(connection, versioned ? CLOSE_THIS_VERSION : CLOSE_ANY_VERSION, params);
  return rows.length > 0;
}

/** Records that a deferral has been asked again, as this request. Once: false when it
 *  already was (or the decision is not a deferral). */
export async function stampReask(connection: Connection, decisionId: number, requestId: number): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.JobDecisions SET ReaskRequestId = @RequestId
     OUTPUT INSERTED.DecisionId
     WHERE DecisionId = @DecisionId AND Outcome = N'defer' AND ReaskRequestId IS NULL`,
    [
      { name: "DecisionId", type: TYPES.Int, value: decisionId },
      { name: "RequestId", type: TYPES.Int, value: requestId },
    ],
  );
  return rows.length > 0;
}

// ── The job itself ───────────────────────────────────────────────────────────

/** Hands the job to someone: a person, or (no AssignedToUserID) a role by its label. */
export async function reassignJob(connection: Connection, jobId: number, assignee: { name: string; userId: number | null }): Promise<void> {
  await executeQuery(
    connection,
    `UPDATE dbo.Jobs SET AssignedTo = @AssignedTo, AssignedToUserID = @AssignedToUserID, LastModifiedDate = SYSUTCDATETIME() WHERE JobID = @JobID`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "AssignedTo", type: TYPES.NVarChar, value: assignee.name },
      { name: "AssignedToUserID", type: TYPES.Int, value: assignee.userId },
    ],
  );
}

export interface NewJobEvent {
  createdBy: string;
  eventType: string;
  jobId: number;
  newAssignee?: string | null;
  newAwaitingRole?: string | null;
  newStatus?: string | null;
  text: string;
}

/** One row on the job's activity feed. */
export async function insertJobEvent(connection: Connection, event: NewJobEvent): Promise<void> {
  await executeQuery(
    connection,
    `INSERT INTO dbo.JobEvents (JobID, CreatedBy, [Text], EventType, NewAssignee, NewStatus, NewAwaitingRole)
     VALUES (@JobID, @CreatedBy, @Text, @EventType, @NewAssignee, @NewStatus, @NewAwaitingRole)`,
    [
      { name: "JobID", type: TYPES.Int, value: event.jobId },
      { name: "CreatedBy", type: TYPES.NVarChar, value: event.createdBy },
      { name: "Text", type: TYPES.NVarChar, value: event.text },
      { name: "EventType", type: TYPES.NVarChar, value: event.eventType },
      { name: "NewAssignee", type: TYPES.NVarChar, value: event.newAssignee ?? null },
      { name: "NewStatus", type: TYPES.NVarChar, value: event.newStatus ?? null },
      { name: "NewAwaitingRole", type: TYPES.NVarChar, value: event.newAwaitingRole ?? null },
    ],
  );
}
