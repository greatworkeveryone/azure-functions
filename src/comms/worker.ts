// The send queue (EB1): what one minute's run does.
//
// Off unless COMMS_SEND_ENABLED is "true". With COMMS_SEND_DRY_RUN "true" it composes every
// email and marks each recipient would-send (an event and a log line) without calling Graph.
// Live, it takes queued recipients oldest first, at most COMMS_MAX_PER_MINUTE (less what the
// last minute already used, so overlapping runs share one budget), and for each one:
// checks the merge again (fail closed), refuses a test record, applies DEV_EMAIL_OVERRIDE,
// claims the recipient, makes the Graph draft (keeping its ids at once), sends it, and records
// the outcome. A failure is retried with a growing wait, three attempts in all, and records an
// error CODE only. Nothing here reads a request or the environment directly: the caller passes
// the mode and the limits, which is also what the tests rely on.

import { resolveRecipient } from "../email-recipient";
import { assertMayLeave, TestDataEgressError } from "../test-data";
import { composeForRecipient } from "./compose";
import type { CommsMode } from "./config";
import { MAX_ATTEMPTS, STALE_SENDING_MINUTES } from "./config";
import { MailSendError, toSendError, type MailSender } from "./graphSend";
import type { QueueItem } from "./types";
import type { RecipientOutcome } from "./store";
import type { RecipientStatus } from "./types";

/** What the worker needs from the database; sqlQueueStore binds it to a connection. */
export interface QueueStore {
  claim(recipientId: number): Promise<boolean>;
  isTestTenancy(tenancyId: number): Promise<boolean>;
  markJobSending(correspondenceId: number): Promise<void>;
  /** Records the outcome and its event together; false when the recipient was no longer in `from`. */
  outcome(item: QueueItem, from: RecipientStatus, outcome: RecipientOutcome): Promise<boolean>;
  readQueue(limit: number, live: boolean): Promise<QueueItem[]>;
  recentAttempts(): Promise<number>;
  recoverStale(minutes: number): Promise<number[]>;
  saveDraft(recipientId: number, graphMessageId: string, internetMessageId: string | null): Promise<void>;
  /** Counts a job's recipients and completes the job when none is waiting. */
  settle(correspondenceId: number): Promise<void>;
}

export interface WorkerOptions {
  log: (message: string) => void;
  maxPerMinute: number;
  mode: CommsMode;
  now?: () => Date;
  sender: MailSender;
  store: QueueStore;
}

export interface WorkerReport {
  blocked: number;
  budget: number;
  failed: number;
  mode: CommsMode;
  recovered: number;
  retried: number;
  sent: number;
  skipped: number;
  taken: number;
  wouldSend: number;
}

/** Minutes to wait before attempt n+1, after attempt n failed. */
export const RETRY_WAIT_MINUTES = [2, 5];

/** Graph stores long ids; the index on this column holds 800 characters, and a longer one is kept out rather than failing a sent message. */
const MAX_STORED_INTERNET_ID = 800;

const emptyReport = (mode: CommsMode): WorkerReport => ({ blocked: 0, budget: 0, failed: 0, mode, recovered: 0, retried: 0, sent: 0, skipped: 0, taken: 0, wouldSend: 0 });

export async function runCommsQueue(options: WorkerOptions): Promise<WorkerReport> {
  const { mode, store } = options;
  const report = emptyReport(mode);
  if (mode === "off") return report;
  const now = options.now ?? (() => new Date());
  const live = mode === "live";
  const touched = new Set<number>();

  if (live) {
    const recovered = await store.recoverStale(STALE_SENDING_MINUTES);
    report.recovered = recovered.length;
    for (const id of recovered) touched.add(id);
  }
  report.budget = Math.max(0, options.maxPerMinute - (await store.recentAttempts()));
  const items = report.budget > 0 ? await store.readQueue(report.budget, live) : [];
  report.taken = items.length;

  for (const item of items) {
    touched.add(item.job.correspondenceId);
    const result = await handle(item, options, live, now());
    report[result] += 1;
  }
  for (const id of touched) await store.settle(id);
  return report;
}

type Result = "blocked" | "failed" | "retried" | "sent" | "skipped" | "wouldSend";

async function handle(item: QueueItem, options: WorkerOptions, live: boolean, now: Date): Promise<Result> {
  const { job, recipient } = item;
  const { store } = options;
  const from: RecipientStatus = recipient.status;

  // Fail closed again at send time: the job and values are what was queued, but a rule may have changed.
  const composed = composeForRecipient(
    { ...job, companyName: job.fromName, replyTo: { address: job.replyToAddress, name: job.replyToName } },
    recipient,
    now,
  );
  if (!composed.ok) {
    await store.outcome(item, from, { detail: composed.detail, errorCode: "missing_field", status: "blocked" });
    return "blocked";
  }

  // A recipient tied to a test record never leaves (D9). A tenancy recipient always carries its id.
  const ref = recipient.recipientType === "tenancy" ? (recipient.recipientRefId ?? "") : null;
  try {
    // A tenancy recipient with no usable id can't be shown to be a non-test record, so it doesn't go.
    const tenancyId = ref === null ? null : /^[1-9]\d{0,9}$/.test(ref) ? Number(ref) : NaN;
    const isTest = tenancyId === null ? false : Number.isNaN(tenancyId) || (await store.isTestTenancy(tenancyId));
    assertMayLeave("email", { isTest });
  } catch (error) {
    if (!(error instanceof TestDataEgressError)) throw error;
    await store.outcome(item, from, { errorCode: "test_record", status: "blocked" });
    return "blocked";
  }

  const target = resolveRecipient(recipient.address);
  if (target.address === null) {
    await store.outcome(item, from, { errorCode: "invalid_address", status: "blocked" });
    return "blocked";
  }
  // Outside production the address is the override's; the subject says who it was meant for.
  const subject = target.overridden ? `[For ${recipient.address}] ${composed.email.subject}` : composed.email.subject;

  if (!live) {
    options.log(`commsSend: would send job ${job.correspondenceId} recipient ${recipient.recipientId} (subject of ${subject.length} characters)`);
    await store.outcome(item, from, { sentToAddress: target.address, status: "would_send" });
    return "wouldSend";
  }

  if (!(await store.claim(recipient.recipientId))) return "skipped";
  await store.markJobSending(job.correspondenceId);
  const attempt = recipient.attempts + 1;
  let graphMessageId = recipient.graphMessageId;
  let internetMessageId = recipient.internetMessageId;
  try {
    if (graphMessageId === null) {
      const draft = await options.sender.createDraft({
        from: { address: job.fromAddress, name: job.fromName },
        html: composed.email.html,
        replyTo: { address: job.replyToAddress, name: job.replyToName },
        subject,
        to: target.address,
      });
      graphMessageId = draft.graphMessageId;
      internetMessageId = draft.internetMessageId !== null && draft.internetMessageId.length <= MAX_STORED_INTERNET_ID ? draft.internetMessageId : null;
      await store.saveDraft(recipient.recipientId, graphMessageId, internetMessageId);
    }
    await options.sender.sendDraft(job.fromAddress, graphMessageId);
  } catch (error) {
    const failure = error instanceof MailSendError ? error : toSendError(error);
    const code = failure.code;
    if (failure.retryable && attempt < MAX_ATTEMPTS) {
      const wait = RETRY_WAIT_MINUTES[Math.min(attempt, RETRY_WAIT_MINUTES.length) - 1];
      await store.outcome(item, "sending", { errorCode: code, nextAttemptAt: new Date(now.getTime() + wait * 60_000), status: "queued" });
      return "retried";
    }
    await store.outcome(item, "sending", { errorCode: code, status: "failed" });
    return "failed";
  }
  await store.outcome(item, "sending", { graphMessageId, internetMessageId, sentToAddress: target.address, status: "sent" });
  return "sent";
}
