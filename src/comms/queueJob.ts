// Queueing a send: the whole job, its recipients, its first event and its ledger row, in one
// transaction. Each recipient is merged here first, so one with a missing field is stored
// already blocked (and named) instead of being found at send time.

import type { Connection } from "tedious";
import { inTransaction, txOk } from "../assetRegisterSupport";
import { record } from "../ledger";
import { ledgerUserActor } from "../ledger/actor";
import { composeForRecipient, type ComposeJob } from "./compose";
import { appendEvent } from "./events";
import { findJobByKey, takeKeyLock, withKeyMarker } from "./idempotency";
import { resolveRecipientRecord, type Resolution } from "./recipientRecords";
import { insertJob, insertRecipient, readJob, recentRecipientCount } from "./store";
import type { CommsActor } from "./actor";
import type { JobStatus, NewJob, NewRecipient } from "./types";

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
  /** True when this is the job a repeated submit (the same idempotency key) had already made. */
  repeated: boolean;
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
  return job.recipients.map((recipient): Checked => ({ composed: composeForRecipient(compose, recipient, now), recipient }));
}

export interface Checked {
  composed: ReturnType<typeof composeForRecipient>;
  recipient: NewRecipient;
  /** Set when the server's own records refuse this recipient (not the record's contact, or a test record). */
  refusal?: Exclude<Resolution, { ok: true }>;
}

/** Asks the server's records about each recipient, as the send will, so a refused one is stored blocked and named. */
export async function applyResolutions(connection: Connection, checked: readonly Checked[]): Promise<Checked[]> {
  const out: Checked[] = [];
  for (const entry of checked) {
    const resolution = await resolveRecipientRecord(connection, entry.recipient);
    out.push(resolution.ok ? entry : { ...entry, refusal: resolution });
  }
  return out;
}

/** True for a recipient nothing will be sent to: a missing field, or refused by the server's records. */
export const isBlocked = (entry: Checked): boolean => !entry.composed.ok || entry.refusal !== undefined;

interface Made {
  approval: { note: string | null; reason: ApprovalReason | null };
  correspondenceId: number;
  recent: number;
  status: JobStatus;
}

type Outcome = { earlier: QueuedJob; made?: undefined } | { earlier?: undefined; made: Made };

export async function writeJob(
  connection: Connection,
  job: NewJob,
  checked: readonly Checked[],
  actor: CommsActor,
  userId: number | null,
  threshold: number,
  idempotencyKey: string | null = null,
): Promise<QueuedJob> {
  const blocked = checked.filter(isBlocked).length;
  const result = await inTransaction<Outcome>(connection, async () => {
    // A repeated submit (the same key from the same person) finds the job already made and writes nothing, so it
    // adds nothing to the 24 hour count either. The lock makes two racing submits take turns.
    if (idempotencyKey !== null) {
      if (!(await takeKeyLock(connection, actor.oid, idempotencyKey))) throw new Error("Could not take the send's lock");
      const earlier = await findJobByKey(connection, actor.oid, idempotencyKey);
      if (earlier !== null) return txOk<Outcome>({ earlier: await describeEarlier(connection, earlier, threshold) });
    }
    // Counted before this job exists and under a lock, so splitting a send into many jobs only moves the same people past the line.
    // A test to oneself (kind system) is outside the count and never waits for a manager.
    const recent = job.kind === "system" ? 0 : await recentRecipientCount(connection, actor.oid);
    const approval = job.kind === "system" ? { note: null, reason: null } : approvalDecision(job.recipients.length, recent, threshold);
    const requiresApproval = approval.reason !== null;
    const status: JobStatus = requiresApproval ? "awaiting_approval" : "queued";
    const correspondenceId = await insertJob(connection, job, status, requiresApproval);
    for (const { composed, recipient, refusal } of checked) {
      let outcome: Parameters<typeof insertRecipient>[3] = { detail: null, errorCode: null, status: "queued" };
      if (refusal) outcome = { detail: refusal.detail, errorCode: refusal.code, status: "blocked" };
      else if (!composed.ok) outcome = { detail: composed.detail, errorCode: "missing_field", status: "blocked" };
      await insertRecipient(connection, correspondenceId, recipient, outcome);
    }
    await appendEvent(connection, {
      actor: { kind: "user", name: actor.name, oid: actor.oid },
      correspondenceId,
      detail: withKeyMarker(
        !requiresApproval
          ? `${job.recipients.length} recipients`
          : approval.reason === "size"
            ? `${job.recipients.length} recipients, over ${threshold}: waits for a manager`
            : `${job.recipients.length} recipients, ${recent} in the last 24 hours, over ${threshold}: waits for a manager`,
        idempotencyKey,
      ),
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
    return txOk<Outcome>({ made: { approval, correspondenceId, recent, status } });
  });
  if (!result.ok) throw new Error("Could not queue the send");
  if (result.value.earlier) return result.value.earlier;
  const { approval, correspondenceId, recent, status } = result.value.made as Made;
  return {
    approvalNote: approval.note,
    approvalReason: approval.reason,
    blocked,
    correspondenceId,
    queued: job.recipients.length - blocked,
    recentRecipients: recent,
    repeated: false,
    status,
  };
}

/**
 * What an earlier submit with the same key made, read back as it stands now (it may since have been approved or
 * sent). Read inside the transaction. Its own recipients are taken off the 24 hour total so the answer says what
 * it said the first time, and nothing is added to the total.
 */
async function describeEarlier(connection: Connection, correspondenceId: number, threshold: number): Promise<QueuedJob> {
  const job = await readJob(connection, correspondenceId);
  if (!job) throw new Error("The earlier send could not be read");
  const total = job.kind === "system" || job.status === "cancelled" ? job.recipientCount : await recentRecipientCount(connection, job.createdByOid);
  const recent = Math.max(0, total - job.recipientCount);
  const decision = job.kind === "system" ? { note: null, reason: null } : approvalDecision(job.recipientCount, recent, threshold);
  const waits = job.requiresApproval;
  return {
    approvalNote: waits ? decision.note ?? "This send needs a manager's approval." : null,
    approvalReason: waits ? decision.reason ?? (job.recipientCount > threshold ? "size" : "recent") : null,
    blocked: job.blockedCount,
    correspondenceId,
    queued: job.recipientCount - job.blockedCount,
    recentRecipients: recent,
    repeated: true,
    status: job.status,
  };
}
