// What a client may write through addJobEvent (beta sprint J3). Money,
// contractor, archive, flag and reopen entries are written by the handler that
// made the change, inside its own transaction, so a client can neither forge
// nor duplicate them; and a quote, invoice or PO an entry names must be on the
// entry's job.
import { Connection, TYPES } from "tedious";
import { executeQuery } from "./db";

export interface EventRefusal {
  code: string;
  error: string;
}

/** The kinds of history entry the screens write themselves. */
export const CLIENT_EVENT_TYPES: readonly string[] = [
  "acknowledged",
  "attachment_added",
  "comment",
  "creation",
  "expected_date_change",
  "onchargeable_change",
  "stalled_toggle",
  "status_change",
];

export function eventTypeRefusal(eventType: unknown): EventRefusal | null {
  if (eventType === undefined || eventType === null) return null;
  if (typeof eventType === "string" && CLIENT_EVENT_TYPES.includes(eventType)) return null;
  return {
    code: "event_type_not_allowed",
    error: "Floorplan writes that history entry itself when the change is made, so it can't be added directly.",
  };
}

export interface LinkedRecordIds {
  InvoiceID?: unknown;
  PurchaseOrderID?: unknown;
  QuoteID?: unknown;
}

const LINK_FIELDS = ["InvoiceID", "PurchaseOrderID", "QuoteID"] as const;

/** A named record id must be a positive whole number (or absent). */
export function linkedIdsInvalid(ids: LinkedRecordIds): boolean {
  return LINK_FIELDS.some((field) => {
    const value = ids[field];
    return value !== undefined && value !== null && !(typeof value === "number" && Number.isInteger(value) && value > 0);
  });
}

const idOrNull = (value: unknown): number | null => (typeof value === "number" ? value : null);

/**
 * Whether each record the entry names belongs to its job. Runs inside the
 * entry's transaction, and only when the entry names a record.
 */
export async function linkedRecordRefusal(connection: Connection, jobId: number, ids: LinkedRecordIds): Promise<EventRefusal | null> {
  const quoteId = idOrNull(ids.QuoteID);
  const invoiceId = idOrNull(ids.InvoiceID);
  const purchaseOrderId = idOrNull(ids.PurchaseOrderID);
  if (quoteId === null && invoiceId === null && purchaseOrderId === null) return null;
  const rows = await executeQuery(
    connection,
    `SELECT
       CASE WHEN @QuoteID IS NULL OR EXISTS (SELECT 1 FROM Quotes WHERE QuoteID = @QuoteID AND JobID = @JobID) THEN 1 ELSE 0 END AS QuoteOnJob,
       CASE WHEN @InvoiceID IS NULL OR EXISTS (SELECT 1 FROM JobInvoices WHERE JobInvoiceID = @InvoiceID AND JobID = @JobID) THEN 1 ELSE 0 END AS InvoiceOnJob,
       CASE WHEN @PurchaseOrderID IS NULL OR EXISTS (SELECT 1 FROM PurchaseOrders WHERE PurchaseOrderID = @PurchaseOrderID AND JobID = @JobID) THEN 1 ELSE 0 END AS PurchaseOrderOnJob`,
    [
      { name: "JobID", type: TYPES.Int, value: jobId },
      { name: "QuoteID", type: TYPES.Int, value: quoteId },
      { name: "InvoiceID", type: TYPES.Int, value: invoiceId },
      { name: "PurchaseOrderID", type: TYPES.Int, value: purchaseOrderId },
    ],
  );
  const row = rows[0] ?? {};
  const missing = [
    [row.QuoteOnJob, "quote"],
    [row.InvoiceOnJob, "invoice"],
    [row.PurchaseOrderOnJob, "purchase order"],
  ].find(([onJob]) => Number(onJob) !== 1);
  return missing ? { code: "record_not_on_job", error: `That ${missing[1]} isn't on this job.` } : null;
}
