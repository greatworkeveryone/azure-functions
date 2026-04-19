// Renders a Purchase Order PDF from PO row + Job snapshot fields.
// Pure function: takes plain data, returns Buffer. No DB / HTTP / env reads.
// Layout is deliberately simple (single column, standard fonts) so the
// output is diff-friendly and renders the same everywhere pdfkit does.

import PDFDocument from "pdfkit";

export interface PurchaseOrderPdfInput {
  po: {
    poNumber: string | null;
    contractorName: string | null;
    contractorEmail: string | null;
    scope: string | null;
    estimatedCost: number | null;
    costNotToExceed: number | null;
    costJustification: string | null;
    createdBy: string | null;
    createdAt: Date | string | null;
  };
  job: {
    jobCode: string | null;
    title: string | null;
    buildingName: string | null;
    levelName: string | null;
    exactLocation: string | null;
    category: string | null;
    type: string | null;
    subType: string | null;
    priority: string | null;
    contactName: string | null;
    contactPhone: string | null;
    contactEmail: string | null;
    personAffected: string | null;
  };
}

function formatCurrency(amount: number | null): string {
  if (amount == null) return "—";
  return new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
  }).format(amount);
}

function formatDate(value: Date | string | null): string {
  if (!value) return "—";
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toISOString().slice(0, 10);
}

function joinNonEmpty(parts: (string | null | undefined)[], sep = " · "): string {
  return parts.filter((p) => p && p.trim()).join(sep);
}

function joinCategoryPath(parts: (string | null | undefined)[]): string {
  const list = parts.filter((p): p is string => !!p && p.trim().length > 0);
  return list.length > 0 ? list.join(" › ") : "—";
}

export async function renderPurchaseOrderPDF(
  input: PurchaseOrderPdfInput,
): Promise<Buffer> {
  const { po, job } = input;

  const doc = new PDFDocument({ size: "A4", margin: 50 });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  // Header — PO number + date on opposite sides
  doc.font("Helvetica-Bold").fontSize(18).text("PURCHASE ORDER", { continued: false });
  const headerY = doc.y;
  doc
    .font("Helvetica").fontSize(11)
    .text(po.poNumber ?? "—", 50, headerY - 22, { align: "right" });
  doc.moveDown(0.5);
  doc
    .font("Helvetica").fontSize(9)
    .fillColor("#666")
    .text(`Issued ${formatDate(po.createdAt)}`, { align: "right" })
    .fillColor("black");
  doc.moveDown(1);
  doc
    .strokeColor("#ddd")
    .lineWidth(0.5)
    .moveTo(50, doc.y).lineTo(545, doc.y).stroke()
    .strokeColor("black");
  doc.moveDown(0.5);

  // Section helper
  const section = (title: string) => {
    doc.moveDown(0.75);
    doc.font("Helvetica-Bold").fontSize(9).fillColor("#666")
      .text(title.toUpperCase(), { characterSpacing: 1 })
      .fillColor("black");
    doc.moveDown(0.25);
    doc.font("Helvetica").fontSize(10);
  };

  const row = (label: string, value: string) => {
    doc.font("Helvetica-Bold").fontSize(10).text(`${label}  `, { continued: true });
    doc.font("Helvetica").fontSize(10).text(value || "—");
  };

  // Job block
  section("Job");
  row("Job:", joinNonEmpty([job.jobCode, job.title], " — "));
  row("Building:", job.buildingName ?? "—");
  row("Location:", joinNonEmpty([job.levelName, job.exactLocation], " · "));
  row("Category:", joinCategoryPath([job.category, job.type, job.subType]));
  if (job.priority) row("Priority:", job.priority);

  // Contact block
  section("Contact");
  row("On site:", joinNonEmpty([job.contactName, job.contactPhone, job.contactEmail]));
  if (job.personAffected) row("Affected:", job.personAffected);

  // Contractor block
  section("Contractor");
  row("Name:", po.contractorName ?? "—");
  row("Email:", po.contractorEmail ?? "—");

  // Scope block
  section("Scope of work");
  doc.font("Helvetica").fontSize(10).text(po.scope ?? "—", {
    width: 495,
    align: "left",
  });

  // Cost block
  section("Cost");
  row("Estimated:", formatCurrency(po.estimatedCost));
  row("Not to exceed:", formatCurrency(po.costNotToExceed));
  if (po.costJustification) row("Justification:", po.costJustification);

  // Footer
  doc.moveDown(2);
  doc
    .strokeColor("#ddd")
    .lineWidth(0.5)
    .moveTo(50, doc.y).lineTo(545, doc.y).stroke()
    .strokeColor("black");
  doc.moveDown(0.5);
  doc.font("Helvetica").fontSize(8).fillColor("#888")
    .text(
      `Created by ${po.createdBy ?? "—"} on ${formatDate(po.createdAt)}`,
      { align: "left" },
    )
    .fillColor("black");

  doc.end();
  return done;
}
