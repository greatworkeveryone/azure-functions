import { jsonArrayElements } from "./jsonArrayElements";
import type { InfoSheetRow, InfoSheetSection } from "./infoSheetLogic";

// The pure part of a write to Tenants.InfoSheetSections (D11; database-safety rules 6 and 7):
// the column after one change, or why not. infoSheetWrite.ts runs it under the row lock.
//
// Every edit changes the entry it names and keeps every other as stored, byte for byte (the
// WP26c appendRelief rule): an entry with a field this code doesn't know is never rebuilt. A
// column holding something that isn't a JSON array is refused (422) and never written over.
// A section edit changes only the section's own fields (title, order, strikethrough) and
// keeps its stored rows; rows change only through row edits. An edit for a section or row
// that is no longer there is a 404 unless it says it is new, so a stale screen can't bring
// back what a colleague took off. A new entry may say where it goes (`position`, Undo).
// What a delete took off, and what a bulk add put on, is returned for the ledger (S3-6).

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
