// ─────────────────────────────────────────────────────────────────────────────
// Merge fields for an email: the catalogue of fields a body or subject may name and
// the fail-closed merge that fills them in, one recipient at a time.
//
// KEEP IN SYNC: this follows the frontend's src/helpers/mergeFields.ts (SC-CM1), the
// merge the letter preview runs: the same field paths and plain labels, the same
// fallback, the same rule that a field which is blank, or that Floorplan has no such
// field for, is left as its token and reported by name, so an email never goes out
// with a hole in it ("Dear ,"). The sender's own fields and the date are filled by
// the server, never taken from the request.
// ─────────────────────────────────────────────────────────────────────────────

import { escapeInline, parseMarkdown, splitFields, type MarkdownBlock } from "./markdown";

export interface MergeFieldDef {
  /** Another field to use when this one is blank; applied exactly as said here. */
  fallback?: string;
  /** The field in plain words, as the missing list names it. */
  label: string;
  path: string;
  /** Filled by the server from who is sending and the clock: a request may not supply it. */
  server?: boolean;
}

export const MERGE_FIELDS: readonly MergeFieldDef[] = [
  { label: "Tenant name", path: "tenant.name" },
  { label: "Primary contact", path: "tenant.contact" },
  { fallback: "tenant.name", label: "Name for the greeting", path: "tenant.addressee" },
  { label: "Suite or level", path: "tenant.suite" },
  { label: "Lease start date", path: "tenant.leaseStart" },
  { label: "Lease expiry date", path: "tenant.leaseExpiry" },
  { label: "Next rent review date", path: "tenant.nextReview" },
  { label: "Building name", path: "building.name" },
  { label: "Building address", path: "building.address" },
  { label: "Sender name", path: "sender.name", server: true },
  { label: "Sender title", path: "sender.title", server: true },
  { label: "Today's date", path: "today", server: true },
  { label: "Today's date in full", path: "today.long", server: true },
  { label: "Recipient name", path: "recipient.name", server: true },
];

const BY_PATH = new Map(MERGE_FIELDS.map((field) => [field.path, field]));

export const mergeFieldDef = (path: string): MergeFieldDef | undefined => BY_PATH.get(path);

/** True for a path the server fills; a request carrying a value for one is refused. */
export const isServerField = (path: string): boolean => BY_PATH.get(path)?.server === true;

export type MergeValues = Readonly<Record<string, null | string | undefined>>;

export interface MissingField {
  label: string;
  path: string;
  /** Blank: Floorplan has the field but nothing is filled in. Unknown: the text names a field Floorplan doesn't have. */
  reason: "blank" | "unknown";
}

const clean = (value: null | string | undefined): string => (value ?? "").replace(/\s+/g, " ").trim();

/** Fills one string. A field it cannot fill stays as its token and is added to `missing`. */
export function mergeText(text: string, values: MergeValues, missing: MissingField[]): string {
  return splitFields(text)
    .map((part) => {
      if (part.kind === "text") {
        if (/\{\{|\}\}/.test(part.text)) missing.push({ label: "Unmatched curly brackets", path: "{{", reason: "unknown" });
        return part.text;
      }
      const def = mergeFieldDef(part.path);
      if (def === undefined) {
        missing.push({ label: `"${part.path}"`, path: part.path, reason: "unknown" });
        return `{{${part.path}}}`;
      }
      const value = clean(values[def.path]) || (def.fallback === undefined ? "" : clean(values[def.fallback]));
      if (value === "") {
        missing.push({ label: def.label, path: def.path, reason: "blank" });
        return `{{${def.path}}}`;
      }
      return escapeInline(value);
    })
    .join("");
}

function mergeBlock(block: MarkdownBlock, fill: (text: string) => string): MarkdownBlock {
  switch (block.kind) {
    case "list":
      return { ...block, items: block.items.map(fill) };
    case "heading":
    case "paragraph":
    case "quote":
      return { ...block, text: fill(block.text) };
    case "table":
      return { ...block, header: block.header.map(fill), rows: block.rows.map((row) => row.map(fill)) };
    case "rule":
      return block;
  }
}

export interface MergedEmail {
  blocks: MarkdownBlock[];
  /** Each missing field once, in the order the email reaches it. */
  missing: MissingField[];
  ok: boolean;
  /** As merged, with markers still in it: render through restoreInline / parseInline. */
  subject: string;
}

/** Merges the subject and every text of the body for one recipient. */
export function mergeEmail(subject: string, bodyMarkdown: string, values: MergeValues): MergedEmail {
  const found: MissingField[] = [];
  const mergedSubject = mergeText(subject, values, found);
  const blocks = parseMarkdown(bodyMarkdown).map((block) => mergeBlock(block, (text) => mergeText(text, values, found)));
  const missing = [...new Map(found.map((field) => [field.path, field])).values()];
  return { blocks, missing, ok: missing.length === 0 && blocks.length > 0, subject: mergedSubject };
}

/** The paths a text names, in order, once each: what a request must supply per recipient. */
export function fieldsNamed(...texts: string[]): string[] {
  const paths = texts.flatMap((text) => splitFields(text).flatMap((part) => (part.kind === "field" ? [part.path] : [])));
  return [...new Set(paths)];
}

/** "Tenant name and Building address", for a sentence or a stored detail. */
export function missingSentence(missing: readonly MissingField[]): string {
  return missing.map((field) => field.label).join(", ");
}
