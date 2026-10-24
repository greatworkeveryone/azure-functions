// Inbound email triage (EB3): the two steps processEmailSync (parseEmails.ts) takes after the
// mailbox it has always read: reading the extra mailboxes, and, once the parse worker has run,
// triaging the mail that needs an owner. Neither ever throws into the queue handler: a failure here
// must not retry the main mailbox's sync or hold up the parse, so it is logged and sent to Sentry.

import type { InvocationContext } from "@azure/functions";
import { closeConnection, createServiceRequestConnection } from "../db";
import { syncMailbox } from "../email/mail-sync";
import { Sentry } from "../sentry";
import { readInboundConfig } from "./config";
import { runInboundTriage } from "./run";

function fail(context: InvocationContext, what: string, error: unknown): void {
  context.error(`${what} failed:`, error instanceof Error ? error.message : String(error));
  Sentry.captureException(error, { extra: { context: what } });
}

/** Each INBOUND_EXTRA_MAILBOXES mailbox, with its own watermark, oldest first, as the main one is. */
export async function syncExtraMailboxes(context: InvocationContext, source: string): Promise<void> {
  const config = readInboundConfig();
  if (config.ignored.length > 0) context.warn(`inbound: ignoring entries that are not email addresses: ${config.ignored.join(", ")}`);
  if (config.extraMailboxes.length === 0) return;
  for (const mailbox of config.extraMailboxes) {
    try {
      const connection = await createServiceRequestConnection();
      try {
        const { fetched, since } = await syncMailbox(connection, mailbox, { startFromNow: true });
        context.log(`processEmailSync (${source}): synced ${fetched} email(s) from extra mailbox ${mailbox} (since=${since ?? "now"})`);
      } finally {
        closeConnection(connection);
      }
    } catch (error) {
      fail(context, `processEmailSync extra mailbox ${mailbox}`, error);
    }
  }
}

/** The invocation has a hard limit; triage takes only what is left of the parse's own budget plus this. */
export const TRIAGE_GRACE_MS = 15_000;

/** After the parse: give new mail to notices@ (and any other triage mailbox) an owner, or a place in the manager's queue. */
export async function runTriageStep(context: InvocationContext, parseDeadline: number): Promise<void> {
  const config = readInboundConfig();
  if (!config.enabled && !config.dryRun) return;
  try {
    const connection = await createServiceRequestConnection();
    try {
      const summary = await runInboundTriage(connection, { config, log: (message) => context.log(message), until: parseDeadline + TRIAGE_GRACE_MS });
      if (summary) {
        context.log(
          `inbound triage${summary.dryRun ? " (dry run)" : ""}: examined ${summary.examined}, assigned ${summary.assigned}, queued ${summary.queued}, skipped ${summary.skipped}, failed ${summary.failed}`,
        );
      }
    } finally {
      closeConnection(connection);
    }
  } catch (error) {
    fail(context, "inbound triage", error);
  }
}
