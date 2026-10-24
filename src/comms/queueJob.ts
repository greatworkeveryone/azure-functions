// Queueing a send: the whole job, its recipients, its first event and its ledger row, in one
// transaction. Each recipient is merged here first, so one with a missing field is stored
// already blocked (and named) instead of being found at send time.

import type { Connection } from "tedious";
import { inTransaction, txOk } from "../assetRegisterSupport";
import { record } from "../ledger";
import { ledgerUserActor } from "../ledger/actor";
import { composeForRecipient, type ComposeJob } from "./compose";
import { appendEvent } from "./events";
import { insertJob, insertRecipient, recentRecipientCount } from "./store";
import type { CommsActor } from "./actor";
import type { JobStatus, NewJob } from "./types";

export type ApprovalReason = "recent" | "size";

export interface QueuedJob {
  /** In plain words why a manager has to approve it, or null; the screen shows it as it is. */
  approvalNote: string | null;
  approvalReason: ApprovalReason | null;
  blocked: number;
  correspondenceId: number;
  queued: number;
  /** This sender's recipients over the last 24 hours, before this send. */
  recentRecipients: number;
  status: JobStatus;
}

/** Whether a send needs a manager, and why: it is large itself, or this sender's last 24 hours with it are. */
export function approvalDecision(size: number, recent: number, threshold: number): { note: string | null; reason: ApprovalReason | null } {
  if (size > threshold) return { note: `This goes to ${size} people, which is over ${threshold}, so a manager approves it first.`, reason: "size" };
  if (recent + size > threshold) {
    return {
      note: `You have already sent to ${recent} ${recent === 1 ? "person" : "people"} in the last 24 hours. With these ${size} that is over ${threshold}, so a manager approves this one first.`,
      reason: "recent",
    };
  }
  return { note: null, reason: null };
}

/** Which recipients can't be merged, and why, without writing anything: the check before a job is created. */
export function checkRecipients(job: NewJob, now: Date = new Date()) {
  const compose: ComposeJob = {
    bodyMarkdown: job.bodyMarkdown,
    companyName: job.fromName,
    createdByName: job.createdBy.name,
    kind: job.kind,
    replyTo: { address: job.replyTo.address, name: job.replyTo.name },
    signature: job.signature,
    signatureMode: job.signatureMode,
    subject: job.subject,
  };
  return job.recipients.map((recipient) => ({ composed: composeForRecipient(compose, recipient, now), recipient }));
}

export async function writeJob(
  connection: Connection,
  job: NewJob,
  checked: ReturnType<typeof checkRecipients>,
  actor: CommsActor,
  userId: number | null,
  threshold: number,
): Promise<QueuedJob> {
  const blocked = checked.filter((entry) => !entry.composed.ok).length;
  const result = await inTransaction(connection, async () => {
    // Counted before this job exists and under a lock, so splitting a send into many jobs only moves the same people past the line.
    const recent = await recentRecipientCount(connection, actor.oid);
    const approval = approvalDecision(job.recipients.length, recent, threshold);
    const requiresApproval = approval.reason !== null;
    const status: JobStatus = requiresApproval ? "awaiting_approval" : "queued";
    const correspondenceId = await insertJob(connection, job, status, requiresApproval);
    for (const { composed, recipient } of checked) {
      await insertRecipient(
        connection,
        correspondenceId,
        recipient,
        composed.ok ? { detail: null, errorCode: null, status: "queued" } : { detail: composed.detail, errorCode: "missing_field", status: "blocked" },
      );
    }
    await appendEvent(connection, {
      actor: { kind: "user", name: actor.name, oid: actor.oid },
      correspondenceId,
      detail: !requiresApproval
        ? `${job.recipients.length} recipients`
        : approval.reason === "size"
          ? `${job.recipients.length} recipients, over ${threshold}: waits for a manager`
          : `${job.recipients.length} recipients, ${recent} in the last 24 hours, over ${threshold}: waits for a manager`,
      fromStatus: null,
      toStatus: status,
      type: "job",
    });
    await record(connection, {
      action: "correspondence.queue",
      actor: ledgerUserActor({ name: actor.name, roles: actor.roles, userId }),
      after: { approvalReason: approval.reason, blocked, kind: job.kind, recentRecipients: recent, recipients: job.recipients.length, replyTo: job.replyTo.address, signatureMode: job.signatureMode, status },
      subject: { id: correspondenceId, type: "correspondence" },
    });
    return txOk({ approval, correspondenceId, recent, status });
  });
  if (!result.ok) throw new Error("Could not queue the send");
  const { approval, correspondenceId, recent, status } = result.value;
  return {
    approvalNote: approval.note,
    approvalReason: approval.reason,
    blocked,
    correspondenceId,
    queued: job.recipients.length - blocked,
    recentRecipients: recent,
    status,
  };
}
