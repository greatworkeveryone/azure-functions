// Validators for the few fields a person or an admin types into a signature or an
// identity. There is no free HTML anywhere: a line is plain text, a phone is digits and
// the usual punctuation, an address is one mailbox. Each returns the cleaned value or an
// error sentence. Pure.

export type Checked<T> = { ok: true; value: T } | { error: string; ok: false };

const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
const MARKUP = /[<>]/;
const PHONE = /^[0-9+()\s.-]{6,30}$/;
const MAILBOX = /^[^\s@<>(),;:\\"[\]]+@[^\s@<>(),;:\\"[\]]+\.[^\s@<>(),;:\\"[\]]+$/;

export const MAX_ADDRESS_CHARS = 320;

/** One line of plain text, trimmed, 1 to `max` characters, no line breaks and no markup. */
export function plainLine(value: unknown, label: string, max: number): Checked<string> {
  if (typeof value !== "string") return { error: `${label} must be text`, ok: false };
  const text = value.replace(/\s+/g, " ").trim();
  if (text === "") return { error: `${label} can't be empty`, ok: false };
  if (CONTROL.test(value.replace(/[\t\r\n]/g, " "))) return { error: `${label} has characters that can't be used`, ok: false };
  if (MARKUP.test(text)) return { error: `${label} can't contain < or >`, ok: false };
  if (text.length > max) return { error: `${label} must be ${max} characters or fewer`, ok: false };
  return { ok: true, value: text };
}

/** Like plainLine but blank or absent is allowed and comes back null. */
export function optionalLine(value: unknown, label: string, max: number): Checked<string | null> {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return { ok: true, value: null };
  return plainLine(value, label, max);
}

export function optionalPhone(value: unknown, label: string): Checked<string | null> {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return { ok: true, value: null };
  if (typeof value !== "string") return { error: `${label} must be text`, ok: false };
  const phone = value.replace(/\s+/g, " ").trim();
  return PHONE.test(phone) && /\d{6,}/.test(phone.replace(/\D/g, "")) ? { ok: true, value: phone } : { error: `${label} must be a phone number`, ok: false };
}

/** An email address as one mailbox: lower-cased, no display name, no list. */
export function mailbox(value: unknown, label: string): Checked<string> {
  if (typeof value !== "string") return { error: `${label} must be an email address`, ok: false };
  const address = value.trim().toLowerCase();
  if (address.length > MAX_ADDRESS_CHARS || !MAILBOX.test(address)) return { error: `${label} must be an email address`, ok: false };
  return { ok: true, value: address };
}

export function optionalMailbox(value: unknown, label: string): Checked<string | null> {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return { ok: true, value: null };
  return mailbox(value, label);
}
