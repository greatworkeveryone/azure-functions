// Queue one library-template email: the approved/live check, the job literal, the recipient check and the
// "nobody can be sent this" refusal, then the write. The three senders that used to copy this (the request
// acknowledgement, the certificate thank-you, the tenant status notice) differ only in who the sender is, who the
// recipients are and what they say when it is refused; the caller loads the template, because a missing one is
// worded differently by each.

import type { Connection } from "tedious";
import type { LibraryTemplate } from "../intake/template";
import type { CommsActor } from "./actor";
import { approvalThreshold, fromAddress, fromName } from "./config";
import { applyResolutions, checkRecipients, isBlocked, writeJob } from "./queueJob";
import type { JobStatus, NewJob, NewRecipient } from "./types";

export interface TemplatedLetter {
  actor: CommsActor;
  /** True when sends are live (commsMode() === "live"): an unapproved template is then refused. */
  commsLive: boolean;
  /** Idempotency key: a repeat finds the job already queued instead of queueing a second. */
  key: string;
  kind: NewJob["kind"];
  recipients: NewRecipient[];
  replyTo: NewJob["replyTo"];
  signature: NewJob["signature"];
  signatureMode: NewJob["signatureMode"];
  template: LibraryTemplate;
  /** The id the correspondence row records, e.g. "request_ack". */
  templateId: string;
  /** The Floorplan user the job is attributed to, when there is one. */
  userId: number | null;
}

export type TemplatedLetterResult =
  | { correspondenceId: number; ok: true; recipients: string; status: JobStatus }
  | { code: "blocked" | "unapproved"; detail: string; ok: false };

export async function queueTemplatedLetter(connection: Connection, letter: TemplatedLetter): Promise<TemplatedLetterResult> {
  const { actor, template } = letter;
  if (!template.approved && letter.commsLive) return { code: "unapproved", detail: `The ${letter.templateId} template hasn't been approved yet, so it can't be sent`, ok: false };
  const job: NewJob = {
    bodyMarkdown: template.bodyMarkdown,
    createdBy: { email: actor.email, name: actor.name, oid: actor.oid, role: actor.role },
    fromAddress: fromAddress(),
    fromName: fromName(),
    kind: letter.kind,
    recipients: letter.recipients,
    replyTo: letter.replyTo,
    signature: letter.signature,
    signatureMode: letter.signatureMode,
    subject: template.subject,
    templateId: letter.templateId,
    templateVersion: template.version,
  };
  const checked = await applyResolutions(connection, checkRecipients(job));
  if (checked.every(isBlocked)) {
    const first = checked[0];
    return { code: "blocked", detail: first.refusal?.detail ?? (first.composed.ok ? "no valid recipient" : first.composed.detail), ok: false };
  }
  const queued = await writeJob(connection, job, checked, actor, letter.userId, approvalThreshold(), letter.key);
  const recipients = checked.filter((entry) => !isBlocked(entry)).map((entry) => (entry.recipient.name ? `${entry.recipient.name} <${entry.recipient.address}>` : entry.recipient.address));
  return { correspondenceId: queued.correspondenceId, ok: true, recipients: recipients.join(", ").slice(0, 600), status: queued.status };
}
