// Pure builder — assembles a "job packet" PDF for director approval +
// on-demand download. Takes already-loaded inputs (the loader is separate)
// and returns a Buffer.
//
// Flow:
//   1. Render the cover (PDFKit): job summary → quote summary → PO summary
//      → invoice summary → attachments index. Sections omitted when null.
//   2. Merge (pdf-lib): cover + selected quote PDF + PO PDF + invoice PDF +
//      attachment PDFs/images.
//
// All inputs are optional (except `job`); the packet builds with whatever
// is available so it can be downloaded at any stage of the job.

import PDFDocument from "pdfkit";
import { PDFDocument as PDFLibDocument } from "pdf-lib";

export interface PacketJob {
  id: number;
  title: string;
  buildingName: string;
  requestedBy: string;
  status: string;
  createdDate: Date;
  oncharge: boolean;
  description?: string;
}

export interface PacketQuote {
  id: number;
  contractorName: string;
  amount: number;
  currency: string;
  quoteNumber: string | null;
  pdfBytes: Buffer | null;
  /** Filenames of every attachment linked to this quote via QuoteAttachments.
   *  Surfaced on the cover under the quote section so the director sees the
   *  full context — including non-PDF files that ride along as separate
   *  email attachments. */
  linkedAttachmentFileNames: string[];
}

export interface PacketPurchaseOrder {
  id: number;
  poNumber: string | null;
  contractorName: string;
  amount: number;
  currency: string;
  pdfBytes: Buffer | null;
}

export interface PacketInvoice {
  id: number;
  invoiceNumber: string | null;
  contractorName: string;
  amount: number;
  currency: string;
  pdfBytes: Buffer | null;
}

export interface PacketAttachment {
  fileName: string;
  contentType: string; // e.g. "application/pdf", "image/jpeg"
  bytes: Buffer;
}

export interface PacketInput {
  job: PacketJob;
  selectedQuote: PacketQuote | null;
  purchaseOrder: PacketPurchaseOrder | null;
  invoice: PacketInvoice | null;
  jobAttachments: PacketAttachment[];
  sourcePointAttachments: PacketAttachment[];
}

/** Attachments that can't be merged into the PDF (xlsx, docx, csv, etc.) and
 *  should ride along as separate email attachments / be zipped on download. */
export function nonMergeableAttachments(input: PacketInput): PacketAttachment[] {
  const all = [...input.jobAttachments, ...input.sourcePointAttachments];
  return all.filter(
    (a) => a.contentType !== "application/pdf" && !a.contentType.startsWith("image/"),
  );
}

export async function buildJobPacket(input: PacketInput): Promise<Buffer> {
  const coverBytes = await renderCover(input);

  const merged = await PDFLibDocument.create();
  await appendPdfBytes(merged, coverBytes);

  if (input.selectedQuote?.pdfBytes) {
    await appendPdfBytes(merged, input.selectedQuote.pdfBytes);
  }
  if (input.purchaseOrder?.pdfBytes) {
    await appendPdfBytes(merged, input.purchaseOrder.pdfBytes);
  }
  if (input.invoice?.pdfBytes) {
    await appendPdfBytes(merged, input.invoice.pdfBytes);
  }

  for (const a of [...input.jobAttachments, ...input.sourcePointAttachments]) {
    await appendAttachment(merged, a);
  }

  const out = await merged.save();
  return Buffer.from(out);
}

function renderCover(input: PacketInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Header ────────────────────────────────────────────────────────────
    doc.fontSize(18).text(`Job Packet — #${input.job.id}`, { align: "left" });
    doc.moveDown(0.3);
    doc.fontSize(11).fillColor("#666")
      .text(`Generated ${new Date().toISOString().slice(0, 10)}`);
    doc.moveDown();
    doc.fillColor("#000");

    // ── Job summary ───────────────────────────────────────────────────────
    section(doc, "Job summary");
    keyValue(doc, "Title", input.job.title);
    keyValue(doc, "Building", input.job.buildingName);
    keyValue(doc, "Requested by", input.job.requestedBy);
    keyValue(doc, "Status", input.job.status);
    keyValue(doc, "Created", input.job.createdDate.toISOString().slice(0, 10));
    keyValue(doc, "On-charge", input.job.oncharge ? "Yes" : "No");
    if (input.job.description) {
      doc.moveDown(0.3);
      doc.fontSize(10).text(input.job.description, { align: "left" });
    }

    // ── Selected quote ────────────────────────────────────────────────────
    if (input.selectedQuote) {
      section(doc, "Selected quote");
      const q = input.selectedQuote;
      keyValue(doc, "Quote #", q.quoteNumber ?? `Q-${q.id}`);
      keyValue(doc, "Contractor", q.contractorName);
      keyValue(doc, "Amount", `${q.currency} ${q.amount.toFixed(2)}`);
      if (q.pdfBytes) {
        doc.fontSize(9).fillColor("#666")
          .text("(Quote PDF attached on following pages.)");
        doc.fillColor("#000");
      }
      if (q.linkedAttachmentFileNames.length) {
        doc.moveDown(0.2);
        doc.fontSize(10).fillColor("#000").text("Linked files:");
        doc.fontSize(9).fillColor("#444");
        for (const name of q.linkedAttachmentFileNames) {
          doc.text(`  • ${name}`);
        }
        doc.fillColor("#000");
      }
    }

    // ── Purchase order ────────────────────────────────────────────────────
    if (input.purchaseOrder) {
      section(doc, "Purchase order");
      const p = input.purchaseOrder;
      keyValue(doc, "PO #", p.poNumber ?? `PO-${p.id}`);
      keyValue(doc, "Contractor", p.contractorName);
      keyValue(doc, "Amount", `${p.currency} ${p.amount.toFixed(2)}`);
      if (p.pdfBytes) {
        doc.fontSize(9).fillColor("#666")
          .text("(PO PDF attached on following pages.)");
        doc.fillColor("#000");
      }
    }

    // ── Invoice ───────────────────────────────────────────────────────────
    if (input.invoice) {
      section(doc, "Invoice");
      const i = input.invoice;
      keyValue(doc, "Invoice #", i.invoiceNumber ?? `INV-${i.id}`);
      keyValue(doc, "Contractor", i.contractorName);
      keyValue(doc, "Amount", `${i.currency} ${i.amount.toFixed(2)}`);
      if (i.pdfBytes) {
        doc.fontSize(9).fillColor("#666")
          .text("(Invoice PDF attached on following pages.)");
        doc.fillColor("#000");
      }
    }

    // ── Attachments index ─────────────────────────────────────────────────
    type AttachmentGroup = "Job" | "Inspection";
    const allAttachments: (PacketAttachment & { group: AttachmentGroup })[] = [
      ...input.jobAttachments.map((a) => ({ ...a, group: "Job" as AttachmentGroup })),
      ...input.sourcePointAttachments.map((a) => ({ ...a, group: "Inspection" as AttachmentGroup })),
    ];
    if (allAttachments.length) {
      section(doc, "Attachments");
      for (const a of allAttachments) {
        doc.fontSize(10).text(`• [${a.group}] ${a.fileName}`);
      }
    }

    doc.end();
  });
}

function section(doc: PDFKit.PDFDocument, title: string) {
  doc.moveDown(0.8);
  doc.fontSize(13).fillColor("#000").text(title, { underline: false });
  doc.moveDown(0.2);
  doc.strokeColor("#ddd").lineWidth(0.5)
    .moveTo(doc.x, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
  doc.moveDown(0.3);
}

function keyValue(doc: PDFKit.PDFDocument, key: string, value: string) {
  doc.fontSize(10).fillColor("#666").text(`${key}: `, { continued: true });
  doc.fillColor("#000").text(value);
}

async function appendPdfBytes(target: PDFLibDocument, bytes: Buffer | Uint8Array) {
  const src = await PDFLibDocument.load(bytes, { ignoreEncryption: true });
  const copied = await target.copyPages(src, src.getPageIndices());
  for (const p of copied) target.addPage(p);
}

async function appendAttachment(target: PDFLibDocument, a: PacketAttachment) {
  if (a.contentType === "application/pdf") {
    await appendPdfBytes(target, a.bytes);
    return;
  }
  if (a.contentType.startsWith("image/")) {
    const page = target.addPage();
    let img;
    if (a.contentType.includes("png")) img = await target.embedPng(a.bytes);
    else if (a.contentType.includes("jpeg") || a.contentType.includes("jpg")) img = await target.embedJpg(a.bytes);
    else return; // skip unsupported image types
    const { width, height } = page.getSize();
    const margin = 40;
    const maxW = width - margin * 2;
    const maxH = height - margin * 2 - 30;
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const w = img.width * scale;
    const h = img.height * scale;
    page.drawImage(img, { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h });
    // Caption
    page.drawText(a.fileName, { x: margin, y: margin, size: 9 });
    return;
  }
  // Non-PDF, non-image: skip silently. Listed in the cover's attachments index.
}
