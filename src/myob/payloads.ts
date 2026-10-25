// MYOB Service Quote / Order / Bill payloads (AccountRight API v2, Purchase).
// Shapes per the developer docs as cited in audit myob-money.md §11 (service
// order and service bill pages); field limits are verified in the lab (M5):
//   Number          ≤ 13 characters (Johanne's reference format)
//   Date            today in Darwin, "YYYY-MM-DDT00:00:00"
//   Supplier        { UID } of the mapped supplier card
//   IsTaxInclusive  true: Floorplan amounts are inc GST
//   Lines[]         Type "Transaction", Description, Total, Account { UID }, TaxCode { UID }
//   FreightTaxCode  the lines' tax code (no freight is charged)
//   JournalMemo, Comment  the decision-13 attribution
// A bill is built the same way but stays disabled (BILLS_ENABLED) until the CFO
// answers Appendix B: the documented order-to-bill path rewrites the order.

export const BILLS_ENABLED = false;
export const MYOB_NUMBER_MAX = 13;
const DESCRIPTION_MAX = 255;

export type MyobDocumentKind = "Bill" | "Order" | "Quote";

export interface DocumentLine {
  accountUid: string;
  description: string;
  taxCodeUid: string;
  /** Inc GST, in dollars. */
  total: number;
}

export interface DocumentFacts {
  comment: string;
  /** "YYYY-MM-DDT00:00:00", today in Darwin. */
  date: string;
  journalMemo: string;
  kind: MyobDocumentKind;
  lines: readonly DocumentLine[];
  number: string;
  supplierInvoiceNumber?: string | null;
  supplierUid: string;
}

export const toCents = (amount: number) => Math.round(amount * 100) / 100;

export function buildServiceDocument(facts: DocumentFacts): Record<string, unknown> {
  if (facts.lines.length === 0) throw new Error("A MYOB document needs at least one line");
  if (facts.number.length > MYOB_NUMBER_MAX) throw new Error(`MYOB numbers are at most ${MYOB_NUMBER_MAX} characters`);
  const document: Record<string, unknown> = {
    Comment: facts.comment,
    Date: facts.date,
    FreightTaxCode: { UID: facts.lines[0].taxCodeUid },
    IsTaxInclusive: true,
    JournalMemo: facts.journalMemo,
    Lines: facts.lines.map((line) => ({
      Account: { UID: line.accountUid },
      Description: line.description.slice(0, DESCRIPTION_MAX),
      TaxCode: { UID: line.taxCodeUid },
      Total: toCents(line.total),
      Type: "Transaction",
    })),
    Number: facts.number,
    Supplier: { UID: facts.supplierUid },
  };
  if (facts.kind === "Bill" && facts.supplierInvoiceNumber) document.SupplierInvoiceNumber = facts.supplierInvoiceNumber;
  return document;
}

/** The fields compared when reading a record back: what Floorplan sent vs what MYOB holds. */
export interface ComparableDocument {
  accountUids: string[];
  date: string;
  /** Money: the same line totals mean 10% more or less once this flips. */
  isTaxInclusive: boolean;
  number: string;
  supplierUid: string;
  taxCodeUids: string[];
  total: number;
}

const uid = (value: unknown) => (value && typeof value === "object" ? String((value as { UID?: unknown }).UID ?? "").toLowerCase() : "");

export function comparable(document: Record<string, unknown>): ComparableDocument {
  const lines = Array.isArray(document.Lines) ? (document.Lines as Record<string, unknown>[]) : [];
  const transactions = lines.filter((line) => line.Type === undefined || line.Type === "Transaction");
  return {
    accountUids: transactions.map((line) => uid(line.Account)),
    date: String(document.Date ?? "").slice(0, 10),
    isTaxInclusive: document.IsTaxInclusive === true,
    number: String(document.Number ?? ""),
    supplierUid: uid(document.Supplier),
    taxCodeUids: transactions.map((line) => uid(line.TaxCode)),
    total: toCents(transactions.reduce((sum, line) => sum + Number(line.Total ?? 0), 0)),
  };
}

export interface FieldDiff {
  field: keyof ComparableDocument;
  myob: unknown;
  sent: unknown;
}

/** Field-level differences between what was sent and what MYOB returned. Empty means it matches. */
export function diffDocuments(sent: Record<string, unknown>, myob: Record<string, unknown>): FieldDiff[] {
  const a = comparable(sent);
  const b = comparable(myob);
  return (Object.keys(a) as (keyof ComparableDocument)[])
    .filter((field) => JSON.stringify(a[field]) !== JSON.stringify(b[field]))
    .map((field) => ({ field, myob: b[field], sent: a[field] }));
}

const DRIFT_LABELS: Record<Exclude<keyof ComparableDocument, "date"> | "description", string> = {
  accountUids: "account",
  description: "description",
  isTaxInclusive: "tax inclusive",
  number: "number",
  supplierUid: "supplier",
  taxCodeUids: "tax code",
  total: "amount",
};

const descriptions = (document: Record<string, unknown>) =>
  (Array.isArray(document.Lines) ? (document.Lines as Record<string, unknown>[]) : []).map((line) => String(line.Description ?? ""));

/**
 * What differs between the document a person proposed and the one rebuilt at
 * approval, in plain words. The date and the attribution are left out: a create
 * is dated the day it is approved, and approval adds the approver's name.
 */
export function proposalDrift(proposed: Record<string, unknown>, rebuilt: Record<string, unknown>): string[] {
  const drift = diffDocuments(proposed, rebuilt)
    .filter((diff) => diff.field !== "date")
    .map((diff) => DRIFT_LABELS[diff.field as Exclude<keyof ComparableDocument, "date">]);
  if (JSON.stringify(descriptions(proposed)) !== JSON.stringify(descriptions(rebuilt))) drift.push(DRIFT_LABELS.description);
  return drift;
}
