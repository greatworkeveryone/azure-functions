// A MyobProposals row (migration 126) as the code reads it.

import type { SqlRow } from "../db";
import type { RenderedProposal } from "./render";

export type ProposalState = "approved" | "exception" | "proposed" | "pushed" | "verified" | "withdrawn";
export type ProposalOperation = "bills.create" | "orders.create" | "orders.update" | "quotes.create" | "quotes.update";

export interface ProposalRow {
  companyFileId: string;
  correlationId: string;
  diff: unknown;
  /** What MYOB holds differently from what Floorplan sent, when it last looked (plan M10). */
  discrepancy: Record<string, unknown> | null;
  idempotencyKey: string;
  jobId: number | null;
  lastReadBackAt: string | null;
  myobError: string | null;
  myobNumber: string | null;
  myobRowVersion: string | null;
  /** MYOB's record as last read back (plan M10). */
  myobSnapshot: Record<string, unknown> | null;
  myobStatus: string | null;
  myobUid: string | null;
  myobUrl: string | null;
  operation: ProposalOperation;
  payload: Record<string, unknown>;
  payloadHash: string;
  proposalId: number;
  proposedAt: string;
  proposedBy: string;
  proposedByOid: string | null;
  pushedAt: string | null;
  readBack: Record<string, unknown> | null;
  rendered: RenderedProposal;
  reviewedAt: string | null;
  reviewedBy: string | null;
  rowVersion: string;
  state: ProposalState;
  subjectId: number;
  subjectType: "invoice" | "purchase_order" | "quote";
  targetUid: string | null;
}

export const PROPOSAL_COLUMNS = `ProposalId, Operation, SubjectType, SubjectId, JobId, CompanyFileId, TargetUid, Payload, PayloadHash,
  Rendered, IdempotencyKey, State, ProposedBy, ProposedByOid, ProposedAt, ReviewedBy, ReviewedAt, PushedAt, MyobUid,
  MyobNumber, MyobUrl, ReadBack, Diff, MyobError, CorrelationId, LastReadBackAt, MyobRowVersion, MyobStatus, MyobSnapshot,
  Discrepancy, RowVersion`;
export const INSERTED_PROPOSAL_COLUMNS = PROPOSAL_COLUMNS.split(",")
  .map((column) => `inserted.${column.trim()}`)
  .join(", ");

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : null);
const json = (value: unknown) => (typeof value === "string" && value ? JSON.parse(value) : null);

export function toProposalRow(raw: SqlRow): ProposalRow {
  return {
    companyFileId: String(raw.CompanyFileId).toLowerCase(),
    correlationId: String(raw.CorrelationId).toLowerCase(),
    diff: json(raw.Diff),
    discrepancy: json(raw.Discrepancy),
    idempotencyKey: String(raw.IdempotencyKey),
    jobId: raw.JobId == null ? null : Number(raw.JobId),
    lastReadBackAt: iso(raw.LastReadBackAt),
    myobError: (raw.MyobError as string | null) ?? null,
    myobNumber: (raw.MyobNumber as string | null) ?? null,
    myobRowVersion: (raw.MyobRowVersion as string | null) ?? null,
    myobSnapshot: json(raw.MyobSnapshot),
    myobStatus: (raw.MyobStatus as string | null) ?? null,
    myobUid: raw.MyobUid ? String(raw.MyobUid).toLowerCase() : null,
    myobUrl: (raw.MyobUrl as string | null) ?? null,
    operation: raw.Operation as ProposalOperation,
    payload: json(raw.Payload) ?? {},
    payloadHash: String(raw.PayloadHash),
    proposalId: Number(raw.ProposalId),
    proposedAt: iso(raw.ProposedAt) ?? "",
    proposedBy: String(raw.ProposedBy),
    proposedByOid: (raw.ProposedByOid as string | null) ?? null,
    pushedAt: iso(raw.PushedAt),
    readBack: json(raw.ReadBack),
    rendered: json(raw.Rendered),
    reviewedAt: iso(raw.ReviewedAt),
    reviewedBy: (raw.ReviewedBy as string | null) ?? null,
    rowVersion: Buffer.isBuffer(raw.RowVersion) ? raw.RowVersion.toString("base64") : "",
    state: raw.State as ProposalState,
    subjectId: Number(raw.SubjectId),
    subjectType: raw.SubjectType as ProposalRow["subjectType"],
    targetUid: raw.TargetUid ? String(raw.TargetUid).toLowerCase() : null,
  };
}
