// What a read-back of a Floorplan-created MYOB record means (plan M10), pure:
//   - which fields MYOB now holds differently from what Floorplan sent
//     (amount, supplier, date, account, tax code, number, status), or that the
//     record is missing in MYOB;
//   - its paid status, from the record itself (a bill's Status and
//     BalanceDueAmount): no Payments or Banking endpoint is ever read;
//   - whether Floorplan may take MYOB's RowVersion as its own, which it does
//     only when the content still matches. A record someone changed in MYOB
//     keeps the old version, so "Update in MYOB" stays refused until the
//     difference is reconciled.
// MYOB never says who changed a record, only when: the read-back says
// "changed in MYOB", never a name.

import { comparable, diffDocuments, toCents } from "./payloads";
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

export interface ReadbackVerdict {
  /** True when Floorplan may store MYOB's current RowVersion as what it last saw. */
  advanceVersion: boolean;
  discrepancy: Discrepancy | null;
  paid: { balanceDue: number | null; state: PaidState };
  status: string | null;
}

const LABELS: Record<string, string> = {
  accountUids: "Account",
  date: "Date",
  number: "Number",
  supplierUid: "Supplier",
  taxCodeUids: "Tax code",
  total: "Amount",
};

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
  if (field === "supplierUid") return name(record.Supplier, ["Name", "UID"]) ?? String(fallback);
  if (field === "accountUids") return lineNames(record, "Account");
  if (field === "taxCodeUids") return lineNames(record, "TaxCode");
  return String(fallback);
}

export function paidState(record: Record<string, unknown> | null): { balanceDue: number | null; state: PaidState } {
  if (!record || record.BalanceDueAmount === undefined || record.BalanceDueAmount === null) return { balanceDue: null, state: null };
  const balance = toCents(Number(record.BalanceDueAmount));
  const total = toCents(Number(record.TotalAmount ?? NaN));
  if (record.Status === "Closed" || balance === 0) return { balanceDue: 0, state: "paid" };
  return { balanceDue: balance, state: Number.isFinite(total) && balance < total ? "part_paid" : "unpaid" };
}

export function compareReadback(input: {
  floorplanLastTouch: Discrepancy["floorplanLastTouch"];
  /** What Floorplan last saw, for status (the read-back when it was sent). */
  lastSeen: Record<string, unknown> | null;
  /** MYOB's record now; null when MYOB says it no longer exists. */
  myob: Record<string, unknown> | null;
  now: Date;
  /** What Floorplan sent: the proposal's payload. */
  sent: Record<string, unknown>;
  /** What the sent payload's Floorplan fields read as, for the "Floorplan" side. */
  sentLabels: { supplier: string };
}): ReadbackVerdict {
  const seenAt = input.now.toISOString();
  if (!input.myob) {
    return {
      advanceVersion: false,
      discrepancy: { fields: [], floorplanLastTouch: input.floorplanLastTouch, missing: true, myobLastModified: null, seenAt },
      paid: { balanceDue: null, state: null },
      status: "Missing",
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
  const status = typeof myob.Status === "string" ? myob.Status : null;
  const statusThen = typeof input.lastSeen?.Status === "string" ? input.lastSeen.Status : null;
  const paid = paidState(myob);
  // A bill being paid is its paid status, shown as such, not a disagreement.
  if (status && statusThen && status !== statusThen && paid.state !== "paid" && paid.state !== "part_paid") {
    fields.push({ field: "status", floorplan: statusThen, label: "Status", myob: status });
  }
  const contentMatches = fields.every((field) => field.field === "status");
  const discrepancy: Discrepancy | null = fields.length
    ? {
        fields,
        floorplanLastTouch: input.floorplanLastTouch,
        missing: false,
        myobLastModified: typeof myob.LastModified === "string" ? myob.LastModified : null,
        seenAt,
      }
    : null;
  return { advanceVersion: contentMatches, discrepancy, paid, status };
}
