// Correspondence and recipients: reads and writes (migration 108). Every statement is
// parameterised. Status changes are conditional (`WHERE Status IN (...)`) and report
// whether they changed a row, so two actors racing (a cancel and the queue, two timer
// runs) cannot both win. Callers that need several writes to land together open the
// transaction themselves. The queue's own statements are in queueQueries.ts.

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam } from "../db";
import { JOB_COLUMNS, RECIPIENT_COLUMNS, toJob, toRecipient } from "./rows";
import type { JobRow, JobStatus, NewJob, NewRecipient, RecipientRow } from "./types";

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

/** The window a sender's sends are added up over for the approval threshold. */
export const APPROVAL_WINDOW_HOURS = 24;

/**
 * How many recipients this person has queued, over every job of theirs, in the last 24 hours (a cancelled
 * job doesn't count). Read inside the queueing transaction with a range lock on the creator's rows, so two
 * sends queued at once by one person can't both see room that only one of them has.
 */
export async function recentRecipientCount(connection: Connection, createdByOid: string): Promise<number> {
  const [row] = await executeQuery(
    connection,
    `SELECT COALESCE(SUM(RecipientCount), 0) AS N FROM dbo.Correspondence WITH (UPDLOCK, HOLDLOCK)
      WHERE CreatedByOid = @Oid AND CreatedAt >= DATEADD(hour, -@Hours, SYSUTCDATETIME()) AND Status <> 'cancelled'`,
    [{ name: "Oid", type: TYPES.NVarChar, value: createdByOid }, { name: "Hours", type: TYPES.Int, value: APPROVAL_WINDOW_HOURS }],
  );
  return Number(row?.N ?? 0);
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
