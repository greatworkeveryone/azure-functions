// What importing one CSV of MYOB mappings would do (plan M2), row by row, in
// plain words, before anything is written: add, change (before → after),
// already mapped, or skipped and why. Pure. The fingerprint covers every
// outcome and what Floorplan held before, so an apply is refused if anything
// moved since the CFO's preview.

import { canonicalJson, sha256Hex } from "../hash";
import type { CsvRow } from "./csv";
import { KINDS, type MappingKind, type MappingRefs, type MappingValues } from "./mappingKinds";

export type Outcome = "add" | "change" | "skip" | "unchanged";

export interface PlannedRow {
  after: MappingValues | null;
  before: MappingValues | null;
  changes: { after: string; before: string; label: string }[];
  file: string | null;
  key: string | null;
  line: number;
  /** Suppliers only: "abn" when the row's ABN is the contractor's own. */
  matchBasis?: "abn" | "manual";
  message: string;
  outcome: Outcome;
  rowVersion: string | null;
}

export interface ImportPlan {
  counts: Record<Outcome, number>;
  hash: string;
  kind: MappingKind;
  rows: PlannedRow[];
}

export class MappingImportError extends Error {}

const shown = (field: string, value: string | null, refs: MappingRefs) =>
  value === null ? "(none)" : field === "companyFileId" ? (refs.files.get(value) ?? value) : value;

export function planImport(kind: MappingKind, csv: { header: string[]; rows: CsvRow[] }, refs: MappingRefs): ImportPlan {
  const definition = KINDS[kind];
  const missing = definition.required.filter((column) => !csv.header.includes(column));
  if (missing.length > 0) throw new MappingImportError(`The file needs the columns ${missing.join(", ")} (export the current ${definition.label} for a template)`);

  const seen = new Map<string, number>();
  const rows: PlannedRow[] = csv.rows.map(({ cells, line }) => {
    const read = definition.read(cells, refs);
    const base = { after: null, before: null, changes: [], file: null, key: null, line, rowVersion: null };
    if (!read.ok) return { ...base, message: `Skipped: ${read.reason}`, outcome: "skip" };
    const fileName = refs.files.get(read.file) ?? read.file;
    const where = kind === "buildings" ? "" : ` in ${fileName}`;
    const first = seen.get(read.key);
    if (first !== undefined) return { ...base, message: `Skipped: ${read.subject}${where} is already on row ${first}`, outcome: "skip" };
    seen.set(read.key, line);

    const subject = read.subject.charAt(0).toUpperCase() + read.subject.slice(1);
    const extra = kind === "suppliers" ? { matchBasis: matchBasis(cells, read.values, refs) } : {};
    const existing = refs.existing.get(read.key);
    const planned = { ...base, ...extra, after: read.values, file: read.file, key: read.key };
    if (!existing) return { ...planned, message: `Adds ${read.subject} → ${read.target}${where}`, outcome: "add" };

    const changes = Object.entries(definition.fields)
      .filter(([field]) => (existing.values[field] ?? null) !== (read.values[field] ?? null))
      .map(([field, label]) => ({ after: shown(field, read.values[field] ?? null, refs), before: shown(field, existing.values[field] ?? null, refs), label }))
      .sort((a, b) => a.label.localeCompare(b.label));
    const withBefore = { ...planned, before: existing.values, rowVersion: existing.rowVersion };
    if (changes.length === 0) return { ...withBefore, message: `${subject} is already mapped this way${where}`, outcome: "unchanged" };
    const described = changes.map((change) => `${change.label.charAt(0).toLowerCase()}${change.label.slice(1)} ${change.before} → ${change.after}`).join("; ");
    return { ...withBefore, changes, message: `Changes ${read.subject}${where}: ${described}`, outcome: "change" };
  });

  const counts: Record<Outcome, number> = { add: 0, change: 0, skip: 0, unchanged: 0 };
  for (const row of rows) counts[row.outcome] += 1;
  const fingerprint = rows.map((row) => [row.line, row.outcome, row.key, row.before, row.after, row.rowVersion]);
  return { counts, hash: sha256Hex(canonicalJson({ kind, rows: fingerprint })), kind, rows };
}

function matchBasis(cells: Record<string, string>, values: MappingValues, refs: MappingRefs): "abn" | "manual" {
  const id = Number(cells.contractor_id);
  const own = refs.contractors.get(id)?.abn?.replace(/\s+/g, "") ?? null;
  return own && values.abn && own === values.abn ? "abn" : "manual";
}
