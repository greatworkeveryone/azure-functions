// One recipient's email: the job's subject and body merged with that recipient's values
// (and the server's own: who is sending, the date), then rendered. Fails closed: any
// field left blank blocks this recipient and is named, and nothing is rendered.
// Used by the preview, by the queue's up-front check and by the worker at send time, so
// all three see the same email.

import { todayInDarwin } from "../darwinDate";
import { footerAddress } from "./config";
import { mergeEmail, missingSentence, type MergeValues, type MissingField } from "./mergeFields";
import { renderEmail, type RenderedEmail } from "./render";
import type { Signature } from "./signature";

export type RecipientType = "contractor" | "manual" | "staff" | "tenancy";
export type CorrespondenceKind = "broadcast" | "letter" | "system";

export interface ComposeJob {
  bodyMarkdown: string;
  companyName: string;
  createdByName: string;
  kind: CorrespondenceKind;
  replyTo: { address: string; name: string | null };
  signature: Signature;
  signatureMode: "personal" | "role";
  subject: string;
}

export interface ComposeRecipient {
  mergeValues: Readonly<Record<string, string>>;
  name: string | null;
  recipientType: RecipientType;
}

export type Composed = { email: RenderedEmail; ok: true } | { detail: string; missing: MissingField[]; ok: false };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10-24" → "24/10/2026". */
export const dateText = (iso: string): string => iso.split("-").reverse().join("/");

/** "2026-10-24" → "24 October 2026". */
export function longDate(iso: string): string {
  const [year, month, day] = iso.split("-");
  return `${Number(day)} ${MONTHS[Number(month) - 1] ?? ""} ${year}`;
}

const REASONS: Record<RecipientType, string> = {
  contractor: "You are receiving this notice because you are a contractor registered with Randazzo Properties.",
  manual: "You are receiving this notice because Randazzo Properties addressed it to you.",
  staff: "You are receiving this notice because you work with Randazzo Properties.",
  tenancy: "You are receiving this notice because you are a listed contact for a tenancy with Randazzo Properties.",
};

/** The footer's reason line: notices say why the person is getting them; a letter needs none. */
export const receivingReason = (kind: CorrespondenceKind, type: RecipientType): string | null => (kind === "letter" ? null : REASONS[type]);

/** The values the server fills itself; they win over anything else under the same name. */
export function serverValues(job: ComposeJob, recipient: ComposeRecipient, now: Date): MergeValues {
  const today = todayInDarwin(now);
  return {
    "recipient.name": recipient.name,
    "sender.name": job.createdByName,
    // The title is known only from the sender's own signature; a team signature carries none, so a field asking for it blocks.
    "sender.title": job.signatureMode === "personal" ? (job.signature.lines[1] ?? null) : null,
    today: dateText(today),
    "today.long": longDate(today),
  };
}

export function composeForRecipient(job: ComposeJob, recipient: ComposeRecipient, now: Date = new Date()): Composed {
  const values: MergeValues = { ...recipient.mergeValues, ...serverValues(job, recipient, now) };
  const merged = mergeEmail(job.subject, job.bodyMarkdown, values);
  if (!merged.ok) {
    const empty = merged.blocks.length === 0;
    return { detail: empty ? "The email has no wording" : `Missing: ${missingSentence(merged.missing)}`.slice(0, 500), missing: merged.missing, ok: false };
  }
  return {
    email: renderEmail({
      blocks: merged.blocks,
      companyAddress: footerAddress(),
      companyName: job.companyName,
      receivingReason: receivingReason(job.kind, recipient.recipientType),
      replyTo: job.replyTo,
      signature: job.signature,
      subject: merged.subject,
    }),
    ok: true,
  };
}
