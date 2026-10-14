// Per-tenancy schedule sign-off (PLAN WP24, migration 097). An accounts manager,
// the CFO or a director signs a tenancy's schedule off as verified against the
// lease. A manual edit to the schedule clears it again, and says why: the
// writer must supply a reason when the tenancy is signed off, and the clearing
// is its own ledger entry (schedule.sign_off_cleared) in the edit's transaction.

import type { HttpResponseInit } from "@azure/functions";
import { Connection, TYPES } from "tedious";
import { AppRole } from "./auth";
import { executeQuery, SqlRow } from "./db";
import * as ledger from "./ledger";
import type { LedgerActor } from "./ledger";

/** Who may sign a schedule off or revoke it (admin passes every role gate). */
export const SIGN_OFF_ROLES = [AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR] as const;

/** Appended to the SELECT of any statement that locks a tenant row for a schedule write. */
export const SIGN_OFF_COLUMNS =
  "ScheduleSignedOffAt, ScheduleSignedOffById, ScheduleSignedOffByName, ScheduleSignOffNote";

export const CLEAR_SIGN_OFF_SQL =
  "ScheduleSignedOffAt = NULL, ScheduleSignedOffById = NULL, ScheduleSignedOffByName = NULL, ScheduleSignOffNote = NULL";

export const MAX_SIGN_OFF_TEXT = 500;

export interface ScheduleSignOff {
  at: string;
  by: string;
  note: string | null;
}

/** The current sign-off on a tenant row, or null when it is not signed off. */
export function scheduleSignOffFromRow(row: SqlRow): ScheduleSignOff | null {
  const at = row.ScheduleSignedOffAt;
  if (!at) return null;
  const when = at instanceof Date ? at : new Date(String(at));
  if (Number.isNaN(when.getTime())) return null;
  return {
    at: when.toISOString(),
    by: (row.ScheduleSignedOffByName as string | null) ?? "someone",
    note: (row.ScheduleSignOffNote as string | null) ?? null,
  };
}

/** A free-text field from a request body: trimmed, or null when blank or not text. */
export function readSignOffText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text === "" ? null : text.slice(0, MAX_SIGN_OFF_TEXT);
}

/** Why the writer is editing a signed-off schedule (body.SignOffClearReason). */
export function readSignOffClearReason(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  return readSignOffText((body as Record<string, unknown>).SignOffClearReason);
}

/**
 * 409 for an edit to a signed-off schedule that gave no reason. The client
 * asks the person why, then sends the same request again with
 * `SignOffClearReason`.
 */
export function signOffReasonRequiredResponse(signOff: ScheduleSignOff): HttpResponseInit {
  return {
    status: 409,
    jsonBody: {
      code: "SIGN_OFF_REASON_REQUIRED",
      error: `This schedule was signed off by ${signOff.by}. Editing it clears the sign-off, so say why you are changing it.`,
      signOff,
    },
  };
}

/** What each schedule column is called when the ledger says what an edit touched. */
const COLUMN_LABEL: Record<string, string> = {
  CarparkScheduleGroups: "car park schedule",
  Incentives: "incentives",
  MiscFees: "misc fees",
  ScheduledRateSteps: "rent schedule",
  tenant: "schedule terms",
};

/**
 * Ledgers the clearing of a sign-off, inside the edit's own transaction. The
 * edit's UPDATE clears the columns itself (CLEAR_SIGN_OFF_SQL in its SET list),
 * so the RowVersion it returns is the final one. The caller has already checked
 * a reason was given.
 */
export async function recordSignOffCleared(
  connection: Connection,
  scope: { actor: LedgerActor; buildingId: number; correlationId: string; tenantId: number },
  prior: ScheduleSignOff,
  reason: string,
  touched: string,
): Promise<void> {
  await ledger.record(connection, {
    action: "schedule.sign_off_cleared",
    actor: scope.actor,
    after: { edited: COLUMN_LABEL[touched] ?? touched, signOff: null },
    before: { signOff: prior },
    buildingId: scope.buildingId,
    correlationId: scope.correlationId,
    reason,
    subject: { id: scope.tenantId, type: "tenancy" },
    tenantId: scope.tenantId,
  });
}

/** A tenant row locked for a sign-off change, or why the request cannot go on. */
export type LockedTenant =
  | { kind: "ok"; row: SqlRow; signOff: ScheduleSignOff | null }
  | { kind: "refused"; response: HttpResponseInit };

/** The tenant id (and optional building id) a sign-off request names, or null when it is not a whole number. */
export function readTenantKey(body: unknown): { buildingId: number | undefined; tenantId: number } | null {
  if (typeof body !== "object" || body === null) return null;
  const { BuildingId, TenantId } = body as Record<string, unknown>;
  if (typeof TenantId !== "number" || !Number.isInteger(TenantId) || TenantId < 1) return null;
  if (BuildingId !== undefined && (typeof BuildingId !== "number" || !Number.isInteger(BuildingId))) return null;
  return { buildingId: BuildingId as number | undefined, tenantId: TenantId };
}

/** Locks the tenant row inside the caller's transaction. */
export async function lockTenantForSignOff(
  connection: Connection,
  key: { buildingId: number | undefined; tenantId: number },
): Promise<LockedTenant> {
  const rows = await executeQuery(
    connection,
    `SELECT TenantId, BuildingId, Status, ScheduleVersion, UpdatedAt, UpdatedByName, ${SIGN_OFF_COLUMNS}
       FROM dbo.Tenants WITH (UPDLOCK, ROWLOCK)
      WHERE TenantId = @TenantId`,
    [{ name: "TenantId", type: TYPES.Int, value: key.tenantId }],
  );
  const row = rows[0];
  if (!row || (key.buildingId !== undefined && row.BuildingId !== key.buildingId)) {
    return {
      kind: "refused",
      response: { status: 404, jsonBody: { error: "Tenant not found for the given BuildingId" } },
    };
  }
  return { kind: "ok", row, signOff: scheduleSignOffFromRow(row) };
}
