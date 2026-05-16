// src/pdf/job-packet-loader.ts
//
// Fetches all records + blobs needed to build a job packet. Returns a
// PacketInput ready for buildJobPacket().
//
// All "optional" sections (quote, PO, invoice, attachments) gracefully
// resolve to null / [] when missing — this is what lets the download
// work at any stage of the job.

import { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "../db";
import { downloadBlob } from "../blob-storage";
import type {
  PacketInput,
  PacketJob,
  PacketQuote,
  PacketPurchaseOrder,
  PacketInvoice,
  PacketAttachment,
} from "./job-packet";

export async function loadJobPacketInputs(
  connection: Connection,
  jobId: number,
): Promise<PacketInput> {
  const job = await loadJob(connection, jobId);
  if (!job) throw new Error(`Job ${jobId} not found`);

  // Tedious connections can only run ONE query at a time — Promise.all on the
  // same connection throws "Requests can only be made in the LoggedIn state,
  // not the SentClientRequest state". Serialize the loads instead.
  const selectedQuote = await loadSelectedQuote(connection, jobId);
  const purchaseOrder = await loadPurchaseOrder(connection, jobId);
  const invoice = await loadInvoice(connection, jobId);
  const jobAttachments = await loadJobAttachments(connection, jobId);
  const pointAttachments = await loadSourcePointAttachments(connection, jobId);

  return {
    job,
    selectedQuote,
    purchaseOrder,
    invoice,
    jobAttachments,
    sourcePointAttachments: pointAttachments,
  };
}

async function loadJob(connection: Connection, jobId: number): Promise<PacketJob | null> {
  const rows = await executeQuery(
    connection,
    `SELECT JobID, Title, Description, TenantName, CreatedBy, Status,
            CreatedAt, IsOnchargeable, ApprovedQuoteID, SourceInspectionPointId
       FROM Jobs WHERE JobID = @JobID`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.JobID as number,
    title: (r.Title as string) ?? "(untitled)",
    // BuildingName doesn't exist; TenantName is the closest equivalent
    buildingName: (r.TenantName as string) ?? "",
    // RequestedBy doesn't exist; CreatedBy is the closest equivalent
    requestedBy: (r.CreatedBy as string) ?? "",
    status: (r.Status as string) ?? "",
    createdDate: r.CreatedAt as Date,
    oncharge: Boolean(r.IsOnchargeable),
    description: (r.Description as string) ?? undefined,
  };
}

async function loadSelectedQuote(
  connection: Connection,
  jobId: number,
): Promise<PacketQuote | null> {
  // Prefer the quote currently AWAITING director sign-off — that's the one the
  // director is being asked to approve. Falls back to the job's
  // ApprovedQuoteID (set after full approval).
  const rows = await executeQuery(
    connection,
    `SELECT TOP 1 q.QuoteID, q.QuoteNumber, q.ContractorName, q.Amount,
            ISNULL(q.Currency, 'AUD') AS Currency, q.QuotePDFBlobName, q.Status
       FROM Quotes q
       LEFT JOIN Jobs j ON j.JobID = q.JobID
      WHERE q.JobID = @JobID
        AND (q.Status = 'awaiting_director' OR q.QuoteID = j.ApprovedQuoteID)
      ORDER BY CASE WHEN q.Status = 'awaiting_director' THEN 0 ELSE 1 END,
               q.QuoteID DESC`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  const quoteId = r.QuoteID as number;
  return {
    id: quoteId,
    contractorName: (r.ContractorName as string) ?? "",
    amount: Number(r.Amount ?? 0),
    currency: r.Currency as string,
    quoteNumber: (r.QuoteNumber as string) ?? null,
    pdfBytes: await maybeLoadBlob(r.QuotePDFBlobName as string | null),
    linkedAttachmentFileNames: await loadQuoteAttachmentFileNames(connection, quoteId),
  };
}

/** Filenames of every attachment linked to a specific quote via QuoteAttachments.
 *  Used by the cover renderer to surface non-PDF/non-image files under the
 *  quote section so the director sees them explicitly. */
async function loadQuoteAttachmentFileNames(
  connection: Connection,
  quoteId: number,
): Promise<string[]> {
  const rows = await executeQuery(
    connection,
    `SELECT a.OriginalName, a.ContentType
       FROM QuoteAttachments qa
       JOIN Attachments a ON a.Id = qa.AttachmentID
      WHERE qa.QuoteID = @QuoteID
      ORDER BY a.OriginalName`,
    [{ name: "QuoteID", type: TYPES.Int, value: quoteId }],
  );
  return rows.map((r) => (r.OriginalName as string) ?? "attachment");
}

async function loadPurchaseOrder(
  connection: Connection,
  jobId: number,
): Promise<PacketPurchaseOrder | null> {
  // PurchaseOrders has no Currency or Amount column; EstimatedCost is the
  // closest monetary value. Currency defaults to AUD throughout.
  const rows = await executeQuery(
    connection,
    `SELECT TOP 1 PurchaseOrderID, PONumber, ContractorName,
            ISNULL(EstimatedCost, 0) AS EstimatedCost, PDFBlobName
       FROM PurchaseOrders WHERE JobID = @JobID ORDER BY PurchaseOrderID DESC`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.PurchaseOrderID as number,
    poNumber: (r.PONumber as string) ?? null,
    contractorName: (r.ContractorName as string) ?? "",
    amount: Number(r.EstimatedCost ?? 0),
    currency: "AUD",
    pdfBytes: await maybeLoadBlob(r.PDFBlobName as string | null),
  };
}

async function loadInvoice(
  connection: Connection,
  jobId: number,
): Promise<PacketInvoice | null> {
  // Prefer the invoice currently awaiting director sign-off — that's the
  // stage-1 'approved' state. Falls back to the most recent incoming invoice
  // so the packet still has context outside the director flow.
  const rows = await executeQuery(
    connection,
    `SELECT TOP 1 JobInvoiceID, InvoiceNumber, ContractorName, Amount,
            ISNULL(Currency, 'AUD') AS Currency, InvoicePDFBlobName, Status
       FROM JobInvoices
      WHERE JobID = @JobID AND ISNULL(Direction, 'incoming') = 'incoming'
      ORDER BY CASE WHEN Status = 'approved' THEN 0 ELSE 1 END,
               JobInvoiceID DESC`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  if (rows.length === 0) return null;
  const r = rows[0];
  return {
    id: r.JobInvoiceID as number,
    invoiceNumber: (r.InvoiceNumber as string) ?? null,
    contractorName: (r.ContractorName as string) ?? "",
    amount: Number(r.Amount ?? 0),
    currency: r.Currency as string,
    pdfBytes: await maybeLoadBlob(r.InvoicePDFBlobName as string | null),
  };
}

async function loadJobAttachments(
  connection: Connection,
  jobId: number,
): Promise<PacketAttachment[]> {
  // Attachments are stored in the polymorphic `Attachments` table (not
  // JobAttachments). OriginalName is the display name; ContentType is stored
  // directly. Rows without MyBuildingsConfirmedAt still have live blobs.
  //
  // Director packet rule: include every attachment on the job, EXCEPT those
  // whose only link is to a rejected quote. An attachment with no quote links
  // at all (job-level upload, PO upload, etc.) is always included.
  const rows = await executeQuery(
    connection,
    `SELECT a.OriginalName, a.ContentType, a.BlobName
       FROM Attachments a
      WHERE a.JobID = @JobID
        AND a.MyBuildingsConfirmedAt IS NULL
        AND (
          NOT EXISTS (
            SELECT 1 FROM QuoteAttachments qa
             WHERE qa.AttachmentID = a.Id
          )
          OR EXISTS (
            SELECT 1
              FROM QuoteAttachments qa
              JOIN Quotes q ON q.QuoteID = qa.QuoteID
             WHERE qa.AttachmentID = a.Id
               AND ISNULL(q.Status, '') <> 'rejected'
          )
        )`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  // Blob loads are independent HTTP requests to Azure Storage and can run in
  // parallel (unlike tedious SQL which is single-flight per connection).
  const loaded = await Promise.all(
    rows.map(async (r) => {
      const bytes = await maybeLoadBlob(r.BlobName as string | null);
      if (!bytes) return null;
      return {
        fileName: (r.OriginalName as string) ?? "attachment",
        contentType: (r.ContentType as string) ?? "application/octet-stream",
        bytes,
      } satisfies PacketAttachment;
    }),
  );
  return loaded.filter((a): a is PacketAttachment => a !== null);
}

async function loadSourcePointAttachments(
  connection: Connection,
  jobId: number,
): Promise<PacketAttachment[]> {
  // If the job was raised from an inspection point, include attachments on
  // that point. SourceInspectionPointId is the point's string ID.
  const rows = await executeQuery(
    connection,
    `SELECT SourceInspectionPointId FROM Jobs WHERE JobID = @JobID`,
    [{ name: "JobID", type: TYPES.Int, value: jobId }],
  );
  const pointId = rows[0]?.SourceInspectionPointId as string | null;
  if (!pointId) return [];

  // InspectionAttachments has FileName but no ContentType column.
  // Default to application/octet-stream; PDF/image detection by extension
  // is handled downstream in buildJobPacket (appendAttachment).
  const attRows = await executeQuery(
    connection,
    `SELECT FileName, BlobName
       FROM dbo.InspectionAttachments
      WHERE PointId = @PID`,
    [{ name: "PID", type: TYPES.NVarChar, value: pointId }],
  );
  const loaded = await Promise.all(
    attRows.map(async (r) => {
      const bytes = await maybeLoadBlob(r.BlobName as string | null);
      if (!bytes) return null;
      const fileName = (r.FileName as string) ?? "attachment";
      return {
        fileName,
        contentType: inferContentType(fileName),
        bytes,
      } satisfies PacketAttachment;
    }),
  );
  return loaded.filter((a): a is PacketAttachment => a !== null);
}

/** Best-effort content type from file extension when the DB doesn't store it. */
function inferContentType(fileName: string): string {
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";
  const map: Record<string, string> = {
    pdf: "application/pdf",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
  };
  return map[ext] ?? "application/octet-stream";
}

async function maybeLoadBlob(blobName: string | null): Promise<Buffer | null> {
  if (!blobName) return null;
  try {
    return await downloadBlob(blobName);
  } catch {
    return null; // best-effort — missing blob doesn't fail the packet
  }
}
