// The SQL side of decision requests (jobs plan A1, migration 137): reading and
// writing dbo.JobDecisionRequests, and the few facts about a job, a file and the
// people that a request needs. Everything is parameterised; the only text
// interpolated into SQL is built here from literal fragments and placeholders.

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "../db";
import { rowVersionToBuffer, rowVersionToText } from "../escalation/store";
import { jobKindOf } from "../jobKinds";
import { isDecisionTier, type DecisionTier } from "./tiers";

export type RequestState = "pending" | "answered" | "withdrawn";
export type AssignmentMode = "named" | "role";

export interface DecisionRequestRow {
  assignmentMode: AssignmentMode;
  /** Moves up to the raiser's manager on its own when unanswered. Always true for
   *  soon, routine and fixed, never for an emergency; for urgent, the raiser's tick. */
  autoEscalate: boolean;
  /** Who was asked: the userIds it went to, and the role when everyone in one was asked. */
  decisionMakers: { role: string | null; userIds: number[] };
  jobId: number;
  question: string;
  requestedAt: Date;
  requestedBy: string;
  requestedByUserId: number | null;
  requestId: number;
  respondBy: Date | null;
  routineWeeks: number | null;
  /** Base64; send it back with a change so a stale one is a 409. */
  rowVersion: string;
  sourceAttachmentId: number | null;
  state: RequestState;
  tier: DecisionTier;
  withdrawnAt: Date | null;
  withdrawnBy: string | null;
  withdrawnByUserId: number | null;
  withdrawnReason: string | null;
}

const REQUEST_COLUMNS = `RequestId, JobId, Question, DecisionMakers, AssignmentMode, Tier, RespondBy, RoutineWeeks,
  AutoEscalate, SourceAttachmentId, State, RequestedBy, RequestedByUserId, RequestedAt, WithdrawnAt, WithdrawnBy, WithdrawnByUserId,
  WithdrawnReason, RowVersion`;

const asDate = (value: unknown): Date | null => (value instanceof Date ? value : null);
const asNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const asString = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function parseMakers(value: unknown): DecisionRequestRow["decisionMakers"] {
  try {
    const parsed: unknown = JSON.parse(String(value ?? ""));
    const object = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
    return {
      role: typeof object.role === "string" && object.role !== "" ? object.role : null,
      userIds: Array.isArray(object.userIds) ? object.userIds.filter((id): id is number => typeof id === "number") : [],
    };
  } catch {
    return { role: null, userIds: [] };
  }
}

export function toRequestRow(raw: SqlRow): DecisionRequestRow {
  const tier = String(raw.Tier);
  return {
    assignmentMode: raw.AssignmentMode === "role" ? "role" : "named",
    autoEscalate: raw.AutoEscalate === true || raw.AutoEscalate === 1,
    decisionMakers: parseMakers(raw.DecisionMakers),
    jobId: Number(raw.JobId),
    question: String(raw.Question),
    requestedAt: raw.RequestedAt as Date,
    requestedBy: String(raw.RequestedBy),
    requestedByUserId: asNumber(raw.RequestedByUserId),
    requestId: Number(raw.RequestId),
    respondBy: asDate(raw.RespondBy),
    routineWeeks: asNumber(raw.RoutineWeeks),
    rowVersion: rowVersionToText(raw.RowVersion),
    sourceAttachmentId: asNumber(raw.SourceAttachmentId),
    state: raw.State === "answered" || raw.State === "withdrawn" ? raw.State : "pending",
    tier: isDecisionTier(tier) ? tier : "soon",
    withdrawnAt: asDate(raw.WithdrawnAt),
    withdrawnBy: asString(raw.WithdrawnBy),
    withdrawnByUserId: asNumber(raw.WithdrawnByUserId),
    withdrawnReason: asString(raw.WithdrawnReason),
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

export interface JobForRequest {
  buildingId: number | null;
  buildingName: string | null;
  isArchived: boolean;
  jobId: number;
  kind: string;
  status: string;
  title: string;
}

/** The job a request is about, held until the transaction ends so two asks about
 *  one job are taken one at a time. Null when there is no such job. */
export async function lockJob(connection: Connection, jobId: number): Promise<JobForRequest | null> {
  const rows = await executeQuery(
    connection,
    `SELECT j.JobID, j.BuildingID, b.BuildingName, j.Title, j.Kind, j.Status, j.IsArchived
     FROM dbo.Jobs j WITH (UPDLOCK, HOLDLOCK)
     LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
     WHERE j.JobID = @JobID`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    buildingId: asNumber(row.BuildingID),
    buildingName: typeof row.BuildingName === "string" ? row.BuildingName : null,
    isArchived: Boolean(row.IsArchived),
    jobId: Number(row.JobID),
    kind: jobKindOf(row.Kind),
    status: String(row.Status),
    title: typeof row.Title === "string" ? row.Title : `Job #${row.JobID}`,
  };
}

/** The job's building, for a withdrawal's ledger row. Null when there is no such job. */
export async function jobBuilding(connection: Connection, jobId: number): Promise<{ buildingId: number | null } | null> {
  const rows = await executeQuery(connection, `SELECT BuildingID FROM dbo.Jobs WHERE JobID = @JobID`, [
    { name: "JobID", type: TYPES.Int, value: jobId },
  ]);
  return rows.length === 0 ? null : { buildingId: asNumber(rows[0].BuildingID) };
}

export async function getRequestRow(
  connection: Connection,
  requestId: number,
  options: { forUpdate?: boolean } = {},
): Promise<DecisionRequestRow | null> {
  const LOCK_HINT = options.forUpdate ? "WITH (UPDLOCK, ROWLOCK)" : "";
  const rows = await executeQuery(
    connection,
    `SELECT ${REQUEST_COLUMNS} FROM dbo.JobDecisionRequests ${LOCK_HINT} WHERE RequestId = @RequestId`,
    [{ name: "RequestId", type: TYPES.Int, value: requestId }],
  );
  return rows.length === 0 ? null : toRequestRow(rows[0]);
}

/** The one pending request on a job, if any. */
export async function findPending(connection: Connection, jobId: number): Promise<DecisionRequestRow | null> {
  const rows = await executeQuery(
    connection,
    `SELECT ${REQUEST_COLUMNS} FROM dbo.JobDecisionRequests WHERE JobId = @JobId AND State = N'pending'`,
    [{ name: "JobId", type: TYPES.Int, value: jobId }],
  );
  return rows.length === 0 ? null : toRequestRow(rows[0]);
}

/** The newest request on a job, whatever became of it. */
export async function latestForJob(connection: Connection, jobId: number): Promise<DecisionRequestRow | null> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP 1 ${REQUEST_COLUMNS} FROM dbo.JobDecisionRequests WHERE JobId = @JobId ORDER BY RequestId DESC`,
    [{ name: "JobId", type: TYPES.Int, value: jobId }],
  );
  return rows.length === 0 ? null : toRequestRow(rows[0]);
}

/** Whether a file is attached to this job. */
export async function attachmentOnJob(connection: Connection, attachmentId: number, jobId: number): Promise<boolean> {
  const rows = await executeQuery(connection, `SELECT Id FROM dbo.Attachments WHERE Id = @AttachmentId AND JobID = @JobID`, [
    { name: "AttachmentId", type: TYPES.Int, value: attachmentId },
    { name: "JobID", type: TYPES.Int, value: jobId },
  ]);
  return rows.length > 0;
}

/** SQL Server's "Invalid object name": the table is not there (migration 137 not applied). */
const INVALID_OBJECT_NAME = 208;

/**
 * The requests a file is the subject of, for refusing to delete it. A database
 * that has not had migration 137 applied has no requests, so no file is one's
 * subject, and deleting files goes on as it did (the build may be ahead of the
 * migration for a while: migrations are applied by hand).
 */
export async function requestsAboutAttachment(
  connection: Connection,
  attachmentId: number,
): Promise<{ jobId: number; requestId: number; state: RequestState }[]> {
  let rows: SqlRow[];
  try {
    rows = await executeQuery(
      connection,
      `SELECT RequestId, JobId, State FROM dbo.JobDecisionRequests WHERE SourceAttachmentId = @AttachmentId`,
      [{ name: "AttachmentId", type: TYPES.Int, value: attachmentId }],
    );
  } catch (error) {
    if ((error as { number?: unknown } | null)?.number === INVALID_OBJECT_NAME) return [];
    throw error;
  }
  return rows.map((row) => ({
    jobId: Number(row.JobId),
    requestId: Number(row.RequestId),
    state: row.State === "answered" || row.State === "withdrawn" ? row.State : "pending",
  }));
}

/** Names and roles for these people, active or not, to show who was asked. */
export async function peopleByIds(
  connection: Connection,
  userIds: readonly number[],
): Promise<Map<number, { active: boolean; name: string; role: string | null }>> {
  const people = new Map<number, { active: boolean; name: string; role: string | null }>();
  const ids = [...new Set(userIds)].slice(0, 200);
  if (ids.length === 0) return people;
  const params: SqlParam[] = ids.map((id, index) => ({ name: `U${index}`, type: TYPES.Int, value: id }));
  const placeholders = ids.map((_, index) => `@U${index}`).join(", ");
  const rows = await executeQuery(
    connection,
    `SELECT UserID, DisplayName, Email, Role, IsActive FROM dbo.AppUsers WHERE UserID IN (${placeholders})`,
    params,
  );
  for (const row of rows) {
    people.set(Number(row.UserID), {
      active: Boolean(row.IsActive),
      name: String(row.DisplayName ?? row.Email ?? `User ${row.UserID}`),
      role: typeof row.Role === "string" && row.Role.trim() ? row.Role.trim().toLowerCase() : null,
    });
  }
  return people;
}

// ── Writes ───────────────────────────────────────────────────────────────────

export interface NewRequest {
  assignmentMode: AssignmentMode;
  autoEscalate: boolean;
  decisionMakers: { role: string | null; userIds: number[] };
  jobId: number;
  question: string;
  requestedBy: string;
  requestedByUserId: number | null;
  respondBy: Date | null;
  routineWeeks: number | null;
  sourceAttachmentId: number | null;
  tier: DecisionTier;
}

/** Inserts a pending request and returns its id. */
export async function insertRequest(connection: Connection, request: NewRequest): Promise<number> {
  const rows = await executeQuery(
    connection,
    `INSERT INTO dbo.JobDecisionRequests
       (JobId, Question, DecisionMakers, AssignmentMode, Tier, RespondBy, RoutineWeeks, AutoEscalate, SourceAttachmentId,
        RequestedBy, RequestedByUserId)
     OUTPUT INSERTED.RequestId
     VALUES
       (@JobId, @Question, @DecisionMakers, @AssignmentMode, @Tier, @RespondBy, @RoutineWeeks, @AutoEscalate, @SourceAttachmentId,
        @RequestedBy, @RequestedByUserId)`,
    [
      { name: "JobId", type: TYPES.Int, value: request.jobId },
      { name: "Question", type: TYPES.NVarChar, value: request.question },
      { name: "DecisionMakers", type: TYPES.NVarChar, value: JSON.stringify(request.decisionMakers) },
      { name: "AssignmentMode", type: TYPES.NVarChar, value: request.assignmentMode },
      { name: "Tier", type: TYPES.NVarChar, value: request.tier },
      { name: "RespondBy", type: TYPES.DateTime2, value: request.respondBy, options: { scale: 3 } },
      { name: "RoutineWeeks", type: TYPES.Int, value: request.routineWeeks },
      { name: "AutoEscalate", type: TYPES.Bit, value: request.autoEscalate },
      { name: "SourceAttachmentId", type: TYPES.Int, value: request.sourceAttachmentId },
      { name: "RequestedBy", type: TYPES.NVarChar, value: request.requestedBy },
      { name: "RequestedByUserId", type: TYPES.Int, value: request.requestedByUserId },
    ],
  );
  return Number(rows[0].RequestId);
}

const WITHDRAW_SET = `State = N'withdrawn', WithdrawnAt = @At, WithdrawnBy = @By, WithdrawnByUserId = @ById, WithdrawnReason = @Reason`;
const WITHDRAW_ANY_VERSION = `UPDATE dbo.JobDecisionRequests SET ${WITHDRAW_SET} OUTPUT INSERTED.RequestId WHERE RequestId = @RequestId AND State = N'pending'`;
const WITHDRAW_THIS_VERSION = `UPDATE dbo.JobDecisionRequests SET ${WITHDRAW_SET} OUTPUT INSERTED.RequestId WHERE RequestId = @RequestId AND State = N'pending' AND RowVersion = @RowVersion`;

/** Ends a pending request as withdrawn, if it is still pending (and, when a
 *  version is given, still that version). False when it is not. */
export async function markWithdrawn(
  connection: Connection,
  requestId: number,
  withdrawal: { at: Date; by: string; byUserId: number | null; expectedRowVersion?: string | null; reason: string },
): Promise<boolean> {
  const versioned = typeof withdrawal.expectedRowVersion === "string" && withdrawal.expectedRowVersion !== "";
  const params: SqlParam[] = [
    { name: "RequestId", type: TYPES.Int, value: requestId },
    { name: "At", type: TYPES.DateTime2, value: withdrawal.at, options: { scale: 3 } },
    { name: "By", type: TYPES.NVarChar, value: withdrawal.by },
    { name: "ById", type: TYPES.Int, value: withdrawal.byUserId },
    { name: "Reason", type: TYPES.NVarChar, value: withdrawal.reason },
  ];
  if (versioned) params.push({ name: "RowVersion", type: TYPES.Binary, value: rowVersionToBuffer(withdrawal.expectedRowVersion as string) });
  const rows = await executeQuery(connection, versioned ? WITHDRAW_THIS_VERSION : WITHDRAW_ANY_VERSION, params);
  return rows.length > 0;
}

/** Why a file a decision request is about can't be deleted. */
export const DECISION_FILE_REFUSAL =
  "This file is what a decision request on this job is about, so it stays with the request. Withdraw the request first if it was raised by mistake.";
