// Inbound email triage (EB3): linking a reply to the send it answers. The send core's lookup is
// behind sendLookup.ts (EB1's recipient rows); this file is only what to do with its answer.
// Linking never throws into the sync: a failed lookup leaves the email unlinked, and triage tries
// again for any email it handles.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import { ancestorIds } from "./messageIds";
import { findSendByInternetMessageId } from "./sendLookup";
import type { LinkedSend } from "./types";

const SUBJECT_MAX = 300;

export interface ReplyCandidate {
  emailId: number;
  inReplyTo: string | null;
  referenceIds: string | null;
}

/** The stored send an email answers, or null. The lookup is untrusted for length only: it is given ids and cannot be asked anything else. */
export async function linkedSendFor(connection: Connection, candidate: Pick<ReplyCandidate, "inReplyTo" | "referenceIds">): Promise<LinkedSend | null> {
  const ids = ancestorIds(candidate.inReplyTo, candidate.referenceIds);
  if (ids.length === 0) return null;
  return findSendByInternetMessageId(connection, ids);
}

const LINK_SQL = `UPDATE dbo.Emails
     SET LinkedSendKind = @Kind, LinkedSendId = @SendId, LinkedSendSubject = @Subject, LinkedAt = SYSUTCDATETIME()
   WHERE EmailID = @EmailId AND LinkedSendId IS NULL`;

/** Writes the link on the email (once: a linked email keeps the link it has). */
export async function storeLink(connection: Connection, emailId: number, send: LinkedSend): Promise<void> {
  await executeQuery(connection, LINK_SQL, [
    { name: "EmailId", type: TYPES.Int, value: emailId },
    { name: "Kind", type: TYPES.NVarChar, value: send.kind.slice(0, 30) },
    { name: "SendId", type: TYPES.NVarChar, value: send.sendId.slice(0, 64) },
    { name: "Subject", type: TYPES.NVarChar, value: send.subject ? send.subject.slice(0, SUBJECT_MAX) : null },
  ]);
}

const REPLIES_SQL = `SELECT EmailID, InReplyTo, ReferenceIds FROM dbo.Emails
   WHERE MessageID IN (SELECT [value] FROM OPENJSON(@MessageIds)) AND LinkedSendId IS NULL
     AND (InReplyTo IS NOT NULL OR ReferenceIds IS NOT NULL)
     AND SenderAuthenticated = 1`;

/**
 * After a page of mail is stored: link each reply among these message ids. Only an authenticated sender's
 * reply is linked: a forged From must not be shown as answering a send. Returns how many were linked.
 */
export async function linkReplies(connection: Connection, messageIds: readonly string[]): Promise<number> {
  if (messageIds.length === 0) return 0;
  const rows = await executeQuery(connection, REPLIES_SQL, [{ name: "MessageIds", type: TYPES.NVarChar, value: JSON.stringify(messageIds) }]);
  let linked = 0;
  for (const row of rows) {
    const send = await linkedSendFor(connection, { inReplyTo: (row.InReplyTo as string | null) ?? null, referenceIds: (row.ReferenceIds as string | null) ?? null });
    if (!send) continue;
    await storeLink(connection, Number(row.EmailID), send);
    linked += 1;
  }
  return linked;
}
