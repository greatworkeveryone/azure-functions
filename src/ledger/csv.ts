import { darwinFileDate, formatDarwinDateTime } from "./darwinTime";
import type { DecisionRow } from "./rows";

// Excel reads a UTF-8 CSV as ANSI unless it opens with a byte order mark, which
// garbles any accented name in the Actor columns.
const BOM = "﻿";

// A text cell starting with one of these is read by Excel and Sheets as a
// formula. The Reason and name columns hold free text typed by staff, and the
// CFO opens this file in a spreadsheet, so neutralise them with a leading quote.
const FORMULA_START = /^[=+\-@\t\r]/;

function quote(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

/** Free text: neutralised against formula injection, then quoted if needed. */
function text(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  return quote(FORMULA_START.test(value) ? `'${value}` : value);
}

/** Numbers and ids we format ourselves cannot start a formula; leave them bare. */
function bare(value: number | null): string {
  return value === null ? "" : String(value);
}

function json(value: unknown): string {
  return value === null || value === undefined ? "" : quote(JSON.stringify(value));
}

export const DECISIONS_CSV_HEADERS = [
  "Ledger ID",
  "Date (Darwin)",
  "Action",
  "Subject type",
  "Subject ID",
  "Tenancy ID",
  "Job ID",
  "Building ID",
  "Actor",
  "Actor role",
  "Actor type",
  "Attributed to",
  "Attributed role",
  "Reason",
  "Financial impact (AUD)",
  "Rule applied",
  "Exception",
  "Before",
  "After",
  "Computed",
  "Correlation ID",
] as const;

function csvLine(row: DecisionRow): string {
  return [
    bare(row.ledgerId),
    formatDarwinDateTime(new Date(row.occurredAt)),
    text(row.action),
    text(row.subjectType),
    text(row.subjectId),
    bare(row.tenantId),
    bare(row.jobId),
    bare(row.buildingId),
    text(row.actor.name),
    text(row.actor.role),
    row.actor.kind,
    text(row.attributedTo?.name),
    text(row.attributedTo?.role),
    text(row.reason),
    row.financialImpact === null ? "" : row.financialImpact.toFixed(2),
    text(row.ruleApplied),
    row.isException ? "Yes" : "No",
    json(row.before),
    json(row.after),
    json(row.computed),
    row.correlationId,
  ].join(",");
}

/** RFC 4180: CRLF line endings, header row first. Dates are DD/MM/YYYY HH:mm in
 *  Darwin time, never month-first. */
export function decisionsToCsv(rows: readonly DecisionRow[]): string {
  const lines = [DECISIONS_CSV_HEADERS.join(","), ...rows.map(csvLine)];
  return `${BOM}${lines.join("\r\n")}\r\n`;
}

/** decisions-YYYYMMDD.csv, dated by the Darwin calendar. */
export function decisionsCsvFileName(now: Date): string {
  return `decisions-${darwinFileDate(now)}.csv`;
}
