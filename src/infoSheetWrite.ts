import type { HttpResponseInit } from "@azure/functions";
import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { beginTransaction, commitTransaction, executeQuery, rollbackTransaction } from "./db";
import { record } from "./ledger";
import type { LedgerActor } from "./ledger/types";
import type { InfoSheetRow, InfoSheetSection } from "./infoSheetLogic";
import { conflictResponse, isoTimestamp } from "./tenancyScheduleWrite";

// Writes to Tenants.InfoSheetSections (D11; database-safety rules 6 and 7).
//
// Every write changes the one entry it names and keeps every other entry as
// stored, byte for byte (the WP26c appendRelief rule): an entry with a field
// this code doesn't know is never rebuilt. A column holding something that
// isn't a JSON array is refused (422) and never written over; the old code read
// it as an empty sheet and saved the change over it. Each write runs under the
// tenancy's row lock and moves InfoSheetVersion on. A delete names the version
// it was shown, is refused (409) when the sheet has changed since, and is
// ledgered with the whole array as it was.
//
// D11 review: every write names the version it was shown (409 when stale). A
// section write changes only the section's own fields (title, order,
// strikethrough) and keeps its stored rows; rows change only through row
// writes. A write for a section or row that is no longer there is a 404 unless
// it says it is new, so a stale screen can't bring back what a colleague took off.

export type InfoSheetOp =
  | { kind: "deleteRow"; rowId: string; sectionId: string }
  | { kind: "deleteSection"; sectionId: string }
  | { isNew: boolean; kind: "upsertRow"; row: InfoSheetRow; sectionId: string }
  | { isNew: boolean; kind: "upsertSection"; section: InfoSheetSection };

export type InfoSheetEdit =
  | { before: unknown[]; json: string; ok: true; sections: InfoSheetSection[] }
  | { error: string; ok: false; status: 404 | 409 | 422 };

const UNSAFE = "This tenancy's info sheet is stored in a form that can't be changed safely, so nothing was changed. Ask an admin to look at it.";
const NO_SECTION = "That section is no longer on the info sheet. Reload to see it as it is now.";
const NO_ROW = "That row is no longer on the info sheet. Reload to see it as it is now.";
const ALREADY = "That is already on the info sheet. Reload to see it as it is now.";
/** The fields a section write may change; its rows change only through row writes. */
const SECTION_FIELDS = ["displayOrder", "strikethrough", "title"] as const;

/** The top-level entries of a JSON array, each as its own stored text, or null when the text isn't a JSON array. */
export function jsonArrayElements(text: string): { raw: string; value: unknown }[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const raws: string[] = [];
  let depth = 0;
  let inString = false;
  let escaped = false;
  let start = text.indexOf("[") + 1;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "[" || char === "{") depth += 1;
    else if ((char === "]" || char === "}") && depth > 0) depth -= 1;
    else if (char === "]") {
      const last = text.slice(start, index).trim();
      if (last !== "") raws.push(last);
      break;
    } else if (char === "," && depth === 0) {
      raws.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  if (raws.length !== parsed.length) return null;
  const values: unknown[] = parsed;
  return raws.map((raw, index) => ({ raw, value: values[index] }));
}

function elementsOf(raw: unknown): { raw: string; value: unknown }[] | null {
  if (raw === null || raw === undefined) return [];
  if (typeof raw !== "string") return null;
  return raw.trim() === "" ? [] : jsonArrayElements(raw);
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const idOf = (value: unknown): unknown => (isRecord(value) ? value.id : undefined);
const refuse = (status: 404 | 409 | 422, error: string): InfoSheetEdit => ({ error, ok: false, status });

/** The column after one change, with every other entry as stored; or why not. */
export function editInfoSheet(raw: unknown, op: InfoSheetOp): InfoSheetEdit {
  const elements = elementsOf(raw);
  if (elements === null) return refuse(422, UNSAFE);
  const before = elements.map((element) => element.value);
  const sectionId = op.kind === "upsertSection" ? op.section.id : op.sectionId;
  const at = elements.findIndex((element) => idOf(element.value) === sectionId);
  const raws = elements.map((element) => element.raw);

  if (op.kind === "deleteSection") {
    if (at === -1) return refuse(404, NO_SECTION);
    raws.splice(at, 1);
  } else if (op.kind === "upsertSection") {
    if (at === -1 && !op.isNew) return refuse(404, NO_SECTION);
    if (at !== -1 && op.isNew) return refuse(409, ALREADY);
    if (at === -1) {
      // A new section may arrive with its first rows (bulk add).
      raws.push(JSON.stringify({ ...op.section, rows: Array.isArray(op.section.rows) ? op.section.rows : [] }));
    } else {
      const current = elements[at].value;
      if (!isRecord(current)) return refuse(422, UNSAFE);
      const own: Record<string, unknown> = {};
      for (const field of SECTION_FIELDS) if (op.section[field] !== undefined) own[field] = op.section[field];
      raws[at] = JSON.stringify({ ...current, ...own });
    }
  } else {
    if (at === -1) return refuse(404, NO_SECTION);
    const section = elements[at].value;
    if (!isRecord(section) || !Array.isArray(section.rows)) return refuse(422, UNSAFE);
    const rows: unknown[] = section.rows;
    const rowAt = rows.findIndex((row) => idOf(row) === (op.kind === "deleteRow" ? op.rowId : op.row.id));
    let nextRows: unknown[];
    if (op.kind === "deleteRow") {
      if (rowAt === -1) return refuse(404, NO_ROW);
      nextRows = rows.filter((_row, index) => index !== rowAt);
    } else {
      if (rowAt === -1 && !op.isNew) return refuse(404, NO_ROW);
      if (rowAt !== -1 && op.isNew) return refuse(409, ALREADY);
      nextRows = rowAt === -1 ? [...rows, op.row] : rows.map((row, index) => (index === rowAt ? op.row : row));
    }
    raws[at] = JSON.stringify({ ...section, rows: nextRows });
  }
  const json = `[${raws.join(",")}]`;
  return { before, json, ok: true, sections: JSON.parse(json) as InfoSheetSection[] };
}

/** The version a write names (`InfoSheetVersion`), or a 400 when it doesn't name one. */
export function infoSheetVersionOf(body: Record<string, unknown>): number | { status: 400; jsonBody: { error: string } } {
  const version = body.InfoSheetVersion;
  return typeof version === "number" && Number.isInteger(version) && version >= 0
    ? version
    : { jsonBody: { error: "InfoSheetVersion required: the version of the info sheet you were shown" }, status: 400 };
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
 OUTPUT INSERTED.InfoSheetVersion
 WHERE TenantId = @TenantId AND BuildingId = @BuildingId`;

export interface InfoSheetWrite {
  buildingId: number;
  caller: { id: string; name: string };
  /** The version the client was shown; every write names it (D11 review). */
  expectedVersion: number;
  /** Deletes are ledgered with the whole array as it was. */
  ledger: { action: "tenancy.info_sheet_row_delete" | "tenancy.info_sheet_section_delete"; actor: LedgerActor } | null;
  op: InfoSheetOp;
  tenantId: number;
}

export type InfoSheetWriteOutcome = { ok: true; sections: InfoSheetSection[]; version: number } | { ok: false; response: HttpResponseInit };

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
      await record(connection, {
        action: write.ledger.action,
        actor: write.ledger.actor,
        after: op.kind === "deleteRow" ? { rowId: op.rowId, sectionId: op.sectionId } : { sectionId: op.kind === "upsertSection" ? op.section.id : op.sectionId },
        before: { sections: edit.before },
        buildingId: write.buildingId,
        subject: { id: write.tenantId, type: "tenancy" },
        tenantId: write.tenantId,
      });
    }
    await commitTransaction(connection);
    return { ok: true, sections: edit.sections, version: Number(written?.InfoSheetVersion ?? current + 1) };
  } catch (error) {
    await rollbackTransaction(connection).catch(() => {});
    throw error;
  }
}
