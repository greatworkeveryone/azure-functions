// Approving and cancelling a send: the status change, its event and its ledger row, together.

import type { Connection } from "tedious";
import { inTransaction, txFail, txOk } from "../assetRegisterSupport";
import { record } from "../ledger";
import { ledgerUserActor } from "../ledger/actor";
import type { CommsActor } from "./actor";
import { appendEvent } from "./events";
import { cancelWaitingRecipients, moveJob } from "./store";
import type { JobRow, JobStatus } from "./types";

export type Decided = { ok: true; status: JobStatus } | { error: string; ok: false };

const ledgerActor = (actor: CommsActor, userId: number | null) => ledgerUserActor({ name: actor.name, roles: actor.roles, userId });

/** awaiting_approval → queued. The creator can't approve their own (checked here and by the route). */
export async function approveJob(connection: Connection, job: JobRow, actor: CommsActor, userId: number | null): Promise<Decided> {
  if (job.createdByOid === actor.oid) return { error: "Someone else has to approve a send you queued", ok: false };
  const result = await inTransaction<JobStatus>(connection, async () => {
    if (!(await moveJob(connection, job.correspondenceId, ["awaiting_approval"], "queued", { approvedBy: { name: actor.name, oid: actor.oid } }))) {
      return txFail({ jsonBody: { error: "This send is no longer waiting for approval" }, status: 409 });
    }
    await appendEvent(connection, { actor: { kind: "user", name: actor.name, oid: actor.oid }, correspondenceId: job.correspondenceId, fromStatus: "awaiting_approval", toStatus: "queued", type: "job" });
    await record(connection, {
      action: "correspondence.approve",
      actor: ledgerActor(actor, userId),
      after: { recipients: job.recipientCount, status: "queued" },
      before: { status: "awaiting_approval" },
      subject: { id: job.correspondenceId, type: "correspondence" },
    });
    return txOk("queued");
  });
  return result.ok ? { ok: true, status: result.value } : { error: "This send is no longer waiting for approval", ok: false };
}

const CANCELLABLE: readonly JobStatus[] = ["draft", "awaiting_approval", "queued"];

/** Cancels a send that has not begun to go out, and every recipient still waiting. */
export async function cancelJob(connection: Connection, job: JobRow, actor: CommsActor, userId: number | null): Promise<Decided> {
  const result = await inTransaction<JobStatus>(connection, async () => {
    if (!(await moveJob(connection, job.correspondenceId, CANCELLABLE, "cancelled", { cancelledBy: actor.name }))) {
      return txFail({ jsonBody: { error: "This send has already started or finished, so it can't be cancelled" }, status: 409 });
    }
    const cancelled = await cancelWaitingRecipients(connection, job.correspondenceId);
    await appendEvent(connection, {
      actor: { kind: "user", name: actor.name, oid: actor.oid },
      correspondenceId: job.correspondenceId,
      detail: `${cancelled} recipients not sent`,
      fromStatus: job.status,
      toStatus: "cancelled",
      type: "job",
    });
    await record(connection, {
      action: "correspondence.cancel",
      actor: ledgerActor(actor, userId),
      after: { status: "cancelled", unsent: cancelled },
      before: { status: job.status },
      subject: { id: job.correspondenceId, type: "correspondence" },
    });
    return txOk("cancelled");
  });
  return result.ok ? { ok: true, status: result.value } : { error: "This send has already started or finished, so it can't be cancelled", ok: false };
}
