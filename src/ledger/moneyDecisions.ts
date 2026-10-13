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

// What the decision was about, as stored in a row's `after`: the amount, who
// the money goes to, and the document's own number. Read from the table's own
// column names, so one builder serves the row a handler loaded and the row it
// reloaded after writing.

export function quoteFacts(row: SqlRow): Record<string, unknown> {
  return {
    amount: money(row.Amount),
    contractorId: (row.ContractorID as number | null | undefined) ?? null,
    contractorName: text(row.ContractorName),
    currency: text(row.Currency),
    quoteNumber: text(row.QuoteNumber),
  };
}

export function invoiceFacts(row: SqlRow): Record<string, unknown> {
  return {
    amount: money(row.Amount),
    contractorName: text(row.ContractorName),
    direction: text(row.Direction),
    invoiceNumber: text(row.InvoiceNumber),
    supplierInvoiceNumber: text(row.SupplierInvoiceNumber),
  };
}

export function purchaseOrderFacts(row: SqlRow): Record<string, unknown> {
  return {
    contractorId: (row.ContractorID as number | null | undefined) ?? null,
    contractorName: text(row.ContractorName),
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
    contractorName: text(invoice?.ContractorName),
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
 *  approvals covered, the status they held, and who gave them and when. */
export function approvalSnapshot(row: SqlRow): Record<string, unknown> {
  return {
    amount: money(row.Amount),
    approvedAt: iso(row.ApprovedAt),
    approvedBy: text(row.ApprovedBy),
    directorApprovedAt: iso(row.DirectorApprovedAt),
    directorApprovedBy: text(row.DirectorApprovedBy),
    status: text(row.Status),
  };
}

/** What a cost edit tears down on a purchase order: the old cost and cap, and
 *  the stamps of whichever markers are being cleared. */
export function purchaseOrderMarkers(row: SqlRow, cleared: { myob: boolean; sent: boolean }): Record<string, unknown> {
  return {
    costNotToExceed: money(row.CostNotToExceed),
    estimatedCost: money(row.EstimatedCost),
    ...(cleared.sent ? { sentAt: iso(row.SentAt), sentBy: text(row.SentBy) } : {}),
    ...(cleared.myob ? { myobCreatedAt: iso(row.MyobCreatedAt), myobCreatedBy: text(row.MyobCreatedBy) } : {}),
  };
}

/** A payment's amount before and after an edit, with the invoice it pays and
 *  the MYOB bill it had already been sent to, if any. */
export function paymentEdit(
  existing: SqlRow,
  amount: number,
  invoice?: SqlRow,
): { after: Record<string, unknown>; before: Record<string, unknown> } {
  const same = { jobInvoiceId: (existing.JobInvoiceID as number | null | undefined) ?? null, status: text(existing.Status) };
  return {
    after: {
      ...same,
      amount: money(amount),
      contractorName: text(invoice?.ContractorName),
      invoiceNumber: text(invoice?.InvoiceNumber),
      supplierInvoiceNumber: text(invoice?.SupplierInvoiceNumber),
    },
    before: { ...same, amount: money(existing.Amount), myobBillUid: text(existing.MyobID) },
  };
}
