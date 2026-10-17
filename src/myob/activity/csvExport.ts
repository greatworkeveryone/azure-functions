// A CSV a spreadsheet opens safely: quoted where needed, and any cell a
// spreadsheet would run as a formula (= + - @, tab, carriage return) prefixed
// with an apostrophe. (Plan M2's mappings import has the same writer in
// mappingsAdmin/csv.ts; fold the two together when both are merged.)

const FORMULA = /^[=+\-@\t\r]/;

function cell(value: string): string {
  const safe = FORMULA.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(header: string[], rows: string[][]): string {
  return [header, ...rows].map((row) => row.map(cell).join(",")).join("\r\n") + "\r\n";
}
