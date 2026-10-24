// What a request to queue or preview an email may carry, and nothing more.
//
// The signature, the sender and the reply-to address are never taken from the client: the
// client names an identity (by id) or "my own address", and a mode, and the server composes
// the rest. Any other key is refused, and a key that looks like signature text, a sender or
// another person's details is refused with the reason. Per-recipient merge values may carry
// only the fields in the catalogue that the server doesn't fill itself.

import { IDEMPOTENCY_KEY } from "./idempotency";
import { mailbox, optionalLine, plainLine, type Checked } from "./fields";
import { MAX_RECIPIENTS_PER_JOB } from "./config";
import type { RecipientType } from "./compose";
import { fieldsNamed, isServerField, mergeFieldDef } from "./mergeFields";
import type { ReplyToChoice } from "./identity";
import { SIGNATURE_MODES, type SignatureMode } from "./signature";
import type { NewRecipient } from "./types";

export const SIGNATURE_REFUSAL = "Signatures are composed by Floorplan: a request can't carry signature text, a sender or another person's details";

const SIGNATURE_LIKE = /sign|sender|from|title|phone|footer|html|address|email|display|name/i;
export const MAX_SUBJECT_CHARS = 200;
export const MAX_BODY_CHARS = 50_000;
const MAX_VALUE_CHARS = 500;
const REF_ID = /^[A-Za-z0-9_-]{1,64}$/;

export type Parsed<T> = { ok: true; value: T } | { error: string; ok: false };
const fail = (error: string): { error: string; ok: false } => ({ error, ok: false });

/** Names the first key outside `allowed`: a signature-like one gets the signature refusal. */
export function unexpectedKey(body: Record<string, unknown>, allowed: readonly string[]): string | null {
  const key = Object.keys(body).find((name) => !allowed.includes(name));
  if (key === undefined) return null;
  return SIGNATURE_LIKE.test(key) ? SIGNATURE_REFUSAL : `Unknown field "${key.slice(0, 40)}"`;
}

const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

function parseReplyTo(value: unknown): Parsed<ReplyToChoice> {
  if (!isObject(value)) return fail("replyTo must say which address to reply to");
  const extra = unexpectedKey(value, ["type", "identityId"]);
  if (extra) return fail(extra === SIGNATURE_REFUSAL ? "The reply-to is chosen by identity or as your own address: a request can't name another address" : extra);
  if (value.type === "own") return value.identityId === undefined ? { ok: true, value: { kind: "own" } } : fail("replyTo own takes no identityId");
  if (value.type === "identity" && Number.isInteger(value.identityId) && (value.identityId as number) > 0) {
    return { ok: true, value: { identityId: value.identityId as number, kind: "identity" } };
  }
  return fail('replyTo must be { "type": "own" } or { "type": "identity", "identityId": <number> }');
}

function parseMergeValues(value: unknown): Parsed<Record<string, string>> {
  if (value === undefined || value === null) return { ok: true, value: {} };
  if (!isObject(value)) return fail("mergeValues must be an object of text values");
  const out: Record<string, string> = {};
  for (const [path, raw] of Object.entries(value)) {
    if (isServerField(path)) return fail(`"${path.slice(0, 40)}" is filled in by Floorplan and can't be sent`);
    if (mergeFieldDef(path) === undefined) return fail(`Unknown merge field "${path.slice(0, 40)}"`);
    if (typeof raw !== "string") return fail(`Merge field "${path}" must be text`);
    if (raw.length > MAX_VALUE_CHARS) return fail(`Merge field "${path}" is too long`);
    out[path] = raw;
  }
  return { ok: true, value: out };
}

const TYPES_ALLOWED: readonly RecipientType[] = ["tenancy", "contractor", "staff", "manual"];

export function parseRecipient(value: unknown): Parsed<NewRecipient> {
  if (!isObject(value)) return fail("Each recipient must be an object");
  const extra = unexpectedKey(value, ["address", "name", "recipientType", "recipientRefId", "mergeValues"]);
  if (extra) return fail(extra);
  const address = mailbox(value.address, "Recipient address");
  if (!address.ok) return address;
  const name = optionalLine(value.name, "Recipient name", 200);
  if (!name.ok) return name;
  if (!TYPES_ALLOWED.includes(value.recipientType as RecipientType)) return fail("recipientType must be tenancy, contractor, staff or manual");
  const recipientType = value.recipientType as RecipientType;
  const refRaw = value.recipientRefId;
  const ref = refRaw === undefined || refRaw === null ? null : String(refRaw);
  if (ref !== null && !REF_ID.test(ref)) return fail("recipientRefId must be letters, digits, - or _");
  // A tenancy's address always names the tenancy, so the test-record check can never be skipped by leaving it out.
  if (recipientType === "tenancy" && (ref === null || !/^[1-9]\d{0,9}$/.test(ref))) return fail("A tenancy recipient needs its tenancy id (recipientRefId)");
  const mergeValues = parseMergeValues(value.mergeValues);
  if (!mergeValues.ok) return mergeValues;
  return { ok: true, value: { address: address.value, mergeValues: mergeValues.value, name: name.value, recipientRefId: ref, recipientType } };
}

export interface EmailContent {
  bodyMarkdown: string;
  kind: "broadcast" | "letter";
  replyTo: ReplyToChoice;
  signatureMode: SignatureMode;
  subject: string;
  templateId: string | null;
  templateVersion: number | null;
}

const CONTENT_KEYS = ["kind", "subject", "bodyMarkdown", "templateId", "templateVersion", "replyTo", "signatureMode"];

/** The parts of a request that are the email itself: shared by queue and preview. */
export function parseContent(body: Record<string, unknown>): Parsed<EmailContent> {
  if (body.kind !== "broadcast" && body.kind !== "letter") return fail("kind must be broadcast or letter");
  const subject = plainLine(body.subject, "Subject", MAX_SUBJECT_CHARS);
  if (!subject.ok) return subject;
  if (typeof body.bodyMarkdown !== "string" || body.bodyMarkdown.trim() === "") return fail("The email needs some wording");
  if (body.bodyMarkdown.length > MAX_BODY_CHARS) return fail(`The email is too long (over ${MAX_BODY_CHARS} characters)`);
  const templateId = optionalLine(body.templateId, "Template", 120);
  if (!templateId.ok) return templateId;
  const version = body.templateVersion;
  if (version !== undefined && version !== null && !(Number.isInteger(version) && (version as number) > 0)) return fail("templateVersion must be a whole number");
  if (templateId.value !== null && (version === undefined || version === null)) return fail("A template needs its version");
  const replyTo = parseReplyTo(body.replyTo);
  if (!replyTo.ok) return replyTo;
  if (!SIGNATURE_MODES.includes(body.signatureMode as SignatureMode)) return fail("signatureMode must be role or personal");
  const unknown = fieldsNamed(subject.value, body.bodyMarkdown).filter((path) => mergeFieldDef(path) === undefined);
  if (unknown.length > 0) return fail(`The email names a field Floorplan doesn't have: ${unknown.slice(0, 5).map((path) => `"${path.slice(0, 40)}"`).join(", ")}`);
  return {
    ok: true,
    value: {
      bodyMarkdown: body.bodyMarkdown,
      kind: body.kind,
      replyTo: replyTo.value,
      signatureMode: body.signatureMode as SignatureMode,
      subject: subject.value,
      templateId: templateId.value,
      templateVersion: templateId.value === null ? null : (version as number),
    },
  };
}

export interface QueueInput extends EmailContent {
  duplicatesDropped: number;
  /** One per compose session: a repeated submit with the same key returns the job already made. */
  idempotencyKey: string | null;
  recipients: NewRecipient[];
}

export function parseQueueInput(body: Record<string, unknown>): Parsed<QueueInput> {
  const extra = unexpectedKey(body, [...CONTENT_KEYS, "recipients", "idempotencyKey"]);
  if (extra) return fail(extra);
  const content = parseContent(body);
  if (!content.ok) return content;
  const key = body.idempotencyKey;
  if (key !== undefined && key !== null && !(typeof key === "string" && IDEMPOTENCY_KEY.test(key))) return fail("idempotencyKey must be 16 to 64 letters, digits, - or _");
  if (!Array.isArray(body.recipients) || body.recipients.length === 0) return fail("Choose at least one recipient");
  if (body.recipients.length > MAX_RECIPIENTS_PER_JOB) return fail(`A send can have at most ${MAX_RECIPIENTS_PER_JOB} recipients`);
  const seen = new Set<string>();
  const recipients: NewRecipient[] = [];
  for (const raw of body.recipients) {
    const recipient = parseRecipient(raw);
    if (!recipient.ok) return recipient;
    if (seen.has(recipient.value.address)) continue;
    seen.add(recipient.value.address);
    recipients.push(recipient.value);
  }
  return { ok: true, value: { ...content.value, duplicatesDropped: body.recipients.length - recipients.length, idempotencyKey: typeof key === "string" ? key : null, recipients } };
}

export type PreviewInput = { content: EmailContent; kind: "draft"; recipient: NewRecipient } | { correspondenceId: number; kind: "saved"; recipientId: number };

export function parsePreviewInput(body: Record<string, unknown>): Parsed<PreviewInput> {
  if (body.correspondenceId !== undefined) {
    const extra = unexpectedKey(body, ["correspondenceId", "recipientId"]);
    if (extra) return fail(extra);
    if (!Number.isInteger(body.correspondenceId) || !Number.isInteger(body.recipientId)) return fail("correspondenceId and recipientId must be whole numbers");
    return { ok: true, value: { correspondenceId: body.correspondenceId as number, kind: "saved", recipientId: body.recipientId as number } };
  }
  const extra = unexpectedKey(body, [...CONTENT_KEYS, "recipient"]);
  if (extra) return fail(extra);
  const content = parseContent(body);
  if (!content.ok) return content;
  const recipient = parseRecipient(body.recipient);
  if (!recipient.ok) return recipient;
  return { ok: true, value: { content: content.value, kind: "draft", recipient: recipient.value } };
}

/** A whole-number id from a body or a query string, or null. */
export function wholeId(value: unknown): number | null {
  const number = typeof value === "string" && /^\d{1,10}$/.test(value) ? Number(value) : value;
  return typeof number === "number" && Number.isInteger(number) && number > 0 && number <= 2_147_483_647 ? number : null;
}

export type { Checked };
