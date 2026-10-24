// Queueing a send: the whole job, its recipients, its first event and its ledger row, in one
// transaction. Each recipient is merged here first, so one with a missing field is stored
// already blocked (and named) instead of being found at send time.

import type { Connection } from "tedious";
import { inTransaction, txOk } from "../assetRegisterSupport";
import { record } from "../ledger";
import { ledgerUserActor } from "../ledger/actor";
import { composeForRecipient, type ComposeJob } from "./compose";
import { appendEvent } from "./events";
import { takeKeyLock, findJobByKey, withKeyMarker } from "./idempotency";
import { insertJob, insertRecipient, readJob } from "./store";
import type { CommsActor } from "./actor";
import type { JobStatus, NewJob } from "./types";

export interface QueuedJob {
  blocked: number;
  correspondenceId: number;
  queued: number;
  /** True when this is the job a repeated submit (the same idempotency key) had already made. */
  repeated: boolean;
  status: JobStatus;
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
  idempotencyKey: string | null = null,
): Promise<QueuedJob> {
  const requiresApproval = job.recipients.length > threshold;
  const status: JobStatus = requiresApproval ? "awaiting_approval" : "queued";
  const blocked = checked.filter((entry) => !entry.composed.ok).length;
  const result = await inTransaction(connection, async () => {
    if (idempotencyKey !== null) {
      if (!(await takeKeyLock(connection, actor.oid, idempotencyKey))) throw new Error("Could not take the send's lock");
      const earlier = await findJobByKey(connection, actor.oid, idempotencyKey);
      if (earlier !== null) return txOk({ correspondenceId: earlier, repeated: true });
    }
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
      detail: withKeyMarker(requiresApproval ? `${job.recipients.length} recipients, over ${threshold}: waits for a manager` : `${job.recipients.length} recipients`, idempotencyKey),
      fromStatus: null,
      toStatus: status,
      type: "job",
    });
    await record(connection, {
      action: "correspondence.queue",
      actor: ledgerUserActor({ name: actor.name, roles: actor.roles, userId }),
      after: { blocked, kind: job.kind, recipients: job.recipients.length, replyTo: job.replyTo.address, signatureMode: job.signatureMode, status },
      subject: { id: correspondenceId, type: "correspondence" },
    });
    return txOk({ correspondenceId, repeated: false });
  });
  if (!result.ok) throw new Error("Could not queue the send");
  if (result.value.repeated) return existingJob(connection, result.value.correspondenceId);
  return { blocked, correspondenceId: result.value.correspondenceId, queued: job.recipients.length - blocked, repeated: false, status };
}

/** What the earlier submit made, read back as it stands now (it may since have been approved or sent). */
async function existingJob(connection: Connection, correspondenceId: number): Promise<QueuedJob> {
  const job = await readJob(connection, correspondenceId);
  if (!job) throw new Error("The earlier send could not be read");
  return { blocked: job.blockedCount, correspondenceId, queued: job.recipientCount - job.blockedCount, repeated: true, status: job.status };
}
