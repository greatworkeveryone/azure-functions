import type { HttpResponseInit } from "@azure/functions";
import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { AppRole } from "./auth";
import { beginTransaction, commitTransaction, executeQuery, rollbackTransaction } from "./db";
import { recordInfoSheetChange } from "./infoSheetLedger";
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
// ledgered with the entry it removed.
//
// D11 review: every write names the version it was shown (409 when stale). A
// section write changes only the section's own fields (title, order,
// strikethrough) and keeps its stored rows; rows change only through row
// writes. A write for a section or row that is no longer there is a 404 unless
// it says it is new, so a stale screen can't bring back what a colleague took off.
//
// S3-6: a delete ledgers only the entry removed, with where it was (infoSheetLedger.ts),
// not the whole sheet: the whole sheet could pass the ledger's 64 KB cap.

/** Every info sheet write is the tenancy desk's, and counts against one bucket of 60 a minute per person (a bulk add is one write). */
export const INFO_SHEET_ROLES = [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR] as const;
export const INFO_SHEET_RATE_LIMIT = { limit: 60, windowMs: 60_000 };

/** A row as a bulk add sends it: its place is the server's to give when it names none. */
export type InfoSheetNewRow = Omit<InfoSheetRow, "displayOrder"> & { displayOrder?: number };

/** One section's share of a bulk add: rows for an existing section, or a new section with its first rows. */
export interface InfoSheetAddition {
  isNew: boolean;
  rows: InfoSheetNewRow[];
  section: { displayOrder?: number; id: string; title?: string };
}

export type InfoSheetOp =
  | { additions: InfoSheetAddition[]; kind: "addRows" }
  | { kind: "deleteRow"; rowId: string; sectionId: string }
  | { kind: "deleteSection"; sectionId: string }
  | { isNew: boolean; kind: "upsertRow"; position?: number; row: InfoSheetRow; sectionId: string }
  | { isNew: boolean; kind: "upsertSection"; position?: number; section: InfoSheetSection };

/** What a delete took off, as stored, and the place it held in its list (a section's among the sections, a row's among its section's rows). */
export type InfoSheetRemoved =
  | { position: number; row: unknown; sectionId: string; sectionTitle: unknown }
  | { position: number; section: unknown };

/** What a bulk add put on the sheet, as the ledger keeps it: only the rows added, by section. */
export interface InfoSheetAdded {
  additions: { isNew: boolean; rows: InfoSheetRow[]; sectionId: string; sectionTitle: unknown }[];
}

export type InfoSheetEdit =
  | { added: InfoSheetAdded | null; json: string; ok: true; removed: InfoSheetRemoved | null; sections: InfoSheetSection[] }
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

/** `items` with `item` put in at `position` (the end when none is given, or when it is past the end). */
function insertedAt<T>(items: T[], item: T, position: number | undefined): T[] {
  const at = position === undefined ? items.length : Math.min(position, items.length);
  return [...items.slice(0, at), item, ...items.slice(at)];
}

/** A row as a bulk add stores it: the fields this code knows, in the order it was entered after the rows already there. */
const storedRow = (row: InfoSheetNewRow, order: number): InfoSheetRow => ({
  body: row.body,
  displayOrder: row.displayOrder ?? order,
  id: row.id,
  ...(row.strikethrough === undefined ? {} : { strikethrough: row.strikethrough }),
  subheader: row.subheader,
});

/**
 * Every addition in one edit: rows onto existing sections, new sections with their
 * first rows. One refusal (a section gone, a row id already there) refuses all of
 * it, so a retry after a refused or half-seen save can't leave rows added twice.
 */
function addRows(elements: { raw: string; value: unknown }[], additions: InfoSheetAddition[]): InfoSheetEdit {
  const raws = elements.map((element) => element.raw);
  const values = elements.map((element) => element.value);
  const taken = new Set<string>();
  for (const value of values) {
    if (!isRecord(value) || !Array.isArray(value.rows)) continue;
    for (const existing of value.rows) {
      const id = idOf(existing);
      if (typeof id === "string") taken.add(id);
    }
  }
  const added: InfoSheetAdded["additions"] = [];
  for (const addition of additions) {
    const at = values.findIndex((value) => idOf(value) === addition.section.id);
    if (addition.isNew ? at !== -1 : at === -1) return refuse(addition.isNew ? 409 : 404, addition.isNew ? ALREADY : NO_SECTION);
    if (addition.rows.some((row) => taken.has(row.id))) return refuse(409, ALREADY);
    if (addition.isNew) {
      const rows = addition.rows.map((row, index) => storedRow(row, index));
      const created = { displayOrder: addition.section.displayOrder ?? values.length, id: addition.section.id, rows, title: addition.section.title };
      raws.push(JSON.stringify(created));
      values.push(created);
      added.push({ isNew: true, rows, sectionId: addition.section.id, sectionTitle: addition.section.title });
    } else {
      const section = values[at];
      if (!isRecord(section) || !Array.isArray(section.rows)) return refuse(422, UNSAFE);
      const existing: unknown[] = section.rows;
      const rows = addition.rows.map((row, index) => storedRow(row, existing.length + index));
      const next = { ...section, rows: [...existing, ...rows] };
      raws[at] = JSON.stringify(next);
      values[at] = next;
      added.push({ isNew: false, rows, sectionId: addition.section.id, sectionTitle: section.title });
    }
    for (const row of addition.rows) taken.add(row.id);
  }
  const json = `[${raws.join(",")}]`;
  return { added: { additions: added }, json, ok: true, removed: null, sections: JSON.parse(json) as InfoSheetSection[] };
}

/** The column after one change, with every other entry as stored; or why not. */
export function editInfoSheet(raw: unknown, op: InfoSheetOp): InfoSheetEdit {
  const elements = elementsOf(raw);
  if (elements === null) return refuse(422, UNSAFE);
  if (op.kind === "addRows") return addRows(elements, op.additions);
  const sectionId = op.kind === "upsertSection" ? op.section.id : op.sectionId;
  const at = elements.findIndex((element) => idOf(element.value) === sectionId);
  const raws = elements.map((element) => element.raw);
  let removed: InfoSheetRemoved | null = null;

  if (op.kind === "deleteSection") {
    if (at === -1) return refuse(404, NO_SECTION);
    removed = { position: at, section: elements[at].value };
    raws.splice(at, 1);
  } else if (op.kind === "upsertSection") {
    if (at === -1 && !op.isNew) return refuse(404, NO_SECTION);
    if (at !== -1 && op.isNew) return refuse(409, ALREADY);
    if (at === -1) {
      // A new section may arrive with its first rows (bulk add, or Undo), and goes where it says (Undo).
      raws.splice(op.position === undefined ? raws.length : Math.min(op.position, raws.length), 0, JSON.stringify({ ...op.section, rows: Array.isArray(op.section.rows) ? op.section.rows : [] }));
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
      removed = { position: rowAt, row: rows[rowAt], sectionId: op.sectionId, sectionTitle: section.title };
      nextRows = rows.filter((_row, index) => index !== rowAt);
    } else {
      if (rowAt === -1 && !op.isNew) return refuse(404, NO_ROW);
      if (rowAt !== -1 && op.isNew) return refuse(409, ALREADY);
      nextRows = rowAt === -1 ? insertedAt(rows, op.row, op.position) : rows.map((row, index) => (index === rowAt ? op.row : row));
    }
    raws[at] = JSON.stringify({ ...section, rows: nextRows });
  }
  const json = `[${raws.join(",")}]`;
  return { added: null, json, ok: true, removed, sections: JSON.parse(json) as InfoSheetSection[] };
}

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
  /** Deletes are ledgered with the entry removed, a bulk add with the rows added (S3-6). */
  ledger: { action: "tenancy.info_sheet_row_delete" | "tenancy.info_sheet_rows_added" | "tenancy.info_sheet_section_delete"; actor: LedgerActor } | null;
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
      await recordInfoSheetChange(connection, {
        action: write.ledger.action,
        actor: write.ledger.actor,
        after: edit.added ?? ledgerAfter(op),
        before: edit.removed,
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
