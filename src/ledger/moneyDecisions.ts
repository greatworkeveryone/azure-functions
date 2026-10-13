import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlRow } from "../db";
import { LEDGER_LIMITS } from "./validate";

// Helpers shared by the quote, invoice, purchase order and payment handlers
// that record their decisions in the ledger (WP19b). Deliberately not
// re-exported from ./index: other packages' tests replace that module wholesale
// with jest.mock("../ledger"), and these must keep working underneath it.

export interface LedgerScope {
  buildingId: number | null;
  jobId: number | null;
}

/** jobId and buildingId for a ledger row, taken from the job the decision
 *  belongs to, so history filters by building without joins. */
export async function jobScope(
  connection: Connection,
  jobId: number | null | undefined,
): Promise<LedgerScope> {
  if (jobId === null || jobId === undefined) return { buildingId: null, jobId: null };
  const rows = await executeQuery(connection, "SELECT BuildingID FROM Jobs WHERE JobID = @JobID", [
    { name: "JobID", type: TYPES.Int, value: jobId },
  ]);
  return { buildingId: (rows[0]?.BuildingID as number | null | undefined) ?? null, jobId };
}

/** A free-text note as a ledger reason. Endpoints accept longer notes than the
 *  ledger column holds; clipping keeps a long note from failing the decision
 *  (the full text stays on the job's event). */
export function ledgerReason(text: unknown): string | undefined {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  return trimmed ? trimmed.slice(0, LEDGER_LIMITS.reason) : undefined;
}

// Same words as DenyReason / ApprovalBasis in approvalAuthority.ts, so history
// reads the same before and after the authority module is wired in (WP43a-2).
export type ApprovalRule = "director_threshold" | "over_limit" | "own_authority";

/** Why an approval landed where it did: past every other role's limit it needs
 *  the director, otherwise the caller's own limit covers it or it waits for
 *  someone with more authority. */
export function approvalRule(input: { directorNeeded: boolean; userCanApprove: boolean }): ApprovalRule {
  if (input.directorNeeded) return "director_threshold";
  return input.userCanApprove ? "own_authority" : "over_limit";
}

function money(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const amount = Number(value);
  return Number.isFinite(amount) ? amount : null;
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function iso(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const when = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(when.getTime()) ? null : when.toISOString();
}

/** Who a record is for, under the keys every money row carries, in `before` as
 *  in `after`. Quotes and orders hold the contractor's id; an invoice row
 *  carries it once withContractorId has looked it up. */
export function contractorFacts(row: SqlRow): { contractorId: number | null; contractorName: string | null } {
  return {
    contractorId: (row.ContractorID as number | null | undefined) ?? null,
    contractorName: text(row.ContractorName),
  };
}

// What the decision was about, as stored in a row's `after`: the amount, who
// the money goes to, and the document's own number. Read from the table's own
// column names, so one builder serves the row a handler loaded and the row it
// reloaded after writing.

export function quoteFacts(row: SqlRow): Record<string, unknown> {
  return {
    amount: money(row.Amount),
    ...contractorFacts(row),
    currency: text(row.Currency),
    quoteNumber: text(row.QuoteNumber),
  };
}

export function invoiceFacts(row: SqlRow): Record<string, unknown> {
  return {
    amount: money(row.Amount),
    ...contractorFacts(row),
    direction: text(row.Direction),
    invoiceNumber: text(row.InvoiceNumber),
    supplierInvoiceNumber: text(row.SupplierInvoiceNumber),
  };
}

// A purchase order has no amount column: its estimated cost is the amount, as
// the director's packet treats it too.
export function purchaseOrderFacts(row: SqlRow): Record<string, unknown> {
  return {
    amount: money(row.EstimatedCost),
    ...contractorFacts(row),
    costNotToExceed: money(row.CostNotToExceed),
    estimatedCost: money(row.EstimatedCost),
    poNumber: text(row.PONumber),
  };
}

/** A payment, and the invoice it pays (whose contractor and supplier number say
 *  who the money went to; a payment row doesn't carry them). */
export function paymentFacts(row: SqlRow, invoice?: SqlRow): Record<string, unknown> {
  return {
    amount: money(row.Amount),
    ...contractorFacts(invoice ?? {}),
    invoiceNumber: text(invoice?.InvoiceNumber),
    jobInvoiceId: (row.JobInvoiceID as number | null | undefined) ?? null,
    myobBillUid: text(row.MyobID),
    purchaseOrderId: (row.PurchaseOrderID as number | null | undefined) ?? null,
    quoteId: (row.QuoteID as number | null | undefined) ?? null,
    supplierInvoiceNumber: text(invoice?.SupplierInvoiceNumber),
  };
}

// A record as it stood, for `before` when a decision undoes or removes it:
// the facts above, the status, and the approvals, markings and file references
// the decision is about to clear or take with the row.

export function quoteSnapshot(row: SqlRow): Record<string, unknown> {
  return {
    ...quoteFacts(row),
    approvedAt: iso(row.ApprovedAt),
    approvedBy: text(row.ApprovedBy),
    directorApprovedAt: iso(row.DirectorApprovedAt),
    directorApprovedBy: text(row.DirectorApprovedBy),
    pdfBlobName: text(row.QuotePDFBlobName),
    status: text(row.Status),
  };
}

export function invoiceSnapshot(row: SqlRow): Record<string, unknown> {
  return {
    ...invoiceFacts(row),
    approvedAt: iso(row.ApprovedAt),
    approvedBy: text(row.ApprovedBy),
    currency: text(row.Currency),
    directorApprovedAt: iso(row.DirectorApprovedAt),
    directorApprovedBy: text(row.DirectorApprovedBy),
    myobCreatedAt: iso(row.MyobCreatedAt),
    myobCreatedBy: text(row.MyobCreatedBy),
    pdfBlobName: text(row.InvoicePDFBlobName),
    status: text(row.Status),
  };
}

export function purchaseOrderSnapshot(row: SqlRow): Record<string, unknown> {
  return {
    ...purchaseOrderFacts(row),
    completedAt: iso(row.CompletedAt),
    completedBy: text(row.CompletedBy),
    myobCreatedAt: iso(row.MyobCreatedAt),
    myobCreatedBy: text(row.MyobCreatedBy),
    pdfBlobName: text(row.PDFBlobName),
    sentAt: iso(row.SentAt),
    sentBy: text(row.SentBy),
  };
}

/** What an amount edit tears down on a quote or invoice: the amount the
 *  approvals covered, who it is for, the status they held, and who gave the
 *  approvals and when. */
export function approvalSnapshot(row: SqlRow): Record<string, unknown> {
  return {
    amount: money(row.Amount),
    approvedAt: iso(row.ApprovedAt),
    approvedBy: text(row.ApprovedBy),
    ...contractorFacts(row),
    directorApprovedAt: iso(row.DirectorApprovedAt),
    directorApprovedBy: text(row.DirectorApprovedBy),
    status: text(row.Status),
  };
}

/** What a cost edit tears down on a purchase order: the order as it stood (cost,
 *  cap, who it is for) and the stamps of whichever markers are being cleared. */
export function purchaseOrderMarkers(row: SqlRow, cleared: { myob: boolean; sent: boolean }): Record<string, unknown> {
  return {
    ...purchaseOrderFacts(row),
    ...(cleared.sent ? { sentAt: iso(row.SentAt), sentBy: text(row.SentBy) } : {}),
    ...(cleared.myob ? { myobCreatedAt: iso(row.MyobCreatedAt), myobCreatedBy: text(row.MyobCreatedBy) } : {}),
  };
}

/** A payment's amount before and after an edit, with the invoice it pays, who
 *  the money is for, and the MYOB bill it had already been sent to, if any. The
 *  invoice it pays is the approval its amount is measured against. */
export function paymentEdit(
  existing: SqlRow,
  amount: number,
  invoice?: SqlRow,
): { after: Record<string, unknown>; before: Record<string, unknown> } {
  const same = {
    ...contractorFacts(invoice ?? {}),
    jobInvoiceId: (existing.JobInvoiceID as number | null | undefined) ?? null,
    status: text(existing.Status),
  };
  return {
    after: {
      ...same,
      amount: money(amount),
      ...amountChange({ approved: invoice?.Amount, next: amount, previous: existing.Amount }),
      invoiceNumber: text(invoice?.InvoiceNumber),
      supplierInvoiceNumber: text(invoice?.SupplierInvoiceNumber),
    },
    before: { ...same, amount: money(existing.Amount), myobBillUid: text(existing.MyobID) },
  };
}

// Amounts and contractors, for the trend reports directors and the CFO read
// straight from the ledger (LAUNCH-READINESS R14): tolerance use, amounts just
// under a threshold, splitting across orders, edits after approval, one user's
// share of a contractor's work. Every money row says what it is worth in
// `amount` and who it is for in `contractorId`/`contractorName`, under the same
// keys whatever the record; every adjustment (an edit, a reversal or a
// deletion) also says how far it moved the amount.

/** What a decision moved a record's amount by, under the keys the reports read. */
export interface AmountChange {
  /** newAmount - previousAmount, to the cent. */
  delta: number | null;
  /** delta as a percentage of previousAmount, to 2 places; null when that is 0 or unknown. */
  deltaPercent: number | null;
  newAmount: number | null;
  /** The amount an approval covered, when there is an approval to measure against. */
  originalApprovedAmount: number | null;
  previousAmount: number | null;
}

const toCents = (value: number): number => Math.round(value * 100);

/**
 * `previous` and `next` are the record's amount before and after the decision;
 * `approved` is the amount an approval covered, when there is one. An unknown
 * amount counts as nothing for the arithmetic but is left null in the row.
 */
export function amountChange(input: { approved?: unknown; next: unknown; previous: unknown }): AmountChange {
  const previousAmount = money(input.previous);
  const newAmount = money(input.next);
  const previousCents = previousAmount === null ? 0 : toCents(previousAmount);
  const deltaCents = (newAmount === null ? 0 : toCents(newAmount)) - previousCents;
  const known = previousAmount !== null || newAmount !== null;
  return {
    delta: known ? deltaCents / 100 : null,
    deltaPercent: known && previousCents !== 0 ? Math.round((deltaCents * 10000) / previousCents) / 100 : null,
    newAmount,
    originalApprovedAmount: money(input.approved),
    previousAmount,
  };
}

/** A reversal: the record stays and its amount with it, but an approval or a
 *  marking is undone. */
export function amountUnchanged(amount: unknown, approved?: unknown): AmountChange {
  return amountChange({ approved, next: amount, previous: amount });
}

/** A deletion: the record goes, and with it its amount. */
export function amountRemoved(amount: unknown, approved?: unknown): AmountChange {
  return amountChange({ approved, next: 0, previous: amount });
}

/** `after` for a deletion: who the record was for and what it was worth, with
 *  nothing left. The record itself is in `before`. */
export function deletionAfter(facts: Record<string, unknown>, approved?: unknown): Record<string, unknown> {
  return {
    amount: 0,
    contractorId: facts.contractorId ?? null,
    contractorName: facts.contractorName ?? null,
    deleted: true,
    ...amountRemoved(facts.amount, approved),
  };
}

/** The amount a quote or invoice was approved at, once it has been approved.
 *  Editing an approved amount undoes the approval, so this is its amount now. */
export function approvedAmount(row: SqlRow): number | null {
  return row.ApprovedAt != null || row.DirectorApprovedAt != null ? money(row.Amount) : null;
}

/** The amount of the quote approved for a job, which its purchase orders are
 *  measured against. Null when the job has none. */
export async function approvedQuoteAmount(connection: Connection, jobId: number | null | undefined): Promise<number | null> {
  if (jobId === null || jobId === undefined) return null;
  const rows = await executeQuery(
    connection,
    "SELECT q.Amount FROM Jobs j INNER JOIN Quotes q ON q.QuoteID = j.ApprovedQuoteID WHERE j.JobID = @JobID",
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  return money(rows[0]?.Amount);
}

/**
 * For an invoice that has no contractor id of its own (one made from free text,
 * or before migration 112), the id a ledger row carries is looked up from the
 * name: the one dbo.Contractors row that has it. A name nobody holds, or several
 * do, leaves it null rather than guessed at. A lookup that fails is logged and
 * leaves it null too: the id is worth recording, not worth losing the decision
 * over.
 */
export async function contractorIdForName(connection: Connection, name: unknown): Promise<number | null> {
  const trimmed = typeof name === "string" ? name.trim() : "";
  if (!trimmed) return null;
  try {
    const rows = await executeQuery(connection, "SELECT TOP 2 ContractorID FROM dbo.Contractors WHERE ContractorName = @Name", [
      { name: "Name", type: TYPES.NVarChar, value: trimmed },
    ]);
    return rows.length === 1 ? ((rows[0].ContractorID as number | null | undefined) ?? null) : null;
  } catch (err) {
    console.warn("[ledger] could not look up the contractor id for an invoice:", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * An invoice row with the contractor id its ledger facts need: the id the
 * invoice recorded when it was made (JobInvoices.ContractorID) if it has one,
 * and only otherwise the one looked up from its name (see above). The row has to
 * be read with its ContractorID column for the first to apply.
 */
export async function withContractorId(connection: Connection, row: SqlRow): Promise<SqlRow> {
  if (typeof row.ContractorID === "number") return row;
  return { ...row, ContractorID: await contractorIdForName(connection, row.ContractorName) };
}
