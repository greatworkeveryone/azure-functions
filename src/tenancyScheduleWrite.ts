// One schedule write (rate steps, car park groups, misc fees or incentives) for
// one tenancy, as one transaction (PLAN WP23a, F15): update-lock the tenant
// row, check the ScheduleVersion the caller read, apply the change, bump the
// version, write the change log and ledger rows, commit — or roll it all back.
// "No ledger row, no decision": a failed ledger write undoes the edit.

import { HttpResponseInit } from "@azure/functions";
import { Connection, TYPES } from "tedious";
import {
  beginTransaction,
  commitTransaction,
  executeQuery,
  rollbackTransaction,
  SqlRow,
} from "./db";
import * as ledger from "./ledger";
import type { LedgerActor, LedgerEntryInput } from "./ledger";

/** The JSON columns a schedule write may replace. Keys are SQL column names. */
export const SCHEDULE_JSON_COLUMNS = [
  "ScheduledRateSteps",
  "CarparkScheduleGroups",
  "MiscFees",
  "Incentives",
] as const;
export type ScheduleJsonColumn = (typeof SCHEDULE_JSON_COLUMNS)[number];

const LOCKED_COLUMNS = `
  TenantId, BuildingId, ScheduleVersion, RowVersion, UpdatedByName, UpdatedAt,
  Commencement, LastReviewDate, ReviewIntervalMonths, NextReviewDate,
  ScheduledRateSteps, CarparkScheduleGroups, MiscFees, Incentives
`;

export interface ScheduleConflict {
  changedAt: string | null;
  changedBy: string | null;
  scheduleVersion: number;
}

export type LedgerDraft = Omit<LedgerEntryInput, "actor" | "buildingId" | "correlationId" | "tenantId">;

export type ScheduleMutation<T> =
  | {
      afterUpdate?: (connection: Connection) => Promise<void>;
      column: ScheduleJsonColumn;
      kind: "write";
      ledgerEntries: LedgerDraft[];
      result: T;
      value: unknown;
    }
  | { error: string; kind: "reject"; status: number };

export type ScheduleWriteOutcome<T> =
  | { conflict: ScheduleConflict; kind: "conflict" }
  | { error: string; kind: "rejected"; status: number }
  | { kind: "notFound" }
  | { kind: "ok"; result: T; rowVersion: string; scheduleVersion: number };

export interface ScheduleWriteTarget {
  actor: LedgerActor;
  buildingId: number;
  /** The ScheduleVersion the caller read; undefined skips the check (legacy callers). */
  expectedVersion: number | undefined;
  tenantId: number;
  updatedById: string;
}

export function rowVersionHex(value: unknown): string {
  return Buffer.isBuffer(value) ? value.toString("hex") : "";
}

export function isoTimestamp(value: unknown): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Parses the optional ScheduleVersion a client sent: undefined when absent,
 *  null when present but not a non-negative integer. */
export function parseExpectedVersion(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined;
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 0 ? raw : null;
}

/** 409 for a stale write: names who changed the tenancy so the client can say
 *  so when it reloads. */
export function conflictResponse(
  conflict: { changedAt: string | null; changedBy: string | null },
  extra: Record<string, unknown> = {},
): HttpResponseInit {
  const who = conflict.changedBy?.trim() || "someone else";
  return {
    status: 409,
    jsonBody: {
      conflict: { ...conflict, ...extra },
      error: `This tenancy was changed by ${who} since you opened it. Reload to see their change.`,
    },
  };
}

/** Maps a schedule write outcome to the HTTP response; `ok` merges the new
 *  versions into the handler's body so the client can carry them forward. */
export function scheduleWriteResponse<T>(
  outcome: ScheduleWriteOutcome<T>,
  body: (result: T) => Record<string, unknown>,
): HttpResponseInit {
  switch (outcome.kind) {
    case "notFound":
      return { status: 404, jsonBody: { error: "Tenant not found for the given BuildingId" } };
    case "conflict":
      return conflictResponse(outcome.conflict, { scheduleVersion: outcome.conflict.scheduleVersion });
    case "rejected":
      return { status: outcome.status, jsonBody: { error: outcome.error } };
    case "ok":
      return {
        status: 200,
        jsonBody: {
          ...body(outcome.result),
          rowVersion: outcome.rowVersion,
          scheduleVersion: outcome.scheduleVersion,
        },
      };
  }
}

/** Rolls back, ignoring a server that already rolled the transaction back. */
export async function rollbackQuietly(connection: Connection): Promise<void> {
  try {
    await rollbackTransaction(connection);
  } catch {
    // The server already rolled back (e.g. a failed statement aborted it).
  }
}

export async function runScheduleWrite<T>(
  connection: Connection,
  target: ScheduleWriteTarget,
  mutate: (locked: SqlRow) => ScheduleMutation<T> | Promise<ScheduleMutation<T>>,
): Promise<ScheduleWriteOutcome<T>> {
  const keyParams = [
    { name: "TenantId", type: TYPES.Int, value: target.tenantId },
    { name: "BuildingId", type: TYPES.Int, value: target.buildingId },
  ];
  await beginTransaction(connection);
  try {
    const rows = await executeQuery(
      connection,
      `SELECT ${LOCKED_COLUMNS} FROM dbo.Tenants WITH (UPDLOCK, ROWLOCK)
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      keyParams,
    );
    if (rows.length === 0) {
      await rollbackQuietly(connection);
      return { kind: "notFound" };
    }
    const locked = rows[0];
    const currentVersion = Number(locked.ScheduleVersion ?? 0);
    if (target.expectedVersion !== undefined && target.expectedVersion !== currentVersion) {
      await rollbackQuietly(connection);
      return {
        conflict: {
          changedAt: isoTimestamp(locked.UpdatedAt),
          changedBy: (locked.UpdatedByName as string | null) ?? null,
          scheduleVersion: currentVersion,
        },
        kind: "conflict",
      };
    }

    const mutation = await mutate(locked);
    if (mutation.kind === "reject") {
      await rollbackQuietly(connection);
      return { error: mutation.error, kind: "rejected", status: mutation.status };
    }
    if (!SCHEDULE_JSON_COLUMNS.includes(mutation.column)) {
      throw new Error(`Not a schedule column: ${mutation.column}`);
    }

    const setClause = `${mutation.column} = @Value`;
    const updated = await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET ${setClause},
         ScheduleVersion = ScheduleVersion + 1,
         UpdatedAt = SYSUTCDATETIME(),
         UpdatedById = @UpdatedById,
         UpdatedByName = @UpdatedByName
       OUTPUT INSERTED.ScheduleVersion, INSERTED.RowVersion
       WHERE TenantId = @TenantId AND BuildingId = @BuildingId`,
      [
        ...keyParams,
        { name: "Value", type: TYPES.NVarChar, value: JSON.stringify(mutation.value) },
        { name: "UpdatedById", type: TYPES.NVarChar, value: target.updatedById },
        { name: "UpdatedByName", type: TYPES.NVarChar, value: target.actor.name },
      ],
    );
    if (mutation.afterUpdate) await mutation.afterUpdate(connection);

    const correlationId = ledger.newCorrelationId();
    for (const entry of mutation.ledgerEntries) {
      await ledger.record(connection, {
        ...entry,
        actor: target.actor,
        buildingId: target.buildingId,
        correlationId,
        tenantId: target.tenantId,
      });
    }

    await commitTransaction(connection);
    return {
      kind: "ok",
      result: mutation.result,
      rowVersion: rowVersionHex(updated[0]?.RowVersion),
      scheduleVersion: Number(updated[0]?.ScheduleVersion ?? currentVersion + 1),
    };
  } catch (err) {
    await rollbackQuietly(connection);
    throw err;
  }
}
