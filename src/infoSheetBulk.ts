import type { InfoSheetAddition, InfoSheetNewRow } from "./infoSheetWrite";

// The request body of addInfoSheetRows (D11 re-check S2-3), checked before the
// database is touched. An addition is `{ IsNew, Rows, Section: { id, title?, displayOrder? } }`:
// rows for an existing section (only its id is read), or a new section with its first rows.

/** One request may add this many rows. A paste is one write, so the bound is for the size of that write. */
export const MAX_BULK_ROWS = 500;

type Parsed = { additions: InfoSheetAddition[]; ok: true } | { error: string; ok: false };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isText = (value: unknown): value is string => typeof value === "string";
const refuse = (error: string): Parsed => ({ error, ok: false });

function rowOf(value: unknown): InfoSheetNewRow | null {
  if (!isObject(value) || !isText(value.id) || value.id === "") return null;
  if (value.subheader !== undefined && !isText(value.subheader)) return null;
  if (value.body !== undefined && !isText(value.body)) return null;
  if (value.displayOrder !== undefined && !(typeof value.displayOrder === "number" && Number.isInteger(value.displayOrder) && value.displayOrder >= 0)) return null;
  if (value.strikethrough !== undefined && typeof value.strikethrough !== "boolean") return null;
  return {
    body: value.body ?? "",
    id: value.id,
    subheader: value.subheader ?? "",
    ...(value.displayOrder === undefined ? {} : { displayOrder: Number(value.displayOrder) }),
    ...(value.strikethrough === undefined ? {} : { strikethrough: value.strikethrough }),
  };
}

export function parseBulkAdditions(raw: unknown): Parsed {
  if (!Array.isArray(raw) || raw.length === 0) return refuse("Additions required: the sections to add rows to, each with its rows");
  const additions: InfoSheetAddition[] = [];
  const sectionIds = new Set<string>();
  const rowIds = new Set<string>();
  for (const item of raw) {
    if (!isObject(item) || !isObject(item.Section) || !isText(item.Section.id) || item.Section.id === "") return refuse("Each addition needs a Section with an id");
    if (sectionIds.has(item.Section.id)) return refuse("Each section can appear once: put all its rows in one addition");
    sectionIds.add(item.Section.id);
    const isNew = item.IsNew === true;
    if (isNew && (!isText(item.Section.title) || item.Section.title.trim() === "")) return refuse("A new section needs a title");
    if (!Array.isArray(item.Rows) || item.Rows.length === 0) return refuse("Each addition needs at least one row");
    const rows: InfoSheetNewRow[] = [];
    for (const value of item.Rows) {
      const row = rowOf(value);
      if (!row) return refuse("Each row needs an id, and its subheader and body must be text");
      if (rowIds.has(row.id)) return refuse("Each row id can appear once");
      rowIds.add(row.id);
      rows.push(row);
    }
    const { displayOrder, title } = item.Section;
    if (displayOrder !== undefined && !(typeof displayOrder === "number" && Number.isInteger(displayOrder) && displayOrder >= 0)) return refuse("A section's order must be a whole number");
    additions.push({
      isNew,
      rows,
      section: { id: item.Section.id, ...(isNew ? { title: String(title) } : {}), ...(isNew && typeof displayOrder === "number" ? { displayOrder } : {}) },
    });
  }
  if (rowIds.size > MAX_BULK_ROWS) return refuse(`Add at most ${MAX_BULK_ROWS} rows at a time`);
  return { additions, ok: true };
}
