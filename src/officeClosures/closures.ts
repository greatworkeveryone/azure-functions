// Office closures: whole Darwin days the office is shut (public holidays, the Christmas shutdown). PLAN §15,
// Connor 31 Oct 2026. Archive, never delete. Writes carry the RowVersion they read and answer 409 when stale.
// Who edits: EDIT_OFFICE_CLOSURES_ROLES (orgSettings/roles.ts); anyone signed in may read.

import { TYPES, type Connection } from "tedious";
import { inTransaction, txFail, txOk, type TxResult } from "../assetRegisterSupport";
import { executeQuery, type SqlRow } from "../db";
import { addCalendarDays, isDateKey } from "../escalation/businessTime";
import { record } from "../ledger";
import type { LedgerActor } from "../ledger/types";
import { clearOfficeCalendarCache, MAX_CLOSURE_DAYS } from "./calendar";

export const CLOSURE_KINDS = ["public_holiday", "shutdown"] as const;
export type ClosureKind = (typeof CLOSURE_KINDS)[number];
export { EDIT_OFFICE_CLOSURES_ROLES } from "../orgSettings/roles";

export interface OfficeClosureApi {
  archivedAt: string | null;
  closureId: number;
  endsOn: string;
  kind: ClosureKind;
  label: string;
  rowVersion: string;
  startsOn: string;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface ClosureInput {
  closureId: number | null;
  endsOn: string;
  kind: ClosureKind;
  label: string;
  rowVersion: string | null;
  startsOn: string;
}

export type ClosureFailure = { error: string; ok: false; status: number };
export type ClosureResult<T> = { ok: true; value: T } | ClosureFailure;

const SELECT = `SELECT ClosureId, StartsOn, EndsOn, Label, Kind, UpdatedAt, UpdatedBy, ArchivedAt, RowVersion FROM dbo.OfficeClosures`;
const SELECT_BY_ID = `${SELECT} WHERE ClosureId = @Id`;
const SELECT_LOCKED_BY_ID = `${SELECT} WITH (UPDLOCK, HOLDLOCK) WHERE ClosureId = @Id`;
const day = (v: unknown): string => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

export function closureRowToApi(row: SqlRow): OfficeClosureApi {
  return {
    archivedAt: row.ArchivedAt instanceof Date ? row.ArchivedAt.toISOString() : null,
    closureId: Number(row.ClosureId),
    endsOn: day(row.EndsOn),
    kind: row.Kind as ClosureKind,
    label: String(row.Label),
    rowVersion: Buffer.isBuffer(row.RowVersion) ? row.RowVersion.toString("base64") : String(row.RowVersion ?? ""),
    startsOn: day(row.StartsOn),
    updatedAt: row.UpdatedAt instanceof Date ? row.UpdatedAt.toISOString() : null,
    updatedBy: row.UpdatedBy == null ? null : String(row.UpdatedBy),
  };
}

const snapshot = (c: OfficeClosureApi) => ({ endsOn: c.endsOn, kind: c.kind, label: c.label, startsOn: c.startsOn });

export function parseClosureInput(body: Record<string, unknown>): ClosureResult<ClosureInput> {
  const bad = (error: string): ClosureFailure => ({ error, ok: false, status: 400 });
  const id = body.closureId ?? null;
  if (id !== null && (!Number.isInteger(id) || (id as number) <= 0)) return bad("closureId must be a whole number");
  if (id !== null && (typeof body.rowVersion !== "string" || body.rowVersion === "")) return bad("rowVersion is required when editing a closure");
  if (!isDateKey(body.startsOn) || !isDateKey(body.endsOn)) return bad("startsOn and endsOn must be dates (YYYY-MM-DD)");
  if (body.endsOn < body.startsOn) return bad("The last day can't be before the first day.");
  if (addCalendarDays(body.startsOn, MAX_CLOSURE_DAYS) < body.endsOn) return bad(`A closure can't run longer than ${MAX_CLOSURE_DAYS} days. Add it as more than one.`);
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (label === "") return bad("Give the closure a label, for example Christmas shutdown.");
  if (label.length > 100) return bad("The label can be at most 100 characters.");
  if (!CLOSURE_KINDS.includes(body.kind as ClosureKind)) return bad("kind must be public_holiday or shutdown");
  return { ok: true, value: { closureId: id as number | null, endsOn: body.endsOn, kind: body.kind as ClosureKind, label, rowVersion: (body.rowVersion as string | undefined) ?? null, startsOn: body.startsOn } };
}

/** All closures, archived ones last-flagged: the page filters. Earliest first. */
export async function listClosures(connection: Connection): Promise<OfficeClosureApi[]> {
  return (await executeQuery(connection, `${SELECT} ORDER BY StartsOn, ClosureId`)).map(closureRowToApi);
}

async function fetchOne(connection: Connection, id: number, lock = false): Promise<OfficeClosureApi | null> {
  const [row] = await executeQuery(connection, (lock ? SELECT_LOCKED_BY_ID : SELECT_BY_ID), [{ name: "Id", type: TYPES.Int, value: id }]);
  return row ? closureRowToApi(row) : null;
}

const toResult = <T>(out: TxResult<T>): ClosureResult<T> =>
  out.ok ? { ok: true, value: out.value } : { error: (out.response.jsonBody as { error: string }).error, ok: false, status: out.response.status ?? 500 };

const stale = (before: OfficeClosureApi) => ({ jsonBody: { error: `${before.updatedBy ?? "Someone"} changed this closure. Reload to see their changes, then make your edit again.` }, status: 409 });

export async function saveClosure(connection: Connection, input: { actor: LedgerActor; caller: string; closure: ClosureInput }): Promise<ClosureResult<{ closure: OfficeClosureApi; created: boolean }>> {
  const c = input.closure;
  const out = await inTransaction(connection, async (): Promise<TxResult<{ closure: OfficeClosureApi; created: boolean }>> => {
    const values = [
      { name: "StartsOn", type: TYPES.Date, value: c.startsOn },
      { name: "EndsOn", type: TYPES.Date, value: c.endsOn },
      { name: "Label", type: TYPES.NVarChar, value: c.label },
      { name: "Kind", type: TYPES.NVarChar, value: c.kind },
      { name: "By", type: TYPES.NVarChar, value: input.caller },
    ];
    if (c.closureId === null) {
      const [ins] = await executeQuery(
        connection,
        `INSERT INTO dbo.OfficeClosures (StartsOn, EndsOn, Label, Kind, CreatedBy, UpdatedBy) OUTPUT INSERTED.ClosureId VALUES (@StartsOn, @EndsOn, @Label, @Kind, @By, @By)`,
        values,
      );
      const closure = (await fetchOne(connection, Number(ins.ClosureId))) as OfficeClosureApi;
      await record(connection, { action: "settings.office_closure_create", actor: input.actor, after: snapshot(closure), subject: { id: closure.closureId, type: "office_closure" } });
      return txOk({ closure, created: true });
    }
    const before = await fetchOne(connection, c.closureId, true);
    if (!before) return txFail({ jsonBody: { error: "Closure not found" }, status: 404 });
    if (before.archivedAt) return txFail({ jsonBody: { error: "This closure is archived. Add it again if you need it." }, status: 409 });
    if (before.rowVersion !== c.rowVersion) return txFail(stale(before));
    const updated = await executeQuery(
      connection,
      `UPDATE dbo.OfficeClosures SET StartsOn = @StartsOn, EndsOn = @EndsOn, Label = @Label, Kind = @Kind, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @By
       OUTPUT INSERTED.ClosureId WHERE ClosureId = @Id AND RowVersion = @RowVersion`,
      [...values, { name: "Id", type: TYPES.Int, value: c.closureId }, { name: "RowVersion", type: TYPES.Binary, value: Buffer.from(c.rowVersion as string, "base64") }],
    );
    if (updated.length === 0) return txFail(stale(before));
    const closure = (await fetchOne(connection, c.closureId)) as OfficeClosureApi;
    await record(connection, { action: "settings.office_closure_update", actor: input.actor, after: snapshot(closure), before: snapshot(before), subject: { id: closure.closureId, type: "office_closure" } });
    return txOk({ closure, created: false });
  });
  if (out.ok) clearOfficeCalendarCache();
  return toResult(out);
}

export async function archiveClosure(connection: Connection, input: { actor: LedgerActor; caller: string; closureId: number; rowVersion: string }): Promise<ClosureResult<OfficeClosureApi>> {
  const out = await inTransaction(connection, async (): Promise<TxResult<OfficeClosureApi>> => {
    const before = await fetchOne(connection, input.closureId, true);
    if (!before) return txFail({ jsonBody: { error: "Closure not found" }, status: 404 });
    if (before.archivedAt) return txOk(before);
    if (before.rowVersion !== input.rowVersion) return txFail(stale(before));
    await executeQuery(
      connection,
      `UPDATE dbo.OfficeClosures SET ArchivedAt = SYSUTCDATETIME(), ArchivedBy = @By, UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @By WHERE ClosureId = @Id AND ArchivedAt IS NULL`,
      [{ name: "Id", type: TYPES.Int, value: input.closureId }, { name: "By", type: TYPES.NVarChar, value: input.caller }],
    );
    const closure = (await fetchOne(connection, input.closureId)) as OfficeClosureApi;
    await record(connection, { action: "settings.office_closure_archive", actor: input.actor, after: snapshot(closure), before: snapshot(before), subject: { id: closure.closureId, type: "office_closure" } });
    return txOk(closure);
  });
  if (out.ok) clearOfficeCalendarCache();
  return toResult(out);
}
