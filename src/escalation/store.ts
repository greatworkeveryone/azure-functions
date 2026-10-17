// The SQL side of escalations: reading rows, writing them, and the inbox query.
// Everything is parameterised; the only text interpolated into SQL is built
// here from literal fragments and placeholders.

import { TYPES, type Connection } from "tedious";
import { buildUpdateSet, executeQuery, type SqlParam, type SqlRow } from "../db";
import { escapeLike } from "../ledger/filters";
import { paginationSqlSuffix, type PaginationParams } from "../pagination";
import { EscalationError } from "./errors";
import { normaliseRole, seenPolicyPrefixesOfAll, teamRolesOfAll } from "./roles";
import type { DirectoryUser, EscalationKind, EscalationRow, EscalationStatus, NotificationState, Viewer } from "./types";

export const ESCALATION_COLUMNS = `EscalationId, SubjectType, SubjectId, BuildingId, Kind, Urgent, PolicyKey, [Level],
  TargetRole, TargetUserId, RaisedByUserId, RaisedByName, RaisedByKind, Reason, Note, Summary, Context, DueAt, Status,
  AcknowledgedAt, AcknowledgedByUserId, AcknowledgedByName, ResolvedAt, ResolvedByUserId, ResolvedByName,
  ResolutionCode, ResolutionNote, ParentEscalationId, NoIndependentTarget, NotificationState, NotificationAttempts,
  LastNotificationError, LastNotificationAttemptAt, LastNotifiedAt, LastFollowUpAt, CreatedAt, UpdatedAt, RowVersion`;

const LIVE_SQL = "Status IN ('open', 'acknowledged')";
const OPEN_SQL = "Status = 'open'";
const CLOSED_SQL = "Status IN ('resolved', 'superseded', 'withdrawn')";

// ── Mapping ──────────────────────────────────────────────────────────────────

const asDate = (value: unknown): Date | null => (value instanceof Date ? value : null);
const asNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const asString = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function parseContext(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string" || value === "") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function rowVersionToText(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString("base64") : typeof value === "string" ? value : "";
}

/** The base64 text clients hold -> the 8 bytes SQL compares. */
export function rowVersionToBuffer(text: string): Buffer {
  const buffer = Buffer.from(text, "base64");
  if (buffer.length !== 8) throw new EscalationError("bad_request", "rowVersion is not a valid version");
  return buffer;
}

export function toEscalationRow(raw: SqlRow): EscalationRow {
  return {
    acknowledgedAt: asDate(raw.AcknowledgedAt),
    acknowledgedByName: asString(raw.AcknowledgedByName),
    acknowledgedByUserId: asNumber(raw.AcknowledgedByUserId),
    buildingId: asNumber(raw.BuildingId),
    context: parseContext(raw.Context),
    createdAt: raw.CreatedAt as Date,
    dueAt: asDate(raw.DueAt),
    escalationId: Number(raw.EscalationId),
    kind: raw.Kind as EscalationKind,
    lastFollowUpAt: asDate(raw.LastFollowUpAt),
    lastNotificationAttemptAt: asDate(raw.LastNotificationAttemptAt),
    lastNotificationError: asString(raw.LastNotificationError),
    lastNotifiedAt: asDate(raw.LastNotifiedAt),
    level: Number(raw.Level),
    noIndependentTarget: Boolean(raw.NoIndependentTarget),
    note: asString(raw.Note),
    notificationAttempts: Number(raw.NotificationAttempts ?? 0),
    notificationState: raw.NotificationState as NotificationState,
    parentEscalationId: asNumber(raw.ParentEscalationId),
    policyKey: String(raw.PolicyKey),
    raisedByKind: raw.RaisedByKind as EscalationRow["raisedByKind"],
    raisedByName: String(raw.RaisedByName),
    raisedByUserId: asNumber(raw.RaisedByUserId),
    reason: asString(raw.Reason),
    resolutionCode: asString(raw.ResolutionCode),
    resolutionNote: asString(raw.ResolutionNote),
    resolvedAt: asDate(raw.ResolvedAt),
    resolvedByName: asString(raw.ResolvedByName),
    resolvedByUserId: asNumber(raw.ResolvedByUserId),
    rowVersion: rowVersionToText(raw.RowVersion),
    status: raw.Status as EscalationStatus,
    subjectId: String(raw.SubjectId),
    subjectType: String(raw.SubjectType),
    summary: String(raw.Summary),
    targetRole: asString(raw.TargetRole),
    targetUserId: asNumber(raw.TargetUserId),
    updatedAt: raw.UpdatedAt as Date,
    urgent: Boolean(raw.Urgent),
  };
}

// ── Reads ────────────────────────────────────────────────────────────────────

/** One escalation by id. `forUpdate` holds the row until the transaction ends. */
export async function getEscalationRow(
  connection: Connection,
  escalationId: number,
  options: { forUpdate?: boolean } = {},
): Promise<EscalationRow | null> {
  const LOCK_HINT = options.forUpdate ? "WITH (UPDLOCK, ROWLOCK)" : "";
  const rows = await executeQuery(
    connection,
    `SELECT ${ESCALATION_COLUMNS} FROM dbo.Escalations ${LOCK_HINT} WHERE EscalationId = @EscalationId`,
    [{ name: "EscalationId", type: TYPES.BigInt, value: escalationId }],
  );
  return rows.length === 0 ? null : toEscalationRow(rows[0]);
}

/** The open or acknowledged escalation for a subject and policy, if any. */
export async function findLiveEscalation(
  connection: Connection,
  subjectType: string,
  subjectId: string,
  policyKey: string,
): Promise<EscalationRow | null> {
  const rows = await executeQuery(
    connection,
    `SELECT ${ESCALATION_COLUMNS} FROM dbo.Escalations
     WHERE SubjectType = @SubjectType AND SubjectId = @SubjectId AND PolicyKey = @PolicyKey AND ${LIVE_SQL}`,
    [
      { name: "SubjectType", type: TYPES.NVarChar, value: subjectType },
      { name: "SubjectId", type: TYPES.NVarChar, value: subjectId },
      { name: "PolicyKey", type: TYPES.NVarChar, value: policyKey },
    ],
  );
  return rows.length === 0 ? null : toEscalationRow(rows[0]);
}

/** Every open or acknowledged escalation about one subject, whatever its policy. */
export async function listLiveForSubject(connection: Connection, subjectType: string, subjectId: string): Promise<EscalationRow[]> {
  const rows = await executeQuery(
    connection,
    `SELECT ${ESCALATION_COLUMNS} FROM dbo.Escalations
     WHERE SubjectType = @SubjectType AND SubjectId = @SubjectId AND ${LIVE_SQL}
     ORDER BY EscalationId`,
    [
      { name: "SubjectType", type: TYPES.NVarChar, value: subjectType },
      { name: "SubjectId", type: TYPES.NVarChar, value: subjectId },
    ],
  );
  return rows.map(toEscalationRow);
}

/** Every open or acknowledged escalation. A few dozen rows in practice. */
export async function listLiveEscalations(connection: Connection): Promise<EscalationRow[]> {
  const rows = await executeQuery(
    connection,
    `SELECT ${ESCALATION_COLUMNS} FROM dbo.Escalations WHERE ${LIVE_SQL} ORDER BY EscalationId`,
  );
  return rows.map(toEscalationRow);
}

/** One escalation's chain: the rows it superseded and the rows that superseded it. */
export async function listChain(connection: Connection, escalation: EscalationRow): Promise<EscalationRow[]> {
  // The newest 200: a reminder every couple of days adds up over a long-running job.
  const rows = await executeQuery(
    connection,
    `SELECT TOP 200 ${ESCALATION_COLUMNS} FROM dbo.Escalations
     WHERE SubjectType = @SubjectType AND SubjectId = @SubjectId AND PolicyKey = @PolicyKey
     ORDER BY EscalationId DESC`,
    [
      { name: "SubjectType", type: TYPES.NVarChar, value: escalation.subjectType },
      { name: "SubjectId", type: TYPES.NVarChar, value: escalation.subjectId },
      { name: "PolicyKey", type: TYPES.NVarChar, value: escalation.policyKey },
    ],
  );
  return rows.map(toEscalationRow).reverse();
}

/** Everyone active in AppUsers who has a role. A few dozen rows. */
export async function listActiveUsers(connection: Connection): Promise<DirectoryUser[]> {
  const rows = await executeQuery(
    connection,
    `SELECT UserID, DisplayName, Email, Role FROM dbo.AppUsers WHERE IsActive = 1 AND Role IS NOT NULL`,
  );
  return rows.map((row) => ({
    email: typeof row.Email === "string" && row.Email.trim() ? row.Email.trim() : null,
    name: String(row.DisplayName ?? row.Email ?? `User ${row.UserID}`),
    role: normaliseRole(row.Role),
    userId: Number(row.UserID),
  }));
}

export interface LatestEscalationTimes {
  /** Newest CreatedAt of any escalation for this subject and policy. */
  lastCreatedAt: Date;
  /** Newest time one of them ended (ResolvedAt), if any has. */
  lastEndedAt: Date | null;
}

/** For each subject of a type and each policy: when we last raised and last
 *  closed one. The sweep does not raise again what a person already closed. */
export async function latestTimesBySubject(
  connection: Connection,
  subjectType: string,
): Promise<Map<string, LatestEscalationTimes>> {
  const rows = await executeQuery(
    connection,
    `SELECT SubjectId, PolicyKey, MAX(CreatedAt) AS LastCreatedAt, MAX(ResolvedAt) AS LastEndedAt
     FROM dbo.Escalations
     WHERE SubjectType = @SubjectType
     GROUP BY SubjectId, PolicyKey`,
    [{ name: "SubjectType", type: TYPES.NVarChar, value: subjectType }],
  );
  const result = new Map<string, LatestEscalationTimes>();
  for (const row of rows) {
    result.set(latestKey(String(row.SubjectId), String(row.PolicyKey)), {
      lastCreatedAt: row.LastCreatedAt as Date,
      lastEndedAt: asDate(row.LastEndedAt),
    });
  }
  return result;
}

export const latestKey = (subjectId: string, policyKey: string): string => `${subjectId}\u0000${policyKey}`;

// ── Writes ───────────────────────────────────────────────────────────────────

export interface NewEscalation {
  buildingId: number | null;
  context: Record<string, unknown> | null;
  dueAt: Date | null;
  kind: EscalationKind;
  lastFollowUpAt?: Date | null;
  level: number;
  noIndependentTarget: boolean;
  note: string | null;
  notificationState: NotificationState;
  parentEscalationId: number | null;
  policyKey: string;
  raisedByKind: "user" | "system";
  raisedByName: string;
  raisedByUserId: number | null;
  reason: string | null;
  subjectId: string;
  subjectType: string;
  summary: string;
  targetRole: string | null;
  targetUserId: number | null;
  urgent: boolean;
}

/** Inserts a row as open and returns its id. */
export async function insertEscalation(connection: Connection, row: NewEscalation): Promise<number> {
  const rows = await executeQuery(
    connection,
    `INSERT INTO dbo.Escalations
       (SubjectType, SubjectId, BuildingId, Kind, Urgent, PolicyKey, [Level], TargetRole, TargetUserId,
        RaisedByUserId, RaisedByName, RaisedByKind, Reason, Note, Summary, Context, DueAt, Status,
        ParentEscalationId, NoIndependentTarget, NotificationState, LastFollowUpAt)
     OUTPUT INSERTED.EscalationId
     VALUES
       (@SubjectType, @SubjectId, @BuildingId, @Kind, @Urgent, @PolicyKey, @Level, @TargetRole, @TargetUserId,
        @RaisedByUserId, @RaisedByName, @RaisedByKind, @Reason, @Note, @Summary, @Context, @DueAt, 'open',
        @ParentEscalationId, @NoIndependentTarget, @NotificationState, @LastFollowUpAt)`,
    [
      { name: "SubjectType", type: TYPES.NVarChar, value: row.subjectType },
      { name: "SubjectId", type: TYPES.NVarChar, value: row.subjectId },
      { name: "BuildingId", type: TYPES.Int, value: row.buildingId },
      { name: "Kind", type: TYPES.NVarChar, value: row.kind },
      { name: "Urgent", type: TYPES.Bit, value: row.urgent },
      { name: "PolicyKey", type: TYPES.NVarChar, value: row.policyKey },
      { name: "Level", type: TYPES.Int, value: row.level },
      { name: "TargetRole", type: TYPES.NVarChar, value: row.targetRole },
      { name: "TargetUserId", type: TYPES.Int, value: row.targetUserId },
      { name: "RaisedByUserId", type: TYPES.Int, value: row.raisedByUserId },
      { name: "RaisedByName", type: TYPES.NVarChar, value: row.raisedByName },
      { name: "RaisedByKind", type: TYPES.NVarChar, value: row.raisedByKind },
      { name: "Reason", type: TYPES.NVarChar, value: row.reason },
      { name: "Note", type: TYPES.NVarChar, value: row.note },
      { name: "Summary", type: TYPES.NVarChar, value: row.summary },
      { name: "Context", type: TYPES.NVarChar, value: row.context ? JSON.stringify(row.context) : null },
      { name: "DueAt", type: TYPES.DateTime2, value: row.dueAt, options: { scale: 3 } },
      { name: "ParentEscalationId", type: TYPES.BigInt, value: row.parentEscalationId },
      { name: "NoIndependentTarget", type: TYPES.Bit, value: row.noIndependentTarget },
      { name: "NotificationState", type: TYPES.NVarChar, value: row.notificationState },
      { name: "LastFollowUpAt", type: TYPES.DateTime2, value: row.lastFollowUpAt ?? null, options: { scale: 3 } },
    ],
  );
  return Number(rows[0].EscalationId);
}

/** The columns a transition may change. Anything else is dropped by buildUpdateSet. */
const UPDATABLE = {
  AcknowledgedAt: TYPES.DateTime2,
  AcknowledgedByName: TYPES.NVarChar,
  AcknowledgedByUserId: TYPES.Int,
  DueAt: TYPES.DateTime2,
  ResolutionCode: TYPES.NVarChar,
  ResolutionNote: TYPES.NVarChar,
  ResolvedAt: TYPES.DateTime2,
  ResolvedByName: TYPES.NVarChar,
  ResolvedByUserId: TYPES.Int,
  Status: TYPES.NVarChar,
  TargetUserId: TYPES.Int,
} as const;

export type EscalationChanges = Partial<Record<keyof typeof UPDATABLE, unknown>>;

/** Applies a transition to a row we hold the lock on, if its version is still
 *  the one we read. Returns false when it isn't (someone else wrote first). */
export async function updateEscalation(
  connection: Connection,
  escalationId: number,
  expectedRowVersion: string,
  changes: EscalationChanges,
): Promise<boolean> {
  const update = buildUpdateSet(UPDATABLE, changes);
  if (!update) throw new Error("updateEscalation needs at least one change");
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.Escalations SET ${update.setClause}, UpdatedAt = SYSUTCDATETIME()
     OUTPUT INSERTED.EscalationId
     WHERE EscalationId = @EscalationId AND RowVersion = @RowVersion`,
    [
      { name: "EscalationId", type: TYPES.BigInt, value: escalationId },
      { name: "RowVersion", type: TYPES.Binary, value: rowVersionToBuffer(expectedRowVersion) },
      ...update.params,
    ],
  );
  return rows.length > 0;
}

export interface NotificationOutcome {
  attemptedAt: Date;
  error: string | null;
  notifiedAt: Date | null;
  state: NotificationState;
}

/** Records how a send went. Bookkeeping, not a decision: it does not check the
 *  row version, and a stale writer cannot undo a send that succeeded. */
export async function recordNotification(
  connection: Connection,
  escalationId: number,
  outcome: NotificationOutcome,
  attemptsMade: number,
): Promise<void> {
  await executeQuery(
    connection,
    `UPDATE dbo.Escalations
     SET NotificationState = @State,
         NotificationAttempts = NotificationAttempts + @Increment,
         LastNotificationError = @Error,
         LastNotificationAttemptAt = @AttemptedAt,
         LastNotifiedAt = COALESCE(@NotifiedAt, LastNotifiedAt),
         UpdatedAt = SYSUTCDATETIME()
     WHERE EscalationId = @EscalationId`,
    [
      { name: "EscalationId", type: TYPES.BigInt, value: escalationId },
      { name: "State", type: TYPES.NVarChar, value: outcome.state },
      { name: "Increment", type: TYPES.Int, value: attemptsMade },
      { name: "Error", type: TYPES.NVarChar, value: outcome.error ? outcome.error.slice(0, 500) : null },
      { name: "AttemptedAt", type: TYPES.DateTime2, value: outcome.attemptedAt, options: { scale: 3 } },
      { name: "NotifiedAt", type: TYPES.DateTime2, value: outcome.notifiedAt, options: { scale: 3 } },
    ],
  );
}

// ── The inbox ────────────────────────────────────────────────────────────────

export type ListView = "mine" | "raised" | "team" | "all" | "visible";
export type ListStatus = "active" | "open" | "closed" | "all";

export interface ListFilter {
  kind?: EscalationKind;
  /** One policy, by its exact key (job.manual). */
  policyKey?: string;
  /** A whole domain of policies: a prefix ending in "." (finance.). */
  policyKeyPrefix?: string;
  status: ListStatus;
  subjectId?: string;
  subjectType?: string;
  urgent?: boolean;
  view: ListView;
  viewer: Viewer;
}

const ORDER_ACTIVE = "ORDER BY e.Urgent DESC, CASE WHEN e.DueAt IS NULL THEN 1 ELSE 0 END, e.DueAt, e.EscalationId DESC";
const ORDER_OTHER = "ORDER BY e.UpdatedAt DESC, e.EscalationId DESC";

function rolePlaceholders(prefix: string, roles: readonly string[], params: SqlParam[]): string {
  return roles
    .map((role, index) => {
      params.push({ name: `${prefix}${index}`, type: TYPES.NVarChar, value: role });
      return `@${prefix}${index}`;
    })
    .join(", ");
}

/** The WHERE fragments for who sees what (PLAN §3.7 visibility): the targets,
 *  the raiser, and every role above the target. Director and admin see all. */
export function buildListWhere(filter: ListFilter): { params: SqlParam[]; whereSql: string } {
  const params: SqlParam[] = [];
  const parts: string[] = [];
  const { viewer } = filter;
  const roles = viewer.roles.map(normaliseRole).filter(Boolean);
  const userId = viewer.userId ?? -1;
  params.push({ name: "ViewerUserId", type: TYPES.Int, value: userId });

  // A level of several named people (a decision request's) puts no role on the
  // row, so the people it is for are the userTargets in its context. It stays true
  // when one of them has acknowledged it. Mirrors decisionRows.namedTargetIds.
  const namedForMe = `(e.TargetRole IS NULL AND e.NoIndependentTarget = 0 AND EXISTS (
      SELECT 1 FROM OPENJSON(ISNULL(e.Context, N'{}'), N'$.userTargets') t WHERE TRY_CONVERT(INT, t.[value]) = @ViewerUserId))`;
  // "For me": named for me, or aimed at my role and not yet named for someone
  // else. An escalation flagged NoIndependentTarget is for every director and
  // admin: nobody independent has it, so they all should.
  const mine = (): string => {
    const placeholders = rolePlaceholders("MineRole", roles.length ? roles : [""], params);
    const oversight = roles.some((role) => role === "director" || role === "admin") ? " OR e.NoIndependentTarget = 1" : "";
    return `(e.TargetUserId = @ViewerUserId OR (e.TargetUserId IS NULL AND e.TargetRole IN (${placeholders}))${oversight} OR ${namedForMe})`;
  };
  // Everything aimed at my role, whoever it is named for: colleagues cover for each other.
  const myRole = (): string => {
    const placeholders = rolePlaceholders("OwnRole", roles.length ? roles : [""], params);
    return `(e.TargetUserId = @ViewerUserId OR e.TargetRole IN (${placeholders}) OR ${namedForMe})`;
  };
  const raised = (): string => "e.RaisedByUserId = @ViewerUserId";
  // Policy domains the viewer oversees in full (the CFO's finance. alerts),
  // whoever they go to. The prefix is a constant of ours, escaped and bound like
  // the policyKey filter's; no request input reaches it.
  const seenPolicies = (): string[] =>
    seenPolicyPrefixesOfAll(roles).map((prefix, index) => {
      params.push({ name: `SeenPolicy${index}`, type: TYPES.NVarChar, value: `${escapeLike(prefix)}%` });
      return `e.PolicyKey LIKE @SeenPolicy${index} ESCAPE '\\'`;
    });
  const team = (): string | null => {
    const teamRoles = teamRolesOfAll(roles);
    if (teamRoles === null) return null; // everything
    const clauses: string[] = [];
    if (teamRoles.length > 0) {
      const placeholders = rolePlaceholders("TeamRole", teamRoles, params);
      clauses.push(
        `e.TargetRole IN (${placeholders})`,
        `e.RaisedByUserId IN (SELECT u.UserID FROM dbo.AppUsers u WHERE u.Role IN (${placeholders}))`,
      );
    }
    clauses.push(...seenPolicies());
    return clauses.length === 0 ? "1 = 0" : `(${clauses.join(" OR ")})`;
  };

  switch (filter.view) {
    case "mine":
      parts.push(mine());
      break;
    case "raised":
      parts.push(raised());
      break;
    case "team": {
      const clause = team();
      if (clause !== null) parts.push(clause);
      break;
    }
    case "visible": {
      const teamClause = team();
      // team() is null for director and admin, who see everything.
      if (teamClause !== null) parts.push(`(${myRole()} OR ${raised()} OR ${teamClause})`);
      break;
    }
    case "all":
      break;
  }

  if (filter.status === "active") parts.push(`e.${LIVE_SQL}`);
  else if (filter.status === "open") parts.push(`e.${OPEN_SQL}`);
  else if (filter.status === "closed") parts.push(`e.${CLOSED_SQL}`);

  if (filter.subjectType) {
    parts.push("e.SubjectType = @SubjectType");
    params.push({ name: "SubjectType", type: TYPES.NVarChar, value: filter.subjectType });
  }
  if (filter.subjectId) {
    parts.push("e.SubjectId = @SubjectId");
    params.push({ name: "SubjectId", type: TYPES.NVarChar, value: filter.subjectId });
  }
  if (filter.policyKey) {
    parts.push("e.PolicyKey = @PolicyKey");
    params.push({ name: "PolicyKey", type: TYPES.NVarChar, value: filter.policyKey });
  }
  if (filter.policyKeyPrefix) {
    // As the decision log does for an action prefix: policy keys are full of
    // underscores, which LIKE would read as "any one character", so the prefix
    // is escaped and the pattern is bound, never written into the SQL.
    parts.push("e.PolicyKey LIKE @PolicyKeyPrefix ESCAPE '\\'");
    params.push({ name: "PolicyKeyPrefix", type: TYPES.NVarChar, value: `${escapeLike(filter.policyKeyPrefix)}%` });
  }
  if (filter.kind) {
    parts.push("e.Kind = @Kind");
    params.push({ name: "Kind", type: TYPES.NVarChar, value: filter.kind });
  }
  if (filter.urgent !== undefined) {
    parts.push("e.Urgent = @Urgent");
    params.push({ name: "Urgent", type: TYPES.Bit, value: filter.urgent });
  }

  return { params, whereSql: parts.length > 0 ? `WHERE ${parts.join(" AND ")}` : "" };
}

export async function listEscalations(
  connection: Connection,
  filter: ListFilter,
  pagination: PaginationParams,
): Promise<{ rows: EscalationRow[]; total: number }> {
  const { params, whereSql } = buildListWhere(filter);
  const ORDER_BY = filter.status === "active" || filter.status === "open" ? ORDER_ACTIVE : ORDER_OTHER;
  const topClause = pagination.active ? "" : `TOP ${pagination.limit} `;

  const rows = await executeQuery(
    connection,
    `SELECT ${topClause}${ESCALATION_COLUMNS_E} FROM dbo.Escalations e ${whereSql} ${ORDER_BY}${paginationSqlSuffix(pagination)}`,
    params,
  );
  const counted = await executeQuery(connection, `SELECT COUNT(*) AS Total FROM dbo.Escalations e ${whereSql}`, params);
  return { rows: rows.map(toEscalationRow), total: Number(counted[0]?.Total ?? rows.length) };
}

// The same column list with the table alias, for the aliased inbox query.
const ESCALATION_COLUMNS_E = ESCALATION_COLUMNS.split(",")
  .map((column) => `e.${column.trim()}`)
  .join(", ");
