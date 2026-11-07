// pdfkit and pdf-lib load on first use, not at startup: together they add about
// 200 ms of module load to every cold start and only a handful of handlers build PDFs.
// Node caches the module after the first call, so repeat calls are free.
import type PDFKitDocument from "pdfkit";
import type { PDFDocument as PdfLibDocument } from "pdf-lib";

export async function loadPdfKit(): Promise<typeof PDFKitDocument> {
  return (await import("pdfkit")).default;
}

export async function loadPdfLib(): Promise<typeof PdfLibDocument> {
  return (await import("pdf-lib")).PDFDocument;
}
