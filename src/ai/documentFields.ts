// What quote_extraction and invoice_extraction ask a model for, and the checks its
// answer must pass (SC-AI2). One shape serves both document kinds so the frontend
// reads them alike; a kind adds only the figures and dates it carries.
//
// A model's answer is untrusted data. A field is copied out only when it has the
// right type and format; anything else, or any field the schema does not name,
// refuses the whole answer (the caller falls back on Floorplan's own rules). A
// missing field, a null, an empty string or "N/A" all mean "not printed".

import { isAbnValid } from "./checksums";
import type { AiValidation } from "./types";
import { accept, boundedString, isRecord, refuse, unknownKeys } from "./validate";

export type DocumentKind = "invoice" | "quote";

export const DOCUMENT_KINDS: readonly DocumentKind[] = ["quote", "invoice"];
/** The text of a PDF's first pages, capped. The frontend cuts to this before it asks (src/helpers/documentExtraction). */
export const DOCUMENT_MAX_INPUT_CHARS = 12_000;
export const DOCUMENT_MAX_OUTPUT_TOKENS = 600;

export const INVOICE_DOCUMENT_TYPES = ["credit-note", "invoice", "statement"] as const;
export type InvoiceDocumentType = (typeof INVOICE_DOCUMENT_TYPES)[number];

export interface DocumentFieldValues {
  /** Eleven digits that pass the ABN checksum; an ABN that fails it is dropped, not trusted. */
  abn: string | null;
  /** A short description of the work, in the document's own words. */
  description: string | null;
  documentNumber: string | null;
  gst: number | null;
  /** YYYY-MM-DD. */
  issueDate: string | null;
  subtotalExGst: number | null;
  /** The total including GST. */
  total: number | null;
}

export interface QuoteFieldValues extends DocumentFieldValues {
  leadTimeDays: number | null;
  validForDays: number | null;
  validUntil: string | null;
}

export interface InvoiceFieldValues extends DocumentFieldValues {
  documentType: InvoiceDocumentType | null;
  dueDate: string | null;
}

type FieldType = "abn" | "date" | "days" | "documentType" | "money" | "number" | "text";

const COMMON_FIELDS: Record<keyof DocumentFieldValues, FieldType> = {
  abn: "abn",
  description: "text",
  documentNumber: "number",
  gst: "money",
  issueDate: "date",
  subtotalExGst: "money",
  total: "money",
};
const QUOTE_FIELDS: Record<keyof QuoteFieldValues, FieldType> = {
  ...COMMON_FIELDS,
  leadTimeDays: "days",
  validForDays: "days",
  validUntil: "date",
};
const INVOICE_FIELDS: Record<keyof InvoiceFieldValues, FieldType> = {
  ...COMMON_FIELDS,
  documentType: "documentType",
  dueDate: "date",
};

export const fieldNames = (kind: DocumentKind): string[] => Object.keys(kind === "quote" ? QUOTE_FIELDS : INVOICE_FIELDS);

const MAX_MONEY = 100_000_000;
const MAX_DAYS = 1_095;
const MAX_DESCRIPTION_CHARS = 200;
// What a model writes when it was told to write null and wants to say "nothing here".
const NOT_PRINTED = /^(?:n\/?a|none|null|nil|unknown|not (?:found|stated|provided|printed|available|shown)|-+)$/i;

type Read = { ok: false } | { ok: true; value: number | string | null };
const NOTHING: Read = { ok: true, value: null };
const BAD: Read = { ok: false };

function validIsoDate(text: string): boolean {
  const parts = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!parts) return false;
  const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  const date = new Date(Date.UTC(year, month - 1, day));
  return year >= 2000 && year <= 2100 && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function readText(raw: unknown, max: number): { ok: false } | { ok: true; value: string | null } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false };
  const text = raw.trim().replace(/\s+/g, " ");
  if (text === "" || NOT_PRINTED.test(text)) return { ok: true, value: null };
  const clean = boundedString(text, max);
  return clean === null ? { ok: false } : { ok: true, value: clean };
}

function readNumber(raw: unknown, max: number, whole: boolean): Read {
  if (raw === null || raw === undefined) return NOTHING;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > max) return BAD;
  return { ok: true, value: whole ? Math.round(raw) : Math.round(raw * 100) / 100 };
}

function readField(type: FieldType, raw: unknown): Read {
  if (type === "money") return readNumber(raw, MAX_MONEY, false);
  if (type === "days") return readNumber(raw, MAX_DAYS, true);
  if (type === "number") return readText(raw, 40);
  if (type === "text") {
    const read = readText(raw, MAX_DESCRIPTION_CHARS * 2);
    if (!read.ok || read.value === null || read.value.length <= MAX_DESCRIPTION_CHARS) return read;
    return { ok: true, value: `${read.value.slice(0, MAX_DESCRIPTION_CHARS).replace(/\s\S*$/, "")}…` };
  }
  const read = readText(raw, 40);
  if (!read.ok || read.value === null) return read;
  if (type === "date") return validIsoDate(read.value) ? read : BAD;
  if (type === "documentType") return (INVOICE_DOCUMENT_TYPES as readonly string[]).includes(read.value) ? read : BAD;
  // An ABN is eleven digits, spaces allowed. One that fails the checksum is not trusted, so it reads as not printed.
  const digits = read.value.replace(/[ -]/g, "");
  if (!/^\d{11}$/.test(digits)) return BAD;
  return isAbnValid(digits) ? { ok: true, value: digits } : NOTHING;
}

/** The validator behind both purposes: the parsed JSON in, the trusted fields out. */
export function validateDocumentFields(kind: "quote", value: unknown): AiValidation<QuoteFieldValues>;
export function validateDocumentFields(kind: "invoice", value: unknown): AiValidation<InvoiceFieldValues>;
export function validateDocumentFields(kind: DocumentKind, value: unknown): AiValidation<QuoteFieldValues | InvoiceFieldValues>;
export function validateDocumentFields(kind: DocumentKind, value: unknown): AiValidation<QuoteFieldValues | InvoiceFieldValues> {
  if (!isRecord(value)) return refuse("The answer is not a JSON object.");
  const fields: Record<string, FieldType> = kind === "quote" ? QUOTE_FIELDS : INVOICE_FIELDS;
  if (unknownKeys(value, Object.keys(fields)).length > 0) return refuse("The answer has fields it should not.");
  const checked: Record<string, number | string | null> = {};
  for (const [name, type] of Object.entries(fields)) {
    const read = readField(type, value[name]);
    if (!read.ok) return refuse(`The answer's ${name} is not in the format asked for.`);
    checked[name] = read.value;
  }
  return accept(checked as unknown as QuoteFieldValues | InvoiceFieldValues);
}
