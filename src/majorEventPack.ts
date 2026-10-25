import PDFDocument from "pdfkit";
import { PDFDocument as PDFLib } from "pdf-lib";
import { createHash } from "crypto";
import type { SqlRow } from "./db";
import type { EventPlan } from "./majorEvents";

/** Printable handover plus original documents embedded as PDF attachments (no recompression). */
export async function majorEventPack(event: { id: number; title: string; status: string; domain: string; brief: string; ownerName: string; startsAt: string | null; endsAt: string | null; plan: EventPlan }, entries: SqlRow[], buildings: SqlRow[], files: { name: string; bytes: Buffer; contentType: string }[]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const pdf = new PDFDocument({ size: "A4", margin: 48, info: { Title: event.title, Author: "Floorplan" } });
  const finished = new Promise<Buffer>((resolve, reject) => {
    pdf.on("data", chunk => chunks.push(Buffer.from(chunk)));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
  });
  const line = (s: string) => pdf.fontSize(10).fillColor("#25332f").text(s).moveDown(0.5);
  pdf.fontSize(10).fillColor("#467463").text(`FLOORPLAN / MAJOR EVENT ${event.id}`);
  pdf.moveDown().fontSize(25).fillColor("#17251f").text(event.title).moveDown(0.5);
  line(`${event.domain === "financial" ? "CFO-LED" : "FACILITIES-LED"} / ${event.status.toUpperCase()} / Lead: ${event.ownerName}`);
  line(`Start: ${event.startsAt}  End: ${event.endsAt ?? "Open"}`);
  line(`Generated ${new Date().toISOString()}. Snapshot of the event record; financial approval remains on the linked job.`);
  line(event.brief);
  line("AFFECTED BUILDINGS");
  for (const id of event.plan.buildingIds) line(String(buildings.find(b => Number(b.BuildingID) === id)?.BuildingName ?? id));
  line("ACTIONS");
  for (const a of event.plan.actions) line(`${a.done ? "[Done]" : "[Open]"} ${a.title} / ${a.owner}${a.due ? ` / Due ${a.due}` : ""}`);
  line(`Linked jobs: ${event.plan.jobIds.join(", ") || "None"}`);
  line("UPDATES / ACKNOWLEDGEMENTS / COMMUNICATIONS");
  for (const e of entries) {
    const stamp = e.CreatedAt ? new Date(e.CreatedAt).toISOString() : "";
    line(`${stamp} / ${e.ActorName} / ${e.EntryType}${e.Area ? ` / ${e.Area}` : ""}`);
    // Audit snapshots are retained in SQL; avoid unreadable JSON dumps in the printable recap.
    line(["created", "plan_changed"].includes(e.EntryType) ? "Event plan recorded in the audit trail." : String(e.Body));
  }
  line("ORIGINAL DOCUMENTS");
  line("Original files are embedded as attachments. Open the PDF in a reader with an Attachments panel to save them. No images were recompressed.");
  for (const f of files) line(`${f.name} / ${f.bytes.length} bytes / SHA-256 ${createHash("sha256").update(f.bytes).digest("hex")}`);
  pdf.end();
  const result = await PDFLib.load(await finished);
  for (const f of files) await result.attach(f.bytes, f.name, { mimeType: f.contentType, description: "Original Major Event document" });
  return Buffer.from(await result.save());
}
