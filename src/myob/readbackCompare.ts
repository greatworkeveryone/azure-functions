// What a read-back of a Floorplan-created MYOB record means (plan M10), pure:
//   - which fields MYOB now holds differently: the money and identity fields
//     against what Floorplan sent (amount, tax-inclusive, supplier, date,
//     account, tax code, number), the status against the record as sent, and
//     every other field against the record as Floorplan read it back after
//     sending it (recordDiff.ts: memo, comment, line description, promised
//     date, freight …), leaving out what MYOB manages itself;
//   - whether the record is missing: only after two reads in a row get a 404,
//     so a one-off 404 isn't ledgered as missing and then cleared;
//   - its paid status, from the record itself: a bill by Status Closed or no
//     balance; an order by its balance only (an order is also closed by being
//     billed or received). No Payments or Banking endpoint is ever read;
//   - whether Floorplan may take MYOB's RowVersion as its own: only when
//     nothing but MYOB-managed fields (status, balance, totals, versions,
//     display names) changed. A hand edit keeps the old version, so "Update in
//     MYOB" stays refused until it is reconciled (decision 11).
// MYOB never says who changed a record, only when: the read-back says
// "changed in MYOB", never a name.

import { comparable, diffDocuments, toCents } from "./payloads";
import { changeLabel, changeValue, recordChanges } from "./recordDiff";
import { formatAud } from "./render";

export interface DiscrepancyField {
  field: string;
  floorplan: string;
  label: string;
  myob: string;
}

export interface Discrepancy {
  fields: DiscrepancyField[];
  /** Floorplan's own last action on the record: who, when, what. */
  floorplanLastTouch: { action: string; at: string; name: string } | null;
  missing: boolean;
  /** MYOB's LastModified for the record, when MYOB gave it. */
  myobLastModified: string | null;
  seenAt: string;
}

export type PaidState = "paid" | "part_paid" | "unpaid" | null;
export type ReadbackKind = "Bill" | "Order" | "Quote";

/** MyobStatus after one 404; a second in a row makes it Missing. */
export const NOT_FOUND_ONCE = "NotFound";
export const MISSING = "Missing";

export interface ReadbackVerdict {
  /** True when Floorplan may store MYOB's current RowVersion as what it last saw. */
  advanceVersion: boolean;
  discrepancy: Discrepancy | null;
  /** The first 404 in a row: recorded as not found, not yet as missing. */
  notFoundOnce: boolean;
  paid: { balanceDue: number | null; state: PaidState };
  status: string | null;
}

const LABELS: Record<string, string> = {
  accountUids: "Account",
  date: "Date",
  isTaxInclusive: "Tax inclusive",
  number: "Number",
  supplierUid: "Supplier",
  taxCodeUids: "Tax code",
  total: "Amount",
};

/** Paths the sent-vs-MYOB comparison already covers. */
const HEADLINE = /^(Date|Number|IsTaxInclusive|Supplier\.UID|Lines\[\d+\]\.(Total|Account\.UID|TaxCode\.UID))$/;

function name(value: unknown, keys: string[]): string | null {
  if (!value || typeof value !== "object") return null;
  for (const key of keys) {
    const found = (value as Record<string, unknown>)[key];
    if (typeof found === "string" && found) return found;
  }
  return null;
}

function lineNames(record: Record<string, unknown>, key: "Account" | "TaxCode"): string {
  const lines = Array.isArray(record.Lines) ? (record.Lines as Record<string, unknown>[]) : [];
  const names = lines.map((line) => name(line[key], key === "Account" ? ["DisplayID", "Name", "UID"] : ["Code", "UID"]) ?? "?");
  return names.join(", ") || "none";
}

function show(field: string, record: Record<string, unknown>, fallback: unknown): string {
  if (field === "total") return formatAud(Number(fallback));
  if (field === "isTaxInclusive") return fallback ? "Yes" : "No";
  if (field === "supplierUid") return name(record.Supplier, ["Name", "UID"]) ?? String(fallback);
  if (field === "accountUids") return lineNames(record, "Account");
  if (field === "taxCodeUids") return lineNames(record, "TaxCode");
  return String(fallback);
}

export function paidState(record: Record<string, unknown> | null, kind: ReadbackKind): { balanceDue: number | null; state: PaidState } {
  if (kind === "Quote" || !record || record.BalanceDueAmount === undefined || record.BalanceDueAmount === null) return { balanceDue: null, state: null };
  const balance = toCents(Number(record.BalanceDueAmount));
  const total = toCents(Number(record.TotalAmount ?? NaN));
  const settled = kind === "Bill" ? record.Status === "Closed" || balance === 0 : balance === 0 && Number.isFinite(total) && total > 0;
  if (settled) return { balanceDue: 0, state: "paid" };
  return { balanceDue: balance, state: Number.isFinite(total) && balance < total ? "part_paid" : "unpaid" };
}

export function compareReadback(input: {
  floorplanLastTouch: Discrepancy["floorplanLastTouch"];
  kind: ReadbackKind;
  /** The record as Floorplan read it back after sending it: the baseline for everything but the headline fields. */
  lastSeen: Record<string, unknown> | null;
  /** MYOB's record now; null when MYOB says it no longer exists. */
  myob: Record<string, unknown> | null;
  now: Date;
  /** MyobStatus from the last read-back (NotFound after one 404). */
  previousStatus: string | null;
  /** What Floorplan sent: the proposal's payload. */
  sent: Record<string, unknown>;
  /** What the sent payload's Floorplan fields read as, for the "Floorplan" side. */
  sentLabels: { supplier: string };
}): ReadbackVerdict {
  const seenAt = input.now.toISOString();
  const nothingPaid = { balanceDue: null, state: null };
  if (!input.myob) {
    if (input.previousStatus !== NOT_FOUND_ONCE && input.previousStatus !== MISSING) {
      return { advanceVersion: false, discrepancy: null, notFoundOnce: true, paid: nothingPaid, status: NOT_FOUND_ONCE };
    }
    return {
      advanceVersion: false,
      discrepancy: { fields: [], floorplanLastTouch: input.floorplanLastTouch, missing: true, myobLastModified: null, seenAt },
      notFoundOnce: false,
      paid: nothingPaid,
      status: MISSING,
    };
  }
  const myob = input.myob;
  const sent = comparable(input.sent);
  const fields: DiscrepancyField[] = diffDocuments(input.sent, myob).map((diff) => ({
    field: diff.field,
    floorplan: diff.field === "supplierUid" ? input.sentLabels.supplier : show(diff.field, input.sent, sent[diff.field]),
    label: LABELS[diff.field] ?? diff.field,
    myob: show(diff.field, myob, diff.myob),
  }));
  const others = input.lastSeen ? recordChanges(input.lastSeen, myob).filter((change) => !HEADLINE.test(change.path)) : [];
  for (const change of others) {
    fields.push({ field: change.path, floorplan: changeValue(change.before), label: changeLabel(change.path), myob: changeValue(change.after) });
  }
  const contentMatches = input.lastSeen !== null && fields.length === 0;

  const status = typeof myob.Status === "string" ? myob.Status : null;
  const statusThen = typeof input.lastSeen?.Status === "string" ? input.lastSeen.Status : null;
  const paid = paidState(myob, input.kind);
  // A record being paid is its paid status, shown as such, not a disagreement.
  if (status && statusThen && status !== statusThen && paid.state !== "paid" && paid.state !== "part_paid") {
    fields.push({ field: "status", floorplan: statusThen, label: "Status", myob: status });
  }
  const discrepancy: Discrepancy | null = fields.length
    ? {
        fields,
        floorplanLastTouch: input.floorplanLastTouch,
        missing: false,
        myobLastModified: typeof myob.LastModified === "string" ? myob.LastModified : null,
        seenAt,
      }
    : null;
  return { advanceVersion: contentMatches, discrepancy, notFoundOnce: false, paid, status };
}
