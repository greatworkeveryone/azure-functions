// Every difference between two reads of the same MYOB record, except the
// fields MYOB manages itself (plan M10 review, R1). The read-back compares
// MYOB's record now with the record as Floorplan read it back after sending
// it; any other change — tax-inclusive, a line description, the memo, the
// comment, a promised date, freight — is a hand edit in MYOB, so Floorplan
// does not take MYOB's row version and "Update in MYOB" stays refused until a
// person reconciles it (decision 11).

/** MYOB keeps these up to date itself: versions, timestamps, links, status, balances and totals. */
const MANAGED = new Set([
  "AppliedToDate",
  "BalanceDueAmount",
  "BalanceDueAmountForeign",
  "LastModified",
  "LastPaymentDate",
  "RowVersion",
  "Status",
  "Subtotal",
  "SubtotalForeign",
  "TotalAmount",
  "TotalAmountForeign",
  "TotalTax",
  "TotalTaxForeign",
  "URI",
]);

/** Display names on a reference ({ UID, Name, DisplayID, … }): MYOB keeps them in step with its card file. */
const REFERENCE_DISPLAY = new Set(["Code", "DisplayID", "Name", "Number"]);

export interface RecordChange {
  after: unknown;
  before: unknown;
  path: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const blank = (value: unknown) => value === undefined || value === null;

export function recordChanges(before: unknown, after: unknown, path = ""): RecordChange[] {
  if (blank(before) && blank(after)) return [];
  if (Array.isArray(before) && Array.isArray(after)) {
    if (before.length !== after.length) return [{ after, before, path }];
    return before.flatMap((item, index) => recordChanges(item, after[index], `${path}[${index}]`));
  }
  if (isRecord(before) && isRecord(after)) {
    const reference = path !== "" && ("UID" in before || "UID" in after);
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys
      .filter((key) => !MANAGED.has(key) && !(reference && REFERENCE_DISPLAY.has(key)))
      .flatMap((key) => recordChanges(before[key], after[key], path ? `${path}.${key}` : key));
  }
  return JSON.stringify(before ?? null) === JSON.stringify(after ?? null) ? [] : [{ after, before, path }];
}

const NAMED: Record<string, string> = {
  Comment: "Comment",
  Freight: "Freight",
  "FreightTaxCode.UID": "Freight tax code",
  JournalMemo: "Memo",
  Lines: "Lines",
  PromisedDate: "Promised date",
  ShipToAddress: "Ship to",
  SupplierInvoiceNumber: "Supplier invoice number",
};

const words = (path: string) =>
  path
    .replace(/\.UID$/, "")
    .replace(/\./g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();

/** A change's path in the CFO's words: "Memo", "Line 1 description", "Promised date". */
export function changeLabel(path: string): string {
  if (NAMED[path]) return NAMED[path];
  const line = /^Lines\[(\d+)\]\.(.+)$/.exec(path);
  if (line) return `Line ${Number(line[1]) + 1} ${words(line[2])}`;
  const text = words(path);
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** A value as the CFO reads it. */
export function changeValue(value: unknown): string {
  if (blank(value) || value === "") return "(empty)";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) return `${value.length} ${value.length === 1 ? "line" : "lines"}`;
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}
