// The queue's database side: binds the worker's QueueStore to a connection. Each outcome and
// its event land together; a job that has nothing left waiting is completed, with a ledger row.

import type { Connection } from "tedious";
import { inTransaction, txOk } from "../assetRegisterSupport";
import { record } from "../ledger";
import { readIsTest } from "../test-data";
import { appendEvent } from "./events";
import {
  claimRecipient,
  completeJob,
  countRecentAttempts,
  readQueue,
  recoverStale,
  refreshCounts,
  saveDraftIds,
  setRecipientOutcome,
} from "./queueQueries";
import { moveJob, readJob } from "./store";
import type { QueueStore } from "./worker";

export const TIMER_ACTOR = "commsSendTimer";

/**
 * Counts a job's recipients and, when none is waiting (queued, sending or would-send), completes it:
 * sent if anything went, failed if nothing did. One event and one ledger row for the completion.
 */
export async function settleJob(connection: Connection, correspondenceId: number): Promise<void> {
  await inTransaction(connection, async () => {
    const tally = await refreshCounts(connection, correspondenceId);
    if (tally.pending > 0 || tally.recipients === 0) return txOk(undefined);
    const job = await readJob(connection, correspondenceId);
    if (!job || (job.status !== "queued" && job.status !== "sending")) return txOk(undefined);
    const status = tally.sent > 0 ? "sent" : "failed";
    if (!(await completeJob(connection, correspondenceId, status))) return txOk(undefined);
    await appendEvent(connection, {
      actor: { kind: "system", name: TIMER_ACTOR },
      correspondenceId,
      detail: `${tally.sent} sent, ${tally.failed} failed, ${tally.blocked} blocked`,
      fromStatus: job.status,
      toStatus: status,
      type: "job",
    });
    await record(connection, {
      action: "correspondence.sent",
      actor: { kind: "system", name: TIMER_ACTOR },
      after: { blocked: tally.blocked, failed: tally.failed, recipients: tally.recipients, sent: tally.sent, status },
      subject: { id: correspondenceId, type: "correspondence" },
    });
    return txOk(undefined);
  });
}

export function sqlQueueStore(connection: Connection): QueueStore {
  const actor = { kind: "system", name: TIMER_ACTOR } as const;
  return {
    claim: (recipientId) => claimRecipient(connection, recipientId),
    isTestTenancy: (tenancyId) => readIsTest(connection, "tenancy", tenancyId),
    async markJobSending(correspondenceId) {
      if (await moveJob(connection, correspondenceId, ["queued"], "sending")) {
        await appendEvent(connection, { actor, correspondenceId, fromStatus: "queued", toStatus: "sending", type: "job" });
      }
    },
    async outcome(item, from, outcome) {
      const result = await inTransaction(connection, async () => {
        if (!(await setRecipientOutcome(connection, item.recipient.recipientId, from, outcome))) return txOk(false);
        await appendEvent(connection, {
          actor,
          correspondenceId: item.job.correspondenceId,
          detail: outcome.detail,
          errorCode: outcome.errorCode,
          fromStatus: from,
          recipientId: item.recipient.recipientId,
          toStatus: outcome.status,
          type: "recipient",
        });
        return txOk(true);
      });
      return result.ok && result.value;
    },
    readQueue: (limit, live) => readQueue(connection, limit, live),
    recentAttempts: () => countRecentAttempts(connection),
    async recoverStale(minutes) {
      const { failed, requeued } = await recoverStale(connection, minutes);
      for (const [list, toStatus] of [[failed, "failed"], [requeued, "queued"]] as const) {
        for (const stale of list) {
          await appendEvent(connection, {
            actor,
            correspondenceId: stale.correspondenceId,
            errorCode: toStatus === "failed" ? "send_unconfirmed" : "interrupted",
            fromStatus: "sending",
            recipientId: stale.recipientId,
            toStatus,
            type: "recipient",
          });
        }
      }
      return [...new Set([...failed, ...requeued].map((stale) => stale.correspondenceId))];
    },
    saveDraft: (recipientId, graphMessageId, internetMessageId) => saveDraftIds(connection, recipientId, graphMessageId, internetMessageId),
    settle: (correspondenceId) => settleJob(connection, correspondenceId),
  };
}
