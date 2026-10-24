// The signature of an email, composed on the server and nowhere else.
//
// `role` is the reply-to identity's role signature (a team or department, never a
// person); `personal` is the sender's own standard signature: their verified name from
// the token plus the job title and phone they keep in Floorplan. Nothing here reads a
// request: a caller passes the actor and the identity it loaded itself. Pure.

import { optionalLine, optionalPhone, plainLine, type Checked } from "./fields";
import { ORG_DOMAIN } from "./config";
import type { CommsIdentity } from "./identity";

export interface Signature {
  /** Plain-text lines under "Kind regards,": the first is the name of the person or team. */
  lines: string[];
  phone: string | null;
  email: string | null;
}

/** The sender as the server knows them: name and email from the verified token, title and phone from UserSignatures. */
export interface SignatureActor {
  email: string;
  jobTitle: string | null;
  name: string;
  phone: string | null;
}

export type SignatureMode = "personal" | "role";
export const SIGNATURE_MODES: readonly SignatureMode[] = ["role", "personal"];

export const MAX_SIGNATURE_LINES = 6;
export const MAX_LINE_CHARS = 120;

export type Composed = { ok: true; signature: Signature } | { error: string; ok: false };

const onOrgDomain = (email: string): boolean => email.toLowerCase().endsWith(`@${ORG_DOMAIN}`);

export function composeSignature(actor: SignatureActor, mode: SignatureMode, identity: Pick<CommsIdentity, "signature"> | null): Composed {
  if (mode === "role") {
    if (identity === null) return { error: "A team signature needs a reply-to identity; choose your own signature instead", ok: false };
    const { lines, phone, email } = identity.signature;
    if (lines.length === 0) return { error: "That identity has no team signature yet", ok: false };
    return { ok: true, signature: { email, lines: [...lines], phone } };
  }
  return {
    ok: true,
    signature: {
      email: onOrgDomain(actor.email) ? actor.email.toLowerCase() : null,
      lines: [actor.name, ...(actor.jobTitle ? [actor.jobTitle] : [])],
      phone: actor.phone,
    },
  };
}

/** The role signature an admin types for an identity: 1 to 6 lines, an optional phone and email. */
export function parseRoleSignature(input: { email: unknown; lines: unknown; phone: unknown }): Checked<Signature> {
  if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > MAX_SIGNATURE_LINES) {
    return { error: `The team signature needs 1 to ${MAX_SIGNATURE_LINES} lines`, ok: false };
  }
  const lines: string[] = [];
  for (const [index, raw] of input.lines.entries()) {
    const line = plainLine(raw, `Signature line ${index + 1}`, MAX_LINE_CHARS);
    if (!line.ok) return line;
    lines.push(line.value);
  }
  const phone = optionalPhone(input.phone, "Signature phone");
  if (!phone.ok) return phone;
  const email = optionalLine(input.email, "Signature email", 320);
  if (!email.ok) return email;
  if (email.value !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value)) return { error: "Signature email must be an email address", ok: false };
  return { ok: true, value: { email: email.value?.toLowerCase() ?? null, lines, phone: phone.value } };
}

/** A person's job title and phone for their standard signature. */
export function parseUserSignature(input: { jobTitle: unknown; phone: unknown }): Checked<{ jobTitle: string | null; phone: string | null }> {
  const jobTitle = optionalLine(input.jobTitle, "Job title", 80);
  if (!jobTitle.ok) return jobTitle;
  const phone = optionalPhone(input.phone, "Phone");
  if (!phone.ok) return phone;
  return { ok: true, value: { jobTitle: jobTitle.value, phone: phone.value } };
}
