// How a Correspondence or CorrespondenceRecipients row reads: the column lists (explicit, no
// SELECT *) and the mappers from a database row to JobRow and RecipientRow (migration 108).

import type { SqlRow } from "../db";
import type { Signature, SignatureMode } from "./signature";
import type { JobRow, JobStatus, RecipientRow, RecipientStatus } from "./types";

const iso = (value: unknown): string | null => (value ? new Date(value as Date).toISOString() : null);
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export const JOB_COLUMNS = `c.CorrespondenceId, c.Kind, c.Subject, c.BodyMarkdown, c.TemplateId, c.TemplateVersion,
  c.FromAddress, c.FromName, c.ReplyToIdentityId, c.ReplyToAddress, c.ReplyToName, c.SignatureMode, c.SignatureJson,
  c.CreatedByOid, c.CreatedByName, c.CreatedByEmail, c.CreatedByRole, c.Status, c.RequiresApproval,
  c.RecipientCount, c.SentCount, c.FailedCount, c.BlockedCount,
  c.ApprovedByOid, c.ApprovedByName, c.ApprovedAt, c.CancelledByName, c.CancelledAt, c.QueuedAt, c.CompletedAt,
  CONVERT(VARCHAR(16), CAST(c.Version AS VARBINARY(8)), 2) AS RowVersion, c.CreatedAt`;

const RECIPIENT_FIELDS = [
  "RecipientId", "CorrespondenceId", "Address", "Name", "RecipientType", "RecipientRefId", "MergeValues", "Status",
  "SentToAddress", "GraphMessageId", "InternetMessageId", "Attempts", "LastAttemptAt", "NextAttemptAt", "LastErrorCode", "Detail", "SentAt",
] as const;

export const RECIPIENT_COLUMNS = RECIPIENT_FIELDS.map((field) => `r.${field}`).join(", ");
// The queue read joins both tables, so the recipient's columns come back under a prefix.
export const RECIPIENT_COLUMNS_PREFIXED = RECIPIENT_FIELDS.map((field) => `r.${field} AS r_${field}`).join(", ");

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
