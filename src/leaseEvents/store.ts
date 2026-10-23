// SQL for lease events (WP32, WP33). Every statement is parameterised. A writer
// holds an update lock on the event row and on the tenancy row, checks the
// Version the caller read, writes and ledgers, all in one transaction; a move
// names the state(s) it comes from, so an event that moved on underneath is
// refused rather than overwritten.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "../db";
import {
  type LeaseEventState,
  type LeaseEventType,
  OPEN_LEASE_EVENT_STATES,
  type RenewalOutcome,
} from "../leaseEventMachine";
import { RESOLVED_REVIEW_DATES_SQL } from "../nextReviewDate";
import { SIGN_OFF_COLUMNS } from "../scheduleSignOff";

const EVENT_COLUMNS = `
  e.LeaseEventId, e.TenantId, e.BuildingId, e.Type, e.State, e.LeaseExpiry, e.WindowOpensOn, e.DeadlineOn,
  e.NoticeDate, e.NoticeDocument, e.LateNotice, e.Terms,
  e.RecordedById, e.RecordedByName, e.RecordedAt, e.DecidedById, e.DecidedByName, e.DecidedAt,
  e.Outcome, e.OutcomeDetails, e.OutcomeReason, e.CreatedAt, e.UpdatedAt, e.Version,
  t.LegalName, t.TradingName, t.Status AS TenantStatus, t.ArchivedAt AS TenantArchivedAt, t.IsTest AS TenantIsTest`;

const OPEN_LIST = OPEN_LEASE_EVENT_STATES.map((state) => `'${state}'`).join(", ");

/** The most events one tenancy's list returns (a lease has a handful a decade). */
export const EVENT_LIST_LIMIT = 200;

export async function loadEventsForTenancy(connection: Connection, tenantId: number): Promise<SqlRow[]> {
  return executeQuery(
    connection,
    `SELECT TOP (@Limit) ${EVENT_COLUMNS}
     FROM dbo.LeaseEvents e INNER JOIN dbo.Tenants t ON t.TenantId = e.TenantId
     WHERE e.TenantId = @TenantId AND e.ArchivedAt IS NULL
     ORDER BY e.CreatedAt DESC`,
    [
      { name: "TenantId", type: TYPES.Int, value: tenantId },
      { name: "Limit", type: TYPES.Int, value: EVENT_LIST_LIMIT },
    ],
  );
}

export async function loadEvent(connection: Connection, leaseEventId: string): Promise<SqlRow | null> {
  const rows = await executeQuery(
    connection,
    `SELECT ${EVENT_COLUMNS}
     FROM dbo.LeaseEvents e INNER JOIN dbo.Tenants t ON t.TenantId = e.TenantId
     WHERE e.LeaseEventId = @LeaseEventId`,
    [{ name: "LeaseEventId", type: TYPES.NVarChar, value: leaseEventId }],
  );
  return rows[0] ?? null;
}

/** The event, locked for the rest of the transaction. */
export async function eventForUpdate(connection: Connection, leaseEventId: string): Promise<SqlRow | null> {
  const rows = await executeQuery(
    connection,
    `SELECT ${EVENT_COLUMNS}
     FROM dbo.LeaseEvents e WITH (UPDLOCK, ROWLOCK) INNER JOIN dbo.Tenants t ON t.TenantId = e.TenantId
     WHERE e.LeaseEventId = @LeaseEventId`,
    [{ name: "LeaseEventId", type: TYPES.NVarChar, value: leaseEventId }],
  );
  return rows[0] ?? null;
}

/** The tenancy's open event of `type`, locked; null when it has none. */
export async function openEventForUpdate(connection: Connection, tenantId: number, type: LeaseEventType): Promise<SqlRow | null> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP 1 ${EVENT_COLUMNS}
     FROM dbo.LeaseEvents e WITH (UPDLOCK, ROWLOCK) INNER JOIN dbo.Tenants t ON t.TenantId = e.TenantId
     WHERE e.TenantId = @TenantId AND e.Type = @Type AND e.State IN (${OPEN_LIST})`,
    [
      { name: "TenantId", type: TYPES.Int, value: tenantId },
      { name: "Type", type: TYPES.NVarChar, value: type },
    ],
  );
  return rows[0] ?? null;
}

/** The option event that lapsed for this expiry, locked: a late notice is recorded against it. */
export async function lapsedOptionForUpdate(connection: Connection, tenantId: number, leaseExpiry: string): Promise<SqlRow | null> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP 1 ${EVENT_COLUMNS}
     FROM dbo.LeaseEvents e WITH (UPDLOCK, ROWLOCK) INNER JOIN dbo.Tenants t ON t.TenantId = e.TenantId
     WHERE e.TenantId = @TenantId AND e.Type = 'option_exercise' AND e.State = 'lapsed' AND e.LeaseExpiry = @LeaseExpiry
     ORDER BY e.CreatedAt DESC`,
    [
      { name: "TenantId", type: TYPES.Int, value: tenantId },
      { name: "LeaseExpiry", type: TYPES.Date, value: leaseExpiry },
    ],
  );
  return rows[0] ?? null;
}

const TENANCY_COLUMNS = `t.TenantId, t.BuildingId, t.LegalName, t.TradingName, t.Status, t.ArchivedAt, t.IsTest,
    t.Commencement, t.Expiry, t.OptionPeriods, t.OptionNoticeMonths, t.OptionsTotal, t.OptionsRemaining, t.OptionTermMonths,
    t.ReviewType, t.ReviewIntervalMonths, t.FixedReviewPercent, t.LastReviewDate, t.NextReviewDate, t.RentPerAnnum,
    t.ScheduleVersion, t.ScheduledRateSteps, t.HoldoverTerms, t.UpdatedAt, b.BuildingName,
    ${SIGN_OFF_COLUMNS.split(", ").map((column) => `t.${column}`).join(", ")},
    ${RESOLVED_REVIEW_DATES_SQL}`;

/** The tenancy a lease event is decided on. */
export async function loadTenancyForEvent(connection: Connection, tenantId: number): Promise<SqlRow | null> {
  const rows = await executeQuery(
    connection,
    `SELECT ${TENANCY_COLUMNS} FROM dbo.Tenants t LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingId WHERE t.TenantId = @TenantId`,
    [{ name: "TenantId", type: TYPES.Int, value: tenantId }],
  );
  return rows[0] ?? null;
}

/** The tenancy, locked for the rest of the transaction (PLAN §3.5 APPLY). */
export async function lockTenancyForEvent(connection: Connection, tenantId: number): Promise<SqlRow | null> {
  const rows = await executeQuery(
    connection,
    `SELECT ${TENANCY_COLUMNS} FROM dbo.Tenants t WITH (UPDLOCK, ROWLOCK) LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingId
     WHERE t.TenantId = @TenantId`,
    [{ name: "TenantId", type: TYPES.Int, value: tenantId }],
  );
  return rows[0] ?? null;
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface NewLeaseEvent {
  buildingId: number | null;
  deadlineOn: string | null;
  leaseEventId: string;
  leaseExpiry: string | null;
  state: LeaseEventState;
  tenantId: number;
  type: LeaseEventType;
  windowOpensOn: string | null;
}

/** OPEN_OPTION / REFER_RENEWAL: a new event. The filtered unique index refuses a
 *  second open event of the type for the tenancy (2601/2627). */
export async function insertEvent(connection: Connection, event: NewLeaseEvent): Promise<void> {
  await executeQuery(
    connection,
    `INSERT INTO dbo.LeaseEvents (LeaseEventId, TenantId, BuildingId, Type, State, LeaseExpiry, WindowOpensOn, DeadlineOn)
     VALUES (@LeaseEventId, @TenantId, @BuildingId, @Type, @State, @LeaseExpiry, @WindowOpensOn, @DeadlineOn)`,
    [
      { name: "LeaseEventId", type: TYPES.NVarChar, value: event.leaseEventId },
      { name: "TenantId", type: TYPES.Int, value: event.tenantId },
      { name: "BuildingId", type: TYPES.Int, value: event.buildingId },
      { name: "Type", type: TYPES.NVarChar, value: event.type },
      { name: "State", type: TYPES.NVarChar, value: event.state },
      { name: "LeaseExpiry", type: TYPES.Date, value: event.leaseExpiry },
      { name: "WindowOpensOn", type: TYPES.Date, value: event.windowOpensOn },
      { name: "DeadlineOn", type: TYPES.Date, value: event.deadlineOn },
    ],
  );
}

/** Moves one event from one of `from` to `to`, setting `setClause` too. False when it had moved on. */
export async function moveEvent(
  connection: Connection,
  leaseEventId: string,
  from: readonly LeaseEventState[],
  to: LeaseEventState,
  setClause = "",
  params: SqlParam[] = [],
): Promise<boolean> {
  const placeholders = from.map((_, index) => `@From${index}`).join(", ");
  const updateSet = ["State = @To", ...(setClause ? [setClause] : []), "UpdatedAt = SYSUTCDATETIME()"].join(", ");
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.LeaseEvents
       SET ${updateSet}
     OUTPUT INSERTED.LeaseEventId
     WHERE LeaseEventId = @LeaseEventId AND State IN (${placeholders})`,
    [
      { name: "LeaseEventId", type: TYPES.NVarChar, value: leaseEventId },
      { name: "To", type: TYPES.NVarChar, value: to },
      ...from.map((state, index) => ({ name: `From${index}`, type: TYPES.NVarChar, value: state })),
      ...params,
    ],
  );
  return rows.length > 0;
}

export interface Person {
  name: string;
  userId: number | null;
}

export interface RecordedNotice {
  lateNotice: boolean;
  noticeDate: string;
  noticeDocument: string | null;
  recorder: Person;
  termsJson: string;
}

/** RECORD_NOTICE: the notice, who recorded it and the term it asks for. A late notice on a
 *  lapsed event reopens it, so the lapse's outcome is cleared (the ledger keeps it). */
export async function markNoticeRecorded(
  connection: Connection,
  leaseEventId: string,
  from: LeaseEventState,
  to: LeaseEventState,
  notice: RecordedNotice,
): Promise<boolean> {
  return moveEvent(
    connection,
    leaseEventId,
    [from],
    to,
    `NoticeDate = @NoticeDate, NoticeDocument = @NoticeDocument, LateNotice = @LateNotice, Terms = @Terms,
     RecordedById = @RecordedById, RecordedByName = @RecordedByName, RecordedAt = SYSUTCDATETIME(),
     Outcome = NULL, DecidedById = NULL, DecidedByName = NULL, DecidedAt = NULL`,
    [
      { name: "NoticeDate", type: TYPES.Date, value: notice.noticeDate },
      { name: "NoticeDocument", type: TYPES.NVarChar, value: notice.noticeDocument },
      { name: "LateNotice", type: TYPES.Bit, value: notice.lateNotice },
      { name: "Terms", type: TYPES.NVarChar, value: notice.termsJson },
      { name: "RecordedById", type: TYPES.Int, value: notice.recorder.userId },
      { name: "RecordedByName", type: TYPES.NVarChar, value: notice.recorder.name },
    ],
  );
}

export type DecidedOutcome = "cancelled" | "exercised" | "lapsed" | "rejected" | RenewalOutcome;

/** A decision that closes the event: who decided, what, why, and its details. */
export async function markDecided(
  connection: Connection,
  leaseEventId: string,
  from: readonly LeaseEventState[],
  to: LeaseEventState,
  decision: { decider: Person | null; details: Record<string, unknown> | null; outcome: DecidedOutcome; reason: string | null },
): Promise<boolean> {
  return moveEvent(
    connection,
    leaseEventId,
    from,
    to,
    `Outcome = @Outcome, OutcomeDetails = @OutcomeDetails, OutcomeReason = @OutcomeReason,
     DecidedById = @DecidedById, DecidedByName = @DecidedByName, DecidedAt = SYSUTCDATETIME()`,
    [
      { name: "Outcome", type: TYPES.NVarChar, value: decision.outcome },
      { name: "OutcomeDetails", type: TYPES.NVarChar, value: decision.details === null ? null : JSON.stringify(decision.details) },
      { name: "OutcomeReason", type: TYPES.NVarChar, value: decision.reason },
      { name: "DecidedById", type: TYPES.Int, value: decision.decider?.userId ?? null },
      { name: "DecidedByName", type: TYPES.NVarChar, value: decision.decider?.name ?? null },
    ],
  );
}

/** The tenancy's open rent review, locked (one at most: UX_RentReviews_OpenPerTenant). */
export async function openReviewForUpdate(connection: Connection, tenantId: number): Promise<SqlRow | null> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP 1 ReviewId, ScheduledFor, State, Method FROM dbo.RentReviews WITH (UPDLOCK, ROWLOCK)
     WHERE TenantId = @TenantId AND State IN ('scheduled', 'due', 'in_progress', 'awaiting_index', 'referred', 'awaiting_approval')`,
    [{ name: "TenantId", type: TYPES.Int, value: tenantId }],
  );
  return rows[0] ?? null;
}
