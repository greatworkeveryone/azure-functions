import type { HttpResponseInit } from "@azure/functions";
import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { AppRole } from "./auth";
import { beginTransaction, commitTransaction, executeQuery, rollbackTransaction } from "./db";
import { editInfoSheet, type InfoSheetOp } from "./infoSheetEdit";
import { recordInfoSheetChange } from "./infoSheetLedger";
import type { LedgerActor } from "./ledger/types";
import type { InfoSheetSection } from "./infoSheetLogic";
import { conflictResponse, isoTimestamp, rowVersionHex } from "./tenancyScheduleWrite";

export * from "./infoSheetEdit";
export { jsonArrayElements } from "./jsonArrayElements";

// Writes to Tenants.InfoSheetSections (D11; database-safety rules 6 and 7). What an edit
// does to the column is infoSheetEdit.ts; this is the write: every one runs under the
// tenancy's row lock, names the version it was shown (409 when stale) and moves
// InfoSheetVersion on, in one transaction. A delete is ledgered with the entry it
// removed and a bulk add with the rows it added, not the whole sheet, which could pass
// the ledger's 64 KB cap (S3-6, infoSheetLedger.ts).

/** Every info sheet write is the tenancy desk's, and counts against one bucket of 60 a minute per person (a bulk add is one write). */
export const INFO_SHEET_ROLES = [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR] as const;
export const INFO_SHEET_RATE_LIMIT = { limit: 60, windowMs: 60_000 };

/** The version a write names (`InfoSheetVersion`), or a 400 when it doesn't name one. */
export function infoSheetVersionOf(body: Record<string, unknown>): number | { status: 400; jsonBody: { error: string } } {
  const version = body.InfoSheetVersion;
  return typeof version === "number" && Number.isInteger(version) && version >= 0
    ? version
    : { jsonBody: { error: "InfoSheetVersion required: the version of the info sheet you were shown" }, status: 400 };
}

/**
 * Where a new section or row goes (`Position`, from Undo putting back what was removed), or a 400 when
 * it names something that isn't a place. Absent means the end; it is ignored for an entry that isn't new.
 */
export function infoSheetPositionOf(body: Record<string, unknown>): number | undefined | { status: 400; jsonBody: { error: string } } {
  if (body.Position === undefined) return undefined;
  const position = body.Position;
  return typeof position === "number" && Number.isInteger(position) && position >= 0
    ? position
    : { jsonBody: { error: "Position must be a whole number, counting from 0" }, status: 400 };
}

/**
 * Whether this write puts back an entry Undo has just taken off (`Restore`), which is then
 * ledgered. Only a new entry can be restored: anything else naming it is a 400.
 */
export function infoSheetRestoreOf(body: Record<string, unknown>): boolean | { status: 400; jsonBody: { error: string } } {
  if (body.Restore === undefined) return false;
  if (typeof body.Restore !== "boolean") return { jsonBody: { error: "Restore must be true or false" }, status: 400 };
  if (body.Restore && body.IsNew !== true) return { jsonBody: { error: "Restore is for putting back an entry: it goes with IsNew" }, status: 400 };
  return body.Restore;
}

const LOCKED_SHEET = `SELECT InfoSheetSections, InfoSheetVersion, UpdatedAt, UpdatedByName
  FROM dbo.Tenants WITH (UPDLOCK, ROWLOCK)
 WHERE TenantId = @TenantId AND BuildingId = @BuildingId`;
const WRITE_SHEET = `UPDATE dbo.Tenants SET
       InfoSheetSections = @InfoSheetSections,
       InfoSheetVersion = InfoSheetVersion + 1,
       UpdatedAt = SYSUTCDATETIME(),
       UpdatedById = @UpdatedById,
       UpdatedByName = @UpdatedByName
 OUTPUT INSERTED.InfoSheetVersion, INSERTED.RowVersion
 WHERE TenantId = @TenantId AND BuildingId = @BuildingId`;

/** The small part of a ledger row that names what changed; a delete's Before and a bulk add's After hold the content. */
function ledgerAfter(op: InfoSheetOp): unknown {
  switch (op.kind) {
    case "addRows":
      return undefined;
    case "deleteRow":
      return { rowId: op.rowId, sectionId: op.sectionId };
    case "upsertSection":
      return { sectionId: op.section.id };
    default:
      return { sectionId: op.sectionId };
  }
}

export interface InfoSheetWrite {
  buildingId: number;
  caller: { id: string; name: string };
  /** The version the client was shown; every write names it (D11 review). */
  expectedVersion: number;
  /** Deletes are ledgered with the entry removed, a bulk add with the rows added (S3-6), an Undo with the entry put back (S3-2). */
  ledger: {
    action:
      | "tenancy.info_sheet_row_delete"
      | "tenancy.info_sheet_row_restore"
      | "tenancy.info_sheet_rows_added"
      | "tenancy.info_sheet_section_delete"
      | "tenancy.info_sheet_section_restore";
    actor: LedgerActor;
  } | null;
  op: InfoSheetOp;
  tenantId: number;
}

export type InfoSheetWriteOutcome = { ok: true; rowVersion: string; sections: InfoSheetSection[]; version: number } | { ok: false; response: HttpResponseInit };

/** One info sheet change, in its own transaction under the tenancy's row lock. */
export async function writeInfoSheet(connection: Connection, write: InfoSheetWrite): Promise<InfoSheetWriteOutcome> {
  const scope = [
    { name: "TenantId", type: TYPES.Int, value: write.tenantId },
    { name: "BuildingId", type: TYPES.Int, value: write.buildingId },
  ];
  const refused = async (response: HttpResponseInit): Promise<InfoSheetWriteOutcome> => {
    await rollbackTransaction(connection).catch(() => {});
    return { ok: false, response };
  };
  await beginTransaction(connection);
  try {
    const [row] = await executeQuery(connection, LOCKED_SHEET, scope);
    if (!row) return await refused({ status: 404, jsonBody: { error: "Tenant not found" } });
    const current = Number(row.InfoSheetVersion ?? 0);
    if (write.expectedVersion !== current) {
      return await refused(
        conflictResponse(
          { changedAt: isoTimestamp(row.UpdatedAt), changedBy: (row.UpdatedByName as string | null) ?? null },
          { infoSheetVersion: current },
        ),
      );
    }
    const edit = editInfoSheet(row.InfoSheetSections, write.op);
    if (!edit.ok) return await refused({ status: edit.status, jsonBody: { error: edit.error } });

    const [written] = await executeQuery(connection, WRITE_SHEET, [
      { name: "InfoSheetSections", type: TYPES.NVarChar, value: edit.json },
      { name: "UpdatedById", type: TYPES.NVarChar, value: write.caller.id },
      { name: "UpdatedByName", type: TYPES.NVarChar, value: write.caller.name },
      ...scope,
    ]);
    if (write.ledger) {
      const { op } = write;
      await recordInfoSheetChange(connection, {
        action: write.ledger.action,
        actor: write.ledger.actor,
        after: edit.restored ?? edit.added ?? ledgerAfter(op),
        before: edit.removed,
        buildingId: write.buildingId,
        subject: { id: write.tenantId, type: "tenancy" },
        tenantId: write.tenantId,
      });
    }
    await commitTransaction(connection);
    // The write moved the tenant's RowVersion; handing it back keeps the user's next tenancy edit from 409ing on their own change.
    return { ok: true, rowVersion: rowVersionHex(written?.RowVersion), sections: edit.sections, version: Number(written?.InfoSheetVersion ?? current + 1) };
  } catch (error) {
    await rollbackTransaction(connection).catch(() => {});
    throw error;
  }
}
