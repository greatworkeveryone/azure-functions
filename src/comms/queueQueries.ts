// The send queue's statements (migration 108): what is due, taking a recipient for sending, recording
// where it ended up, recovering a run that died, and counting a job's recipients to complete it. Every
// change is conditional on the status it expects and says whether it changed a row.

import { TYPES, type Connection } from "tedious";
import { MAX_ATTEMPTS } from "./config";
import { executeQuery, type SqlParam, type SqlRow } from "../db";
import { JOB_COLUMNS, RECIPIENT_COLUMNS_PREFIXED, toJob, toRecipient } from "./rows";
import type { QueueItem, RecipientStatus } from "./types";

const idParam = (name: string, value: number): SqlParam => ({ name, type: TYPES.Int, value });

/**
 * Recipients due to go, oldest job first. A dry run reads only `queued` (a would-send
 * recipient is done for the dry run); live also takes the would-send ones, so turning the
 * dry run off sends what it marked. A recipient waits for its NextAttemptAt after a failure.
 */
export async function readQueue(connection: Connection, limit: number, live: boolean): Promise<QueueItem[]> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP (@Limit) ${JOB_COLUMNS}, ${RECIPIENT_COLUMNS_PREFIXED}
       FROM dbo.CorrespondenceRecipients r
       JOIN dbo.Correspondence c ON c.CorrespondenceId = r.CorrespondenceId
      WHERE c.Status IN ('queued', 'sending')
        AND (r.Status = 'queued' OR (@Live = 1 AND r.Status = 'would_send'))
        AND (r.NextAttemptAt IS NULL OR r.NextAttemptAt <= SYSUTCDATETIME())
      ORDER BY c.QueuedAt, r.RecipientId`,
    [{ name: "Limit", type: TYPES.Int, value: limit }, { name: "Live", type: TYPES.Bit, value: live }],
  );
  return rows.map((row) => {
    const recipient: SqlRow = {};
    for (const [key, value] of Object.entries(row)) if (key.startsWith("r_")) recipient[key.slice(2)] = value;
    return { job: toJob(row), recipient: toRecipient(recipient) };
  });
}

/** Messages the queue started in the last minute, so overlapping runs share one budget. */
export async function countRecentAttempts(connection: Connection, seconds = 60): Promise<number> {
  const [row] = await executeQuery(
    connection,
    `SELECT COUNT(*) AS N FROM dbo.CorrespondenceRecipients WHERE LastAttemptAt >= DATEADD(second, -@Seconds, SYSUTCDATETIME())`,
    [{ name: "Seconds", type: TYPES.Int, value: seconds }],
  );
  return Number(row?.N ?? 0);
}

/** Takes a recipient for sending. False when another run took it first, or the job was cancelled in the meantime. */
export async function claimRecipient(connection: Connection, recipientId: number): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `UPDATE r SET Status = 'sending', Attempts = Attempts + 1, LastAttemptAt = SYSUTCDATETIME(), NextAttemptAt = NULL, UpdatedAt = SYSUTCDATETIME()
      OUTPUT INSERTED.RecipientId
      FROM dbo.CorrespondenceRecipients r
      WHERE r.RecipientId = @Id AND r.Status IN ('queued', 'would_send')
        AND EXISTS (SELECT 1 FROM dbo.Correspondence c WHERE c.CorrespondenceId = r.CorrespondenceId AND c.Status IN ('queued', 'sending'))`,
    [idParam("Id", recipientId)],
  );
  return rows.length === 1;
}

export interface RecipientOutcome {
  detail?: string | null;
  errorCode?: string | null;
  graphMessageId?: string | null;
  internetMessageId?: string | null;
  nextAttemptAt?: Date | null;
  sentToAddress?: string | null;
  status: Exclude<RecipientStatus, "sending">;
}

/**
 * Records where a recipient ended up (or, for a retry, back to queued with a time). `from` guards
 * the change: it only applies if the recipient is still in that status.
 */
export async function setRecipientOutcome(connection: Connection, recipientId: number, from: RecipientStatus, outcome: RecipientOutcome): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.CorrespondenceRecipients SET
        Status = @Status, LastErrorCode = @ErrorCode, Detail = @Detail, NextAttemptAt = @NextAttemptAt,
        SentToAddress = COALESCE(@SentToAddress, SentToAddress),
        GraphMessageId = COALESCE(@GraphMessageId, GraphMessageId), InternetMessageId = COALESCE(@InternetMessageId, InternetMessageId),
        SentAt = CASE WHEN @Status = 'sent' THEN SYSUTCDATETIME() ELSE SentAt END,
        LastAttemptAt = CASE WHEN @Status = 'would_send' THEN SYSUTCDATETIME() ELSE LastAttemptAt END,
        UpdatedAt = SYSUTCDATETIME()
      OUTPUT INSERTED.RecipientId
      WHERE RecipientId = @Id AND Status = @From`,
    [
      idParam("Id", recipientId),
      { name: "From", type: TYPES.VarChar, value: from },
      { name: "Status", type: TYPES.VarChar, value: outcome.status },
      { name: "ErrorCode", type: TYPES.VarChar, value: outcome.errorCode ?? null },
      { name: "Detail", type: TYPES.NVarChar, value: outcome.detail ? outcome.detail.slice(0, 500) : null },
      { name: "NextAttemptAt", type: TYPES.DateTime2, value: outcome.nextAttemptAt ?? null },
      { name: "SentToAddress", type: TYPES.NVarChar, value: outcome.sentToAddress ?? null },
      { name: "GraphMessageId", type: TYPES.NVarChar, value: outcome.graphMessageId ?? null },
      { name: "InternetMessageId", type: TYPES.NVarChar, value: outcome.internetMessageId ?? null },
    ],
  );
  return rows.length === 1;
}

/** Keeps the draft's ids the moment it exists, so a retry sends that draft instead of making another. */
export async function saveDraftIds(connection: Connection, recipientId: number, graphMessageId: string, internetMessageId: string | null): Promise<void> {
  await executeQuery(
    connection,
    `UPDATE dbo.CorrespondenceRecipients SET GraphMessageId = @GraphMessageId, InternetMessageId = @InternetMessageId, UpdatedAt = SYSUTCDATETIME() WHERE RecipientId = @Id`,
    [
      idParam("Id", recipientId),
      { name: "GraphMessageId", type: TYPES.NVarChar, value: graphMessageId },
      { name: "InternetMessageId", type: TYPES.NVarChar, value: internetMessageId },
    ],
  );
}

export interface StaleRecipient {
  correspondenceId: number;
  /** Why it was moved: `interrupted` (requeued, or failed once its attempts are used up) or `send_unconfirmed`. */
  errorCode: string;
  recipientId: number;
}

/**
 * A recipient claimed `minutes` ago with no outcome means the run died. With no draft it can go again, until
 * it has been claimed `maxAttempts` times: a message that kills every run would otherwise be claimed every
 * cycle for ever, spending the minute's budget. With a draft the send may or may not have happened, so it is
 * failed for a person to check (never sent twice).
 */
export async function recoverStale(connection: Connection, minutes: number, maxAttempts: number = MAX_ATTEMPTS): Promise<{ failed: StaleRecipient[]; requeued: StaleRecipient[] }> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.CorrespondenceRecipients SET
        Status = CASE WHEN GraphMessageId IS NULL AND Attempts < @MaxAttempts THEN 'queued' ELSE 'failed' END,
        LastErrorCode = CASE WHEN GraphMessageId IS NULL THEN 'interrupted' ELSE 'send_unconfirmed' END,
        UpdatedAt = SYSUTCDATETIME()
      OUTPUT INSERTED.RecipientId, INSERTED.CorrespondenceId, INSERTED.Status, INSERTED.LastErrorCode
      WHERE Status = 'sending' AND LastAttemptAt < DATEADD(minute, -@Minutes, SYSUTCDATETIME())`,
    [
      { name: "Minutes", type: TYPES.Int, value: minutes },
      { name: "MaxAttempts", type: TYPES.Int, value: maxAttempts },
    ],
  );
  const pick = (status: string): StaleRecipient[] =>
    rows.filter((row) => row.Status === status).map((row) => ({ correspondenceId: Number(row.CorrespondenceId), errorCode: String(row.LastErrorCode), recipientId: Number(row.RecipientId) }));
  return { failed: pick("failed"), requeued: pick("queued") };
}

export interface JobTally {
  blocked: number;
  failed: number;
  pending: number;
  recipients: number;
  sent: number;
}

/** Writes the job's counts from its recipients and returns them; `pending` counts queued, sending and would-send. */
export async function refreshCounts(connection: Connection, correspondenceId: number): Promise<JobTally> {
  const [row] = await executeQuery(
    connection,
    `UPDATE dbo.Correspondence SET
        SentCount = t.Sent, FailedCount = t.Failed, BlockedCount = t.Blocked, UpdatedAt = SYSUTCDATETIME()
      OUTPUT t.Sent AS Sent, t.Failed AS Failed, t.Blocked AS Blocked, t.Pending AS Pending, t.Total AS Total
      FROM dbo.Correspondence c
      CROSS APPLY (SELECT
          COALESCE(SUM(CASE WHEN r.Status = 'sent' THEN 1 ELSE 0 END), 0) AS Sent,
          COALESCE(SUM(CASE WHEN r.Status = 'failed' THEN 1 ELSE 0 END), 0) AS Failed,
          COALESCE(SUM(CASE WHEN r.Status = 'blocked' THEN 1 ELSE 0 END), 0) AS Blocked,
          COALESCE(SUM(CASE WHEN r.Status IN ('queued', 'sending', 'would_send') THEN 1 ELSE 0 END), 0) AS Pending,
          COUNT(*) AS Total
        FROM dbo.CorrespondenceRecipients r WHERE r.CorrespondenceId = c.CorrespondenceId) t
      WHERE c.CorrespondenceId = @Id`,
    [idParam("Id", correspondenceId)],
  );
  return {
    blocked: Number(row?.Blocked ?? 0),
    failed: Number(row?.Failed ?? 0),
    pending: Number(row?.Pending ?? 0),
    recipients: Number(row?.Total ?? 0),
    sent: Number(row?.Sent ?? 0),
  };
}

/** Marks a job complete: sent if anything went, failed if nothing did. False if it was no longer queued or sending. */
export async function completeJob(connection: Connection, correspondenceId: number, status: "failed" | "sent"): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.Correspondence SET Status = @Status, CompletedAt = SYSUTCDATETIME(), UpdatedAt = SYSUTCDATETIME()
      OUTPUT INSERTED.CorrespondenceId
      WHERE CorrespondenceId = @Id AND Status IN ('queued', 'sending')`,
    [idParam("Id", correspondenceId), { name: "Status", type: TYPES.VarChar, value: status }],
  );
  return rows.length === 1;
}
