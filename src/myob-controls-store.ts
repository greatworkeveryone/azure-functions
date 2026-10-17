// Reads of dbo.MyobControls (migration 124) and of today's MYOB writes, shared
// by the request guard (myob-controls.ts), the CFO's endpoints and the panel.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { todayInDarwin } from "./darwinDate";
import { executeQuery, type SqlRow } from "./db";
import { darwinDayStartUtc, parseDarwinDate } from "./ledger/darwinTime";
import { classifyMyobRequest, myobApiBase } from "./myob-endpoints";

export const CONTROL_OPERATIONS = [
  "quotes.create",
  "quotes.update",
  "orders.create",
  "orders.update",
  "bills.create",
  "purchases.read",
  "lab.enabled",
] as const;

export type ControlOperation = (typeof CONTROL_OPERATIONS)[number];

export function isControlOperation(value: unknown): value is ControlOperation {
  return typeof value === "string" && (CONTROL_OPERATIONS as readonly string[]).includes(value);
}

export interface ControlRow {
  companyFileId: string;
  dailyCap: number;
  dryRun: boolean;
  enabled: boolean;
  note: string | null;
  operation: ControlOperation;
  pausedAll: boolean;
  requireReview: boolean;
  /** base64 of the 8-byte ROWVERSION; what a change must send back. */
  rowVersion: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export const CONTROL_COLUMNS =
  "CompanyFileId, Operation, Enabled, DryRun, DailyCap, RequireReview, PausedAll, UpdatedBy, UpdatedAt, Note, RowVersion";
export const INSERTED_CONTROL_COLUMNS = CONTROL_COLUMNS.split(", ")
  .map((column) => `inserted.${column}`)
  .join(", ");

export function toControlRow(raw: SqlRow): ControlRow {
  return {
    companyFileId: String(raw.CompanyFileId ?? "").toLowerCase(),
    dailyCap: Number(raw.DailyCap ?? 0),
    dryRun: Boolean(raw.DryRun),
    enabled: Boolean(raw.Enabled),
    note: (raw.Note as string | null) ?? null,
    operation: raw.Operation as ControlOperation,
    pausedAll: Boolean(raw.PausedAll),
    requireReview: Boolean(raw.RequireReview),
    rowVersion: Buffer.isBuffer(raw.RowVersion) ? raw.RowVersion.toString("base64") : "",
    updatedAt: raw.UpdatedAt instanceof Date ? raw.UpdatedAt.toISOString() : null,
    updatedBy: (raw.UpdatedBy as string | null) ?? null,
  };
}

/** Every control row, or one file's. */
export async function readControls(connection: Connection, companyFileId?: string): Promise<ControlRow[]> {
  const rows = companyFileId
    ? await executeQuery(connection, `SELECT ${CONTROL_COLUMNS} FROM dbo.MyobControls WHERE CompanyFileId = @CompanyFileId`, [
        { name: "CompanyFileId", type: TYPES.NVarChar, value: companyFileId },
      ])
    : await executeQuery(connection, `SELECT ${CONTROL_COLUMNS} FROM dbo.MyobControls`);
  return rows.map(toControlRow);
}

export const writeKey = (companyFileId: string, operation: string) => `${companyFileId}|${operation}`;

/**
 * Company-file writes sent since midnight in Darwin, per file and operation
 * ("file|orders.create" → n). Counted from MyobApiLog's request rows, one per
 * call however many attempts it took, and classified with the same allowlist
 * the client uses, so the count can't drift from what was actually sent.
 */
export async function writesToday(connection: Connection, now: Date = new Date()): Promise<Map<string, number>> {
  const since = darwinDayStartUtc(parseDarwinDate(todayInDarwin(now))!);
  const rows = await executeQuery(
    connection,
    `SELECT Method, Path, COUNT(DISTINCT CorrelationId) AS Calls
       FROM dbo.MyobApiLog
      WHERE Phase = 'request' AND Method IN ('POST', 'PUT') AND OccurredAt >= @Since
      GROUP BY Method, Path`,
    [{ name: "Since", type: TYPES.DateTime2, value: since }],
  );
  const origin = new URL(myobApiBase()).origin;
  const counts = new Map<string, number>();
  for (const row of rows) {
    const classified = classifyMyobRequest(String(row.Method), `${origin}${String(row.Path)}`);
    if (classified.kind !== "endpoint" || !classified.companyFileId) continue;
    const key = writeKey(classified.companyFileId, classified.rule.operation);
    counts.set(key, (counts.get(key) ?? 0) + Number(row.Calls ?? 0));
  }
  return counts;
}
