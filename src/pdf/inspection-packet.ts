// Pure builder — assembles an inspection "report" PDF (cover + every
// level/room/issue with each issue's photos grouped 2-up beneath it) and
// returns a Buffer. Inspection attachments are all images, so this uses
// PDFKit alone (doc.image) — no pdf-lib merge step.

import PDFDocument from "pdfkit";

export interface PacketPhoto {
  fileName: string;
  bytes: Buffer;
}

export interface PacketPoint {
  description: string;
  addedByName: string;
  addedAt: Date;
  raisedJobIds: number[];
  photos: PacketPhoto[];
}

export interface PacketRoom {
  name: string;
  points: PacketPoint[];
}

export interface PacketLevel {
  name: string;
  rooms: PacketRoom[];
}

export interface InspectionPacketInput {
  id: number;
  title: string;
  buildingName: string;
  status: string;
  createdByName: string;
  createdAt: Date;
  completedByName?: string;
  completedAt?: Date;
  totals: { levels: number; rooms: number; issues: number; jobs: number };
  levels: PacketLevel[];
}

// Two photos per row keeps each image large enough to read on A4 while
// keeping the page count sane.
const PHOTOS_PER_ROW = 2;
const PHOTO_GAP = 12;

export function buildInspectionPacket(input: InspectionPacketInput): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: "A4", margin: 50 });
    const chunks: Buffer[] = [];
    doc.on("data", (c: Buffer) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);

    // ── Header ────────────────────────────────────────────────────────────
    doc.fontSize(18).fillColor("#000").text(`Inspection Report — #${input.id}`);
    doc.moveDown(0.2);
    doc.fontSize(13).fillColor("#000").text(input.title);
    doc.moveDown(0.2);
    doc.fontSize(11).fillColor("#666").text(`Generated ${formatDate(new Date())}`);
    doc.fillColor("#000");

    // ── Summary ───────────────────────────────────────────────────────────
    section(doc, "Summary");
    keyValue(doc, "Building", input.buildingName);
    keyValue(doc, "Status", input.status);
    keyValue(doc, "Created", `${formatDate(input.createdAt)} by ${input.createdByName}`);
    if (input.completedAt && input.completedByName) {
      keyValue(doc, "Completed", `${formatDate(input.completedAt)} by ${input.completedByName}`);
    }
    keyValue(
      doc,
      "Totals",
      `${input.totals.levels} levels · ${input.totals.rooms} rooms · ` +
        `${input.totals.issues} issues · ${input.totals.jobs} jobs`,
    );

    // ── Body ──────────────────────────────────────────────────────────────
    for (const level of input.levels) {
      section(doc, level.name);
      if (level.rooms.length === 0) {
        doc.fontSize(10).fillColor("#666").text("No rooms recorded.");
        doc.fillColor("#000");
        continue;
      }
      for (const room of level.rooms) {
        doc.moveDown(0.5);
        doc.fontSize(12).fillColor("#000").text(room.name);
        if (room.points.length === 0) {
          doc.fontSize(10).fillColor("#666").text("No issues recorded.");
          doc.fillColor("#000");
          continue;
        }
        for (const point of room.points) {
          renderPoint(doc, point);
        }
      }
    }

    doc.end();
  });
}

function renderPoint(doc: PDFKit.PDFDocument, point: PacketPoint) {
  doc.moveDown(0.6);
  // Keep the heading with at least the start of its content: if there's very
  // little space left on the page, start on a fresh one.
  const bottom = doc.page.height - doc.page.margins.bottom;
  if (doc.y > bottom - 120) doc.addPage();

  doc.fontSize(10.5).fillColor("#000").text(point.description || "(no description)");

  const badges = point.raisedJobIds.map((id) => `Job #${id}`).join(" · ");
  const meta =
    `Added by ${point.addedByName} · ${formatDate(point.addedAt)}` +
    (badges ? ` · ${badges}` : "");
  doc.fontSize(9).fillColor("#666").text(meta);
  doc.fillColor("#000");

  if (point.photos.length > 0) renderPhotoGrid(doc, point.photos);
}

function renderPhotoGrid(doc: PDFKit.PDFDocument, photos: PacketPhoto[]) {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const bottom = doc.page.height - doc.page.margins.bottom;
  const contentW = right - left;
  const cellW = (contentW - PHOTO_GAP * (PHOTOS_PER_ROW - 1)) / PHOTOS_PER_ROW;
  const cellH = cellW * 0.75; // 4:3 box; images scaled to fit inside it.

  doc.moveDown(0.4);

  for (let i = 0; i < photos.length; i += PHOTOS_PER_ROW) {
    if (doc.y + cellH > bottom) doc.addPage();
    const rowTop = doc.y;
    const row = photos.slice(i, i + PHOTOS_PER_ROW);
    row.forEach((photo, col) => {
      const x = left + col * (cellW + PHOTO_GAP);
      try {
        doc.image(photo.bytes, x, rowTop, {
          fit: [cellW, cellH],
          align: "center",
          valign: "center",
        });
      } catch {
        // Unreadable/corrupt image — leave the cell blank, keep building.
      }
    });
    doc.x = left;
    doc.y = rowTop + cellH + PHOTO_GAP;
  }
}

function section(doc: PDFKit.PDFDocument, title: string) {
  doc.moveDown(0.8);
  doc.fontSize(13).fillColor("#000").text(title);
  doc.moveDown(0.2);
  doc
    .strokeColor("#ddd")
    .lineWidth(0.5)
    .moveTo(doc.page.margins.left, doc.y)
    .lineTo(doc.page.width - doc.page.margins.right, doc.y)
    .stroke();
  doc.moveDown(0.3);
}

function keyValue(doc: PDFKit.PDFDocument, key: string, value: string) {
  doc.fontSize(10).fillColor("#666").text(`${key}: `, { continued: true });
  doc.fillColor("#000").text(value);
}

// dd/MM/yyyy to match the app's display convention.
function formatDate(d: Date): string {
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getUTCFullYear()}`;
}
