// Storage queue "email-sync" on the Function App's own AzureWebJobsStorage
// account (no new resource). HTTP handlers enqueue and return 202; the
// queue-triggered processEmailSync (parseEmails.ts) does the Graph sync,
// attachments and the deadline-driven parse. No HTTP request ever waits on
// a cold GPU (230 s response cap; Graph's webhook deadline is 3 s).

import { InvocationContext, output } from "@azure/functions";

export const EMAIL_SYNC_QUEUE = "email-sync";

export const emailSyncQueueOutput = output.storageQueue({
  connection: "AzureWebJobsStorage",
  queueName: EMAIL_SYNC_QUEUE,
});

export type EmailSyncSource = "graph" | "manual" | "admin" | "timer";

export interface EmailSyncMessage {
  requestedAt: string;
  source: EmailSyncSource;
}

// The host writes the message when the handler returns. Handlers that call
// this must list emailSyncQueueOutput in their registration's extraOutputs.
// Duplicates are harmless — sync is idempotent and claims are row-level.
export function enqueueEmailSync(context: InvocationContext, source: EmailSyncSource): void {
  const message: EmailSyncMessage = { requestedAt: new Date().toISOString(), source };
  context.extraOutputs.set(emailSyncQueueOutput, message);
}

export function isEmailSyncMessage(value: unknown): value is EmailSyncMessage {
  if (typeof value !== "object" || value === null) return false;
  const { source, requestedAt } = value as { requestedAt?: unknown; source?: unknown };
  if (typeof requestedAt !== "string") return false;
  return source === "graph" || source === "manual" || source === "admin" || source === "timer";
}
