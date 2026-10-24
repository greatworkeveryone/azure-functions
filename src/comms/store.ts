// Correspondence and recipients: reads and writes (migration 108). Every statement is
// parameterised. Status changes are conditional (`WHERE Status IN (...)`) and report
// whether they changed a row, so two actors racing (a cancel and the queue, two timer
// runs) cannot both win. Callers that need several writes to land together open the
// transaction themselves.

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "../db";
import type { Signature, SignatureMode } from "./signature";
import type { JobRow, JobStatus, NewJob, NewRecipient, QueueItem, RecipientRow, RecipientStatus } from "./types";

const iso = (value: unknown): string | null => (value ? new Date(value as Date).toISOString() : null);
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

const JOB_COLUMNS = `c.CorrespondenceId, c.Kind, c.Subject, c.BodyMarkdown, c.TemplateId, c.TemplateVersion,
  c.FromAddress, c.FromName, c.ReplyToIdentityId, c.ReplyToAddress, c.ReplyToName, c.SignatureMode, c.SignatureJson,
  c.CreatedByOid, c.CreatedByName, c.CreatedByEmail, c.CreatedByRole, c.Status, c.RequiresApproval,
  c.RecipientCount, c.SentCount, c.FailedCount, c.BlockedCount,
  c.ApprovedByOid, c.ApprovedByName, c.ApprovedAt, c.CancelledByName, c.CancelledAt, c.QueuedAt, c.CompletedAt,
  CONVERT(VARCHAR(16), c.Version, 2) AS RowVersion, c.CreatedAt`;

const RECIPIENT_FIELDS = [
  "RecipientId", "CorrespondenceId", "Address", "Name", "RecipientType", "RecipientRefId", "MergeValues", "Status",
  "SentToAddress", "GraphMessageId", "InternetMessageId", "Attempts", "LastAttemptAt", "NextAttemptAt", "LastErrorCode", "Detail", "SentAt",
] as const;

const RECIPIENT_COLUMNS = RECIPIENT_FIELDS.map((field) => `r.${field}`).join(", ");
// The queue read joins both tables, so the recipient's columns come back under a prefix.
const RECIPIENT_COLUMNS_PREFIXED = RECIPIENT_FIELDS.map((field) => `r.${field} AS r_${field}`).join(", ");

function parseSignature(json: unknown): Signature {
  try {
    const value = JSON.parse(String(json)) as Partial<Signature>;
    return { email: value.email ?? null, lines: Array.isArray(value.lines) ? value.lines.map(String) : [], phone: value.phone ?? null };
  } catch {
    return { email: null, lines: [], phone: null };
  }
}

function parseValues(json: unknown): Record<string, string> {
  if (typeof json !== "string") return {};
  try {
    const value = JSON.parse(json) as unknown;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

export function toJob(row: SqlRow): JobRow {
  return {
    approvedAt: iso(row.ApprovedAt),
    approvedByName: (row.ApprovedByName as string | null) ?? null,
    approvedByOid: (row.ApprovedByOid as string | null) ?? null,
    blockedCount: Number(row.BlockedCount),
    bodyMarkdown: String(row.BodyMarkdown),
    cancelledAt: iso(row.CancelledAt),
    cancelledByName: (row.CancelledByName as string | null) ?? null,
    completedAt: iso(row.CompletedAt),
    correspondenceId: Number(row.CorrespondenceId),
    createdAt: iso(row.CreatedAt) ?? "",
    createdByEmail: String(row.CreatedByEmail),
    createdByName: String(row.CreatedByName),
    createdByOid: String(row.CreatedByOid),
    createdByRole: (row.CreatedByRole as string | null) ?? null,
    failedCount: Number(row.FailedCount),
    fromAddress: String(row.FromAddress),
    fromName: String(row.FromName),
    kind: row.Kind as JobRow["kind"],
    queuedAt: iso(row.QueuedAt),
    recipientCount: Number(row.RecipientCount),
    replyToAddress: String(row.ReplyToAddress),
    replyToIdentityId: num(row.ReplyToIdentityId),
    replyToName: (row.ReplyToName as string | null) ?? null,
    requiresApproval: row.RequiresApproval === true || row.RequiresApproval === 1,
    rowVersion: String(row.RowVersion),
    sentCount: Number(row.SentCount),
    signature: parseSignature(row.SignatureJson),
    signatureMode: row.SignatureMode as SignatureMode,
    status: row.Status as JobStatus,
    subject: String(row.Subject),
    templateId: (row.TemplateId as string | null) ?? null,
    templateVersion: num(row.TemplateVersion),
  };
}

export function toRecipient(row: SqlRow): RecipientRow {
  return {
    address: String(row.Address),
    attempts: Number(row.Attempts),
    correspondenceId: Number(row.CorrespondenceId),
    detail: (row.Detail as string | null) ?? null,
    graphMessageId: (row.GraphMessageId as string | null) ?? null,
    internetMessageId: (row.InternetMessageId as string | null) ?? null,
    lastAttemptAt: iso(row.LastAttemptAt),
    lastErrorCode: (row.LastErrorCode as string | null) ?? null,
    mergeValues: parseValues(row.MergeValues),
    name: (row.Name as string | null) ?? null,
    nextAttemptAt: iso(row.NextAttemptAt),
    recipientId: Number(row.RecipientId),
    recipientRefId: (row.RecipientRefId as string | null) ?? null,
    recipientType: row.RecipientType as RecipientRow["recipientType"],
    sentAt: iso(row.SentAt),
    sentToAddress: (row.SentToAddress as string | null) ?? null,
    status: row.Status as RecipientStatus,
  };
}

const idParam = (name: string, value: number): SqlParam => ({ name, type: TYPES.Int, value });

export async function readJob(connection: Connection, correspondenceId: number): Promise<JobRow | null> {
  const [row] = await executeQuery(connection, `SELECT ${JOB_COLUMNS} FROM dbo.Correspondence c WHERE c.CorrespondenceId = @Id`, [idParam("Id", correspondenceId)]);
  return row ? toJob(row) : null;
}

export async function readRecipients(connection: Connection, correspondenceId: number): Promise<RecipientRow[]> {
  const rows = await executeQuery(
    connection,
    `SELECT ${RECIPIENT_COLUMNS} FROM dbo.CorrespondenceRecipients r WHERE r.CorrespondenceId = @Id ORDER BY r.RecipientId`,
    [idParam("Id", correspondenceId)],
  );
  return rows.map(toRecipient);
}

export async function readRecipient(connection: Connection, correspondenceId: number, recipientId: number): Promise<RecipientRow | null> {
  const [row] = await executeQuery(
    connection,
    `SELECT ${RECIPIENT_COLUMNS} FROM dbo.CorrespondenceRecipients r WHERE r.CorrespondenceId = @Id AND r.RecipientId = @RecipientId`,
    [idParam("Id", correspondenceId), idParam("RecipientId", recipientId)],
  );
  return row ? toRecipient(row) : null;
}

const INSERT_JOB = `INSERT INTO dbo.Correspondence
    (Kind, Subject, BodyMarkdown, TemplateId, TemplateVersion, FromAddress, FromName, ReplyToIdentityId, ReplyToAddress, ReplyToName,
     SignatureMode, SignatureJson, CreatedByOid, CreatedByName, CreatedByEmail, CreatedByRole, Status, RequiresApproval, RecipientCount, QueuedAt)
  OUTPUT INSERTED.CorrespondenceId
  VALUES (@Kind, @Subject, @BodyMarkdown, @TemplateId, @TemplateVersion, @FromAddress, @FromName, @ReplyToIdentityId, @ReplyToAddress, @ReplyToName,
     @SignatureMode, @SignatureJson, @CreatedByOid, @CreatedByName, @CreatedByEmail, @CreatedByRole, @Status, @RequiresApproval, @RecipientCount,
     CASE WHEN @Status = 'queued' THEN SYSUTCDATETIME() ELSE NULL END)`;

/** Inserts the job (its recipients are added with insertRecipient) and returns its id. Run inside the caller's transaction. */
export async function insertJob(connection: Connection, job: NewJob, status: JobStatus, requiresApproval: boolean): Promise<number> {
  const [row] = await executeQuery(connection, INSERT_JOB, [
    { name: "Kind", type: TYPES.VarChar, value: job.kind },
    { name: "Subject", type: TYPES.NVarChar, value: job.subject },
    { name: "BodyMarkdown", type: TYPES.NVarChar, value: job.bodyMarkdown },
    { name: "TemplateId", type: TYPES.NVarChar, value: job.templateId },
    { name: "TemplateVersion", type: TYPES.Int, value: job.templateVersion },
    { name: "FromAddress", type: TYPES.NVarChar, value: job.fromAddress },
    { name: "FromName", type: TYPES.NVarChar, value: job.fromName },
    { name: "ReplyToIdentityId", type: TYPES.Int, value: job.replyTo.identityId },
    { name: "ReplyToAddress", type: TYPES.NVarChar, value: job.replyTo.address },
    { name: "ReplyToName", type: TYPES.NVarChar, value: job.replyTo.name },
    { name: "SignatureMode", type: TYPES.VarChar, value: job.signatureMode },
    { name: "SignatureJson", type: TYPES.NVarChar, value: JSON.stringify(job.signature) },
    { name: "CreatedByOid", type: TYPES.NVarChar, value: job.createdBy.oid },
    { name: "CreatedByName", type: TYPES.NVarChar, value: job.createdBy.name },
    { name: "CreatedByEmail", type: TYPES.NVarChar, value: job.createdBy.email },
    { name: "CreatedByRole", type: TYPES.NVarChar, value: job.createdBy.role },
    { name: "Status", type: TYPES.VarChar, value: status },
    { name: "RequiresApproval", type: TYPES.Bit, value: requiresApproval },
    { name: "RecipientCount", type: TYPES.Int, value: job.recipients.length },
  ]);
  return Number(row.CorrespondenceId);
}

const INSERT_RECIPIENT = `INSERT INTO dbo.CorrespondenceRecipients
    (CorrespondenceId, Address, Name, RecipientType, RecipientRefId, MergeValues, Status, LastErrorCode, Detail)
  OUTPUT INSERTED.RecipientId
  VALUES (@CorrespondenceId, @Address, @Name, @RecipientType, @RecipientRefId, @MergeValues, @Status, @LastErrorCode, @Detail)`;

/** A recipient that fails the up-front merge check is inserted already blocked, with the fields named in `detail`. */
export async function insertRecipient(
  connection: Connection,
  correspondenceId: number,
  recipient: NewRecipient,
  outcome: { detail: string | null; errorCode: string | null; status: "blocked" | "queued" },
): Promise<number> {
  const [row] = await executeQuery(connection, INSERT_RECIPIENT, [
    idParam("CorrespondenceId", correspondenceId),
    { name: "Address", type: TYPES.NVarChar, value: recipient.address },
    { name: "Name", type: TYPES.NVarChar, value: recipient.name },
    { name: "RecipientType", type: TYPES.VarChar, value: recipient.recipientType },
    { name: "RecipientRefId", type: TYPES.NVarChar, value: recipient.recipientRefId },
    { name: "MergeValues", type: TYPES.NVarChar, value: JSON.stringify(recipient.mergeValues) },
    { name: "Status", type: TYPES.VarChar, value: outcome.status },
    { name: "LastErrorCode", type: TYPES.VarChar, value: outcome.errorCode },
    { name: "Detail", type: TYPES.NVarChar, value: outcome.detail },
  ]);
  return Number(row.RecipientId);
}

/** Moves a job between statuses only if it is in one of `from`; false when something else got there first. */
export async function moveJob(
  connection: Connection,
  correspondenceId: number,
  from: readonly JobStatus[],
  to: JobStatus,
  extra: { approvedBy?: { name: string; oid: string }; cancelledBy?: string } = {},
): Promise<boolean> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.Correspondence SET
        Status = @To, UpdatedAt = SYSUTCDATETIME(),
        QueuedAt = CASE WHEN @To = 'queued' AND QueuedAt IS NULL THEN SYSUTCDATETIME() ELSE QueuedAt END,
        ApprovedByOid = COALESCE(@ApprovedByOid, ApprovedByOid), ApprovedByName = COALESCE(@ApprovedByName, ApprovedByName),
        ApprovedAt = CASE WHEN @ApprovedByOid IS NOT NULL THEN SYSUTCDATETIME() ELSE ApprovedAt END,
        CancelledByName = COALESCE(@CancelledByName, CancelledByName),
        CancelledAt = CASE WHEN @CancelledByName IS NOT NULL THEN SYSUTCDATETIME() ELSE CancelledAt END
      OUTPUT INSERTED.CorrespondenceId
      WHERE CorrespondenceId = @Id AND Status IN (SELECT value FROM STRING_SPLIT(@From, ','))`,
    [
      idParam("Id", correspondenceId),
      { name: "To", type: TYPES.VarChar, value: to },
      { name: "From", type: TYPES.VarChar, value: from.join(",") },
      { name: "ApprovedByOid", type: TYPES.NVarChar, value: extra.approvedBy?.oid ?? null },
      { name: "ApprovedByName", type: TYPES.NVarChar, value: extra.approvedBy?.name ?? null },
      { name: "CancelledByName", type: TYPES.NVarChar, value: extra.cancelledBy ?? null },
    ],
  );
  return rows.length === 1;
}

/** Cancels every recipient still waiting (queued or would-send); returns how many. */
export async function cancelWaitingRecipients(connection: Connection, correspondenceId: number): Promise<number> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.CorrespondenceRecipients SET Status = 'cancelled', UpdatedAt = SYSUTCDATETIME()
      OUTPUT INSERTED.RecipientId
      WHERE CorrespondenceId = @Id AND Status IN ('queued', 'would_send')`,
    [idParam("Id", correspondenceId)],
  );
  return rows.length;
}

// ── The queue ────────────────────────────────────────────────────────────────

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
  recipientId: number;
}

/**
 * A recipient claimed `minutes` ago with no outcome means the run died. With no draft it can go again; with a
 * draft the send may or may not have happened, so it is failed for a person to check (never sent twice).
 */
export async function recoverStale(connection: Connection, minutes: number): Promise<{ failed: StaleRecipient[]; requeued: StaleRecipient[] }> {
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.CorrespondenceRecipients SET
        Status = CASE WHEN GraphMessageId IS NULL THEN 'queued' ELSE 'failed' END,
        LastErrorCode = CASE WHEN GraphMessageId IS NULL THEN 'interrupted' ELSE 'send_unconfirmed' END,
        UpdatedAt = SYSUTCDATETIME()
      OUTPUT INSERTED.RecipientId, INSERTED.CorrespondenceId, INSERTED.Status
      WHERE Status = 'sending' AND LastAttemptAt < DATEADD(minute, -@Minutes, SYSUTCDATETIME())`,
    [{ name: "Minutes", type: TYPES.Int, value: minutes }],
  );
  const pick = (status: string): StaleRecipient[] =>
    rows.filter((row) => row.Status === status).map((row) => ({ correspondenceId: Number(row.CorrespondenceId), recipientId: Number(row.RecipientId) }));
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
