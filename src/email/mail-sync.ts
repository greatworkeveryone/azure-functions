// Graph → Emails sync. Called by processEmailSync (parseEmails.ts) — the
// webhook and the manual sync button only enqueue.

import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { executeQuery } from "../db";
import { graphFetchEmails } from "../graph";
import { upsertGraphEmails } from "../functions/emails";

export interface MailboxSyncResult {
  fetched: number;
  since: string | null;
}

async function knownMessageIdsSince(connection: Connection, since: Date): Promise<Set<string>> {
  const rows = await executeQuery(
    connection,
    "SELECT MessageID FROM Emails WHERE ReceivedAt >= @Since",
    [{ name: "Since", type: TYPES.DateTime2, value: since }],
  );
  return new Set(rows.map((r) => r.MessageID).filter((id): id is string => typeof id === "string"));
}

// `receivedDateTime ge MAX(ReceivedAt)` — `ge`, not `gt`, so two mails that
// share the newest timestamp are both seen. The rows already stored in that
// window go to Graph as a skip-set, so their attachments are not refetched.
export async function syncMailbox(connection: Connection, mailbox: string): Promise<MailboxSyncResult> {
  const latestRows = await executeQuery(connection, "SELECT MAX(ReceivedAt) AS LatestReceivedAt FROM Emails");
  const rawDate = latestRows[0]?.LatestReceivedAt as Date | string | null | undefined;
  const since = rawDate ? new Date(rawDate) : null;

  const known = since ? await knownMessageIdsSince(connection, since) : new Set<string>();
  const emails = await graphFetchEmails(mailbox, since?.toISOString(), known);
  await upsertGraphEmails(connection, emails);

  return { fetched: emails.length, since: since?.toISOString() ?? null };
}
