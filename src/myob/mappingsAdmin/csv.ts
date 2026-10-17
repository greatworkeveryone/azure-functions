// The CSV Johanne imports and exports for MYOB mappings (plan M2): RFC 4180
// (quoted cells, doubled quotes, line breaks inside quotes, CRLF or LF, an
// optional BOM). Columns are matched by name, lower-cased with spaces as
// underscores, so a re-saved spreadsheet still reads. Exported cells that a
// spreadsheet would run as a formula are prefixed with an apostrophe.

export const MAX_CSV_ROWS = 5000;

export class CsvError extends Error {}

export interface CsvRow {
  cells: Record<string, string>;
  /** The line the row starts on, counting the header as line 1, for "row N" in outcomes. */
  line: number;
}

const columnName = (raw: string) => raw.trim().toLowerCase().replace(/\s+/g, "_");

function records(text: string): { fields: string[]; line: number }[] {
  const out: { fields: string[]; line: number }[] = [];
  let fields: string[] = [];
  let cell = "";
  let quoted = false;
  let line = 1;
  let start = 1;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else {
        if (char === "\n") line += 1;
        cell += char;
      }
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === ",") {
      fields.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[i + 1] === "\n") i += 1;
      fields.push(cell);
      out.push({ fields, line: start });
      fields = [];
      cell = "";
      line += 1;
      start = line;
    } else cell += char;
  }
  if (quoted) throw new CsvError(`A quote opened on line ${start} is never closed`);
  if (cell !== "" || fields.length > 0) {
    fields.push(cell);
    out.push({ fields, line: start });
  }
  return out.filter((record) => record.fields.some((field) => field.trim() !== ""));
}

export function parseCsv(text: string): { header: string[]; rows: CsvRow[] } {
  const all = records(text.replace(/^﻿/, ""));
  if (all.length === 0) throw new CsvError("The file is empty");
  const header = all[0].fields.map(columnName);
  const repeated = header.find((name, index) => name && header.indexOf(name) !== index);
  if (repeated) throw new CsvError(`The column "${repeated}" appears twice`);
  const rows = all.slice(1);
  if (rows.length === 0) throw new CsvError("The file has a header but no rows");
  if (rows.length > MAX_CSV_ROWS) throw new CsvError(`The file has more than ${MAX_CSV_ROWS.toLocaleString("en-AU")} rows; split it`);
  return {
    header,
    rows: rows.map((record) => ({
      cells: Object.fromEntries(header.map((name, index) => [name, (record.fields[index] ?? "").trim()]).filter(([name]) => name)),
      line: record.line,
    })),
  };
}

const FORMULA = /^[=+\-@\t\r]/;

function cell(value: string): string {
  const safe = FORMULA.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
