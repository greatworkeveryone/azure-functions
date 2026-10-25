import type { CorrespondenceKind, RecipientType } from "./compose";
import type { ReplyToChoice } from "./identity";
import type { Signature, SignatureMode } from "./signature";

export type JobStatus = "awaiting_approval" | "cancelled" | "draft" | "failed" | "queued" | "sending" | "sent";
export type RecipientStatus = "blocked" | "cancelled" | "failed" | "queued" | "sending" | "sent" | "would_send";

export interface JobActor {
  email: string;
  name: string;
  oid: string;
  role: string | null;
}

export interface NewRecipient {
  address: string;
  mergeValues: Record<string, string>;
  name: string | null;
  recipientRefId: string | null;
  recipientType: RecipientType;
}

export interface NewJob {
  bodyMarkdown: string;
  createdBy: JobActor;
  fromAddress: string;
  fromName: string;
  kind: CorrespondenceKind;
  recipients: NewRecipient[];
  replyTo: { address: string; identityId: number | null; name: string | null };
  signature: Signature;
  signatureMode: SignatureMode;
  subject: string;
  templateId: string | null;
  templateVersion: number | null;
}

export interface JobRow {
  approvedAt: string | null;
  approvedByName: string | null;
  approvedByOid: string | null;
  blockedCount: number;
  bodyMarkdown: string;
  cancelledAt: string | null;
  cancelledByName: string | null;
  completedAt: string | null;
  correspondenceId: number;
  createdAt: string;
  createdByEmail: string;
  createdByName: string;
  createdByOid: string;
  createdByRole: string | null;
  failedCount: number;
  fromAddress: string;
  fromName: string;
  kind: CorrespondenceKind;
  queuedAt: string | null;
  recipientCount: number;
  replyToAddress: string;
  replyToIdentityId: number | null;
  replyToName: string | null;
  requiresApproval: boolean;
  rowVersion: string;
  sentCount: number;
  signature: Signature;
  signatureMode: SignatureMode;
  status: JobStatus;
  subject: string;
  templateId: string | null;
  templateVersion: number | null;
}

export interface RecipientRow {
  address: string;
  attempts: number;
  correspondenceId: number;
  detail: string | null;
  graphMessageId: string | null;
  internetMessageId: string | null;
  lastAttemptAt: string | null;
  lastErrorCode: string | null;
  mergeValues: Record<string, string>;
  name: string | null;
  nextAttemptAt: string | null;
  recipientId: number;
  recipientRefId: string | null;
  recipientType: RecipientType;
  sentAt: string | null;
  sentToAddress: string | null;
  status: RecipientStatus;
}

/** A recipient due to go, with the job fields the worker needs to build its email. */
export interface QueueItem {
  job: JobRow;
  recipient: RecipientRow;
}

export type { ReplyToChoice };
