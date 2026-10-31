// Validation and the shape of contact writes (TR2). Pure; the handlers do the I/O.

import type { ContactFields } from "./store";

export type Parsed<T> = { ok: true; value: T } | { error: string; ok: false };
const fail = (error: string): { error: string; ok: false } => ({ error, ok: false });

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
/** An email as compared: trimmed and lower-cased; blank for a non-string. */
export const normaliseEmail = (value: unknown): string => (typeof value === "string" ? value.trim().toLowerCase() : "");
export const text = (value: unknown, max: number): string | null | undefined => {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed.length === 0 ? null : trimmed.length > max ? undefined : trimmed;
};

export function parseContactFields(body: Record<string, unknown>): Parsed<ContactFields> {
  const name = text(body.name, 200);
  if (name === undefined || name === null) return fail("name is required (up to 200 characters)");
  const email = text(body.email, 255);
  if (email === undefined || (email !== null && !EMAIL.test(email))) return fail("email must be a valid address");
  const phone = text(body.phone, 50);
  if (phone === undefined) return fail("phone is too long (50 characters)");
  for (const key of ["reportsIssues", "authorisedForCosts", "escalation"]) {
    if (body[key] !== undefined && typeof body[key] !== "boolean") return fail(`${key} must be true or false`);
  }
  return {
    ok: true,
    value: {
      authorisedForCosts: body.authorisedForCosts === true,
      email: email === null ? null : email.toLowerCase(),
      escalation: body.escalation === true,
      name,
      phone,
      reportsIssues: body.reportsIssues === true,
    },
  };
}

export const positiveId = (value: unknown): number | null => (Number.isInteger(value) && (value as number) > 0 ? (value as number) : null);

/** The ledger copy of a contact: ids, roles and whether it has an email, never the address or phone. */
export function contactSnapshot(c: { authorisedForCosts: boolean; contactId: number; email: string | null; escalation: boolean; name: string; reportsIssues: boolean }) {
  return { authorisedForCosts: c.authorisedForCosts, contactId: c.contactId, escalation: c.escalation, hasEmail: c.email !== null, name: c.name, reportsIssues: c.reportsIssues };
}
