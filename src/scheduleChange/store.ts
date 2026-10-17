// SQL for pending schedule changes (migration 099). Every statement is
// parameterised. A writer holds an update lock on what it changes and checks the
// Version the caller read, in one transaction with its ledger row.
//
// Lock order, so two decisions can't deadlock: the tenancy first (a request and
// a ratification both change what the tenancy's schedule holds), then the
// request. Rejecting and withdrawing touch only the request.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "../db";
import { SIGN_OFF_COLUMNS } from "../scheduleSignOff";
import type { ScheduleChangeKind, ScheduleChangeState } from "./types";

/** The most rows a list returns. */
export const CHANGE_LIST_LIMIT = 1000;

const CHANGE_COLUMNS = `c.RequestId, c.TenantId, c.Kind, c.Payload, c.Reason, c.State,
  c.RequestedById, c.RequestedByName, c.RequestedAt, c.DecidedById, c.DecidedByName, c.DecidedAt,
  c.DecisionNote, c.Version, t.BuildingId, t.LegalName, t.TradingName`;

const CHANGE_BY_ID = `SELECT ${CHANGE_COLUMNS}
  FROM dbo.ScheduleChangeRequests c INNER JOIN dbo.Tenants t ON t.TenantId = c.TenantId
  WHERE c.RequestId = @RequestId`;

const CHANGE_BY_ID_FOR_UPDATE = `SELECT ${CHANGE_COLUMNS}
  FROM dbo.ScheduleChangeRequests c WITH (UPDLOCK, ROWLOCK) INNER JOIN dbo.Tenants t ON t.TenantId = c.TenantId
  WHERE c.RequestId = @RequestId`;

const idParam = (requestId: string): SqlParam[] => [{ name: "RequestId", type: TYPES.NVarChar, value: requestId }];

export async function loadChange(connection: Connection, requestId: string): Promise<SqlRow | null> {
  return (await executeQuery(connection, CHANGE_BY_ID, idParam(requestId)))[0] ?? null;
}

/** The request, locked for the rest of the transaction. */
export async function changeForUpdate(connection: Connection, requestId: string): Promise<SqlRow | null> {
  return (await executeQuery(connection, CHANGE_BY_ID_FOR_UPDATE, idParam(requestId)))[0] ?? null;
}

export interface ChangeFilters {
  states?: readonly ScheduleChangeState[];
  tenantId?: number;
}

/** Requests matching every filter given, newest first. */
export async function loadChanges(connection: Connection, filters: ChangeFilters): Promise<SqlRow[]> {
  const where: string[] = [];
  const params: SqlParam[] = [{ name: "Limit", type: TYPES.Int, value: CHANGE_LIST_LIMIT }];
  if (filters.tenantId !== undefined) {
    where.push("c.TenantId = @TenantId");
    params.push({ name: "TenantId", type: TYPES.Int, value: filters.tenantId });
  }
  if (filters.states && filters.states.length > 0) {
    where.push(`c.State IN (${filters.states.map((_, index) => `@State${index}`).join(", ")})`);
    filters.states.forEach((state, index) => params.push({ name: `State${index}`, type: TYPES.NVarChar, value: state }));
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  return executeQuery(
    connection,
    `SELECT TOP (@Limit) ${CHANGE_COLUMNS}
     FROM dbo.ScheduleChangeRequests c INNER JOIN dbo.Tenants t ON t.TenantId = c.TenantId
     ${whereSql}
     ORDER BY c.RequestedAt DESC, c.RequestId`,
    params,
  );
}

/** The tenancy's other relief requests still waiting for a director (the overlap check). */
export async function pendingReliefsOf(connection: Connection, tenantId: number): Promise<SqlRow[]> {
  return executeQuery(
    connection,
    `SELECT c.RequestId, c.Payload FROM dbo.ScheduleChangeRequests c
     WHERE c.TenantId = @TenantId AND c.State = N'pending' AND c.Kind = N'relief'`,
    [{ name: "TenantId", type: TYPES.Int, value: tenantId }],
  );
}

export interface NewChange {
  kind: ScheduleChangeKind;
  payload: Record<string, unknown>;
  reason: string;
  requestedBy: { name: string; userId: number | null };
  requestId: string;
  tenantId: number;
}

export async function insertChange(connection: Connection, change: NewChange): Promise<void> {
  await executeQuery(
    connection,
    `INSERT INTO dbo.ScheduleChangeRequests (RequestId, TenantId, Kind, Payload, Reason, State, RequestedById, RequestedByName)
     VALUES (@RequestId, @TenantId, @Kind, @Payload, @Reason, N'pending', @RequestedById, @RequestedByName)`,
    [
      { name: "RequestId", type: TYPES.NVarChar, value: change.requestId },
      { name: "TenantId", type: TYPES.Int, value: change.tenantId },
      { name: "Kind", type: TYPES.NVarChar, value: change.kind },
      { name: "Payload", type: TYPES.NVarChar, value: JSON.stringify(change.payload) },
      { name: "Reason", type: TYPES.NVarChar, value: change.reason },
      { name: "RequestedById", type: TYPES.Int, value: change.requestedBy.userId },
      { name: "RequestedByName", type: TYPES.NVarChar, value: change.requestedBy.name },
    ],
  );
}

export interface Decision {
  by: { name: string; userId: number | null };
  note: string | null;
  state: Exclude<ScheduleChangeState, "pending">;
}

/** pending -> ratified | rejected | withdrawn, only while it is still pending. True when it moved. */
export async function markDecided(connection: Connection, requestId: string, decision: Decision): Promise<boolean> {
  const moved = await executeQuery(
    connection,
    `UPDATE dbo.ScheduleChangeRequests
       SET State = @State, DecidedById = @DecidedById, DecidedByName = @DecidedByName,
           DecidedAt = SYSUTCDATETIME(), DecisionNote = @DecisionNote
     OUTPUT INSERTED.RequestId
     WHERE RequestId = @RequestId AND State = N'pending'`,
    [
      ...idParam(requestId),
      { name: "State", type: TYPES.NVarChar, value: decision.state },
      { name: "DecidedById", type: TYPES.Int, value: decision.by.userId },
      { name: "DecidedByName", type: TYPES.NVarChar, value: decision.by.name },
      { name: "DecisionNote", type: TYPES.NVarChar, value: decision.note },
    ],
  );
  return moved.length > 0;
}

const TENANCY_FOR_CHANGE = `SELECT t.TenantId, t.BuildingId, t.LegalName, t.TradingName, t.Status, t.ArchivedAt,
    t.ScheduleVersion, t.RentPerAnnum, t.ScheduledRateSteps, t.CarparkScheduleGroups, t.MiscFees, t.RentReliefs,
    t.CpiCapPercent, t.CpiFloorPercent, t.ReviewRatchet, t.UpdatedAt, t.UpdatedByName,
    ${SIGN_OFF_COLUMNS}
  FROM dbo.Tenants t WITH (UPDLOCK, ROWLOCK)
  WHERE t.TenantId = @TenantId`;

/** The tenancy a change is about, locked for the rest of the transaction. */
export async function lockTenancyForChange(connection: Connection, tenantId: number): Promise<SqlRow | null> {
  return (await executeQuery(connection, TENANCY_FOR_CHANGE, [{ name: "TenantId", type: TYPES.Int, value: tenantId }]))[0] ?? null;
}

/** The ratified reliefs written onto the schedule: ScheduleVersion + 1 (a review
 *  calculated before is stale, C4) and who changed it; the sign-off is kept (D7:
 *  a ratified change is a decision on the verified schedule, not a manual edit
 *  of it). Returns the new ScheduleVersion. */
export async function writeReliefs(
  connection: Connection,
  write: { actorName: string; actorOid: string; reliefsJson: string; tenantId: number },
): Promise<number> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.Tenants SET RentReliefs = @RentReliefs,
           ScheduleVersion = ScheduleVersion + 1,
           UpdatedAt = SYSUTCDATETIME(),
           UpdatedById = @UpdatedById,
           UpdatedByName = @UpdatedByName
     OUTPUT INSERTED.ScheduleVersion
     WHERE TenantId = @TenantId`,
    [
      { name: "TenantId", type: TYPES.Int, value: write.tenantId },
      { name: "RentReliefs", type: TYPES.NVarChar, value: write.reliefsJson },
      { name: "UpdatedById", type: TYPES.NVarChar, value: write.actorOid },
      { name: "UpdatedByName", type: TYPES.NVarChar, value: write.actorName },
    ],
  );
  return Number(rows[0]?.ScheduleVersion);
}
