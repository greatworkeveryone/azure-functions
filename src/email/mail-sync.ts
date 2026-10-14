// Graph → Emails sync. Called by processEmailSync (parseEmails.ts) — the
// webhook and the manual sync button only enqueue.
//
// DL-13: the mailbox is read oldest-first, a page at a time, and each page is
// stored before the mailbox's watermark (dbo.EmailSyncState, migration 129)
// moves to the newest message on it. A failure part-way leaves the watermark
// on the last page that was stored, so the next sync starts there and the
// already-stored rows are skipped by MessageID. Before 129 is applied the sync
// still pages and stores; it just has nowhere to record the watermark, and
// starts after the newest stored email as it always did.

import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { executeQuery } from "../db";
import { graphFetchEmailPages } from "../graph";
import { upsertGraphEmails } from "../functions/emails";

export interface MailboxSyncResult {
  fetched: number;
  pages: number;
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

// This mailbox's own watermark. A mailbox never synced before starts after the
// newest stored email (the handover row in production), as the global
// MAX(ReceivedAt) watermark did — but once it has a row, an ingestEmail with a
// future date or another mailbox's mail can no longer move it.
async function readWatermark(connection: Connection, mailbox: string): Promise<{ since: Date | null; tracked: boolean }> {
  const [shape] = await executeQuery(
    connection,
    "SELECT CASE WHEN OBJECT_ID(N'dbo.EmailSyncState', N'U') IS NULL THEN 0 ELSE 1 END AS HasState",
  );
  const tracked = Boolean(shape?.HasState);
  if (tracked) {
    const rows = await executeQuery(
      connection,
      "SELECT LastReceivedAt FROM dbo.EmailSyncState WHERE Mailbox = @Mailbox",
      [{ name: "Mailbox", type: TYPES.NVarChar, value: mailbox }],
    );
    const last = rows[0]?.LastReceivedAt as Date | string | null | undefined;
    if (last) return { since: new Date(last), tracked };
  }
  const latestRows = await executeQuery(connection, "SELECT MAX(ReceivedAt) AS LatestReceivedAt FROM Emails");
  const rawDate = latestRows[0]?.LatestReceivedAt as Date | string | null | undefined;
  return { since: rawDate ? new Date(rawDate) : null, tracked };
}

// Only ever forward: a re-listed older page can't pull the watermark back.
async function advanceWatermark(
  connection: Connection,
  mailbox: string,
  receivedAt: Date,
  messageId: string | null,
): Promise<void> {
  await executeQuery(
    connection,
    `MERGE dbo.EmailSyncState WITH (HOLDLOCK) AS target
     USING (SELECT @Mailbox AS Mailbox) AS src ON target.Mailbox = src.Mailbox
     WHEN MATCHED AND (target.LastReceivedAt IS NULL OR target.LastReceivedAt <= @LastReceivedAt) THEN
       UPDATE SET LastReceivedAt = @LastReceivedAt, LastMessageId = @LastMessageId, UpdatedAt = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN
       INSERT (Mailbox, LastReceivedAt, LastMessageId) VALUES (@Mailbox, @LastReceivedAt, @LastMessageId);`,
    [
      { name: "Mailbox", type: TYPES.NVarChar, value: mailbox },
      { name: "LastReceivedAt", type: TYPES.DateTime2, value: receivedAt },
      { name: "LastMessageId", type: TYPES.NVarChar, value: messageId },
    ],
  );
}

// `receivedDateTime ge watermark` — `ge`, not `gt`, so two mails that share the
// newest timestamp are both seen. The rows already stored in that window go to
// Graph as a skip-set, so their attachments are not refetched.
export async function syncMailbox(connection: Connection, mailbox: string): Promise<MailboxSyncResult> {
  const { since, tracked } = await readWatermark(connection, mailbox);
  const known = since ? await knownMessageIdsSince(connection, since) : new Set<string>();

  let fetched = 0;
  let pages = 0;
  for await (const page of graphFetchEmailPages(mailbox, since?.toISOString(), known)) {
    await upsertGraphEmails(connection, page.emails);
    fetched += page.emails.length;
    pages += 1;
    if (tracked && page.newestReceivedAt) {
      await advanceWatermark(connection, mailbox, new Date(page.newestReceivedAt), page.newestMessageId);
    }
  }

  return { fetched, pages, since: since?.toISOString() ?? null };
}
