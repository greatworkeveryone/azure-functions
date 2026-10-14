// dbo.MyobProposals (migration 126): reads and writes for the proposal
// pipeline. Writes take the caller's transaction and the row's ROWVERSION, so
// two people acting on one proposal get one success and one 409.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { buildUpdateSet, executeQuery, type SqlRow } from "../db";
import type { RenderedProposal } from "./render";

export type ProposalState = "approved" | "exception" | "proposed" | "pushed" | "verified" | "withdrawn";
export type ProposalOperation = "bills.create" | "orders.create" | "orders.update" | "quotes.create" | "quotes.update";

export interface ProposalRow {
  companyFileId: string;
  correlationId: string;
  diff: unknown;
  idempotencyKey: string;
  jobId: number | null;
  lastReadBackAt: string | null;
  myobError: string | null;
  myobNumber: string | null;
  myobRowVersion: string | null;
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
  MyobNumber, MyobUrl, ReadBack, Diff, MyobError, CorrelationId, LastReadBackAt, MyobRowVersion, RowVersion`;
const INSERTED_PROPOSAL_COLUMNS = PROPOSAL_COLUMNS.split(",")
  .map((column) => `inserted.${column.trim()}`)
  .join(", ");

const iso = (value: unknown) => (value instanceof Date ? value.toISOString() : null);
const json = (value: unknown) => (typeof value === "string" && value ? JSON.parse(value) : null);

export function toProposalRow(raw: SqlRow): ProposalRow {
  return {
    companyFileId: String(raw.CompanyFileId).toLowerCase(),
    correlationId: String(raw.CorrelationId).toLowerCase(),
    diff: json(raw.Diff),
    idempotencyKey: String(raw.IdempotencyKey),
    jobId: raw.JobId == null ? null : Number(raw.JobId),
    lastReadBackAt: iso(raw.LastReadBackAt),
    myobError: (raw.MyobError as string | null) ?? null,
    myobNumber: (raw.MyobNumber as string | null) ?? null,
    myobRowVersion: (raw.MyobRowVersion as string | null) ?? null,
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

const p = (name: string, type: (typeof TYPES)[keyof typeof TYPES], value: unknown) => ({ name, type, value });

export async function getProposal(connection: Connection, id: number, lock = false): Promise<ProposalRow | null> {
  const rows = await executeQuery(
    connection,
    lock
      ? `SELECT ${PROPOSAL_COLUMNS} FROM dbo.MyobProposals WITH (UPDLOCK, HOLDLOCK) WHERE ProposalId = @Id`
      : `SELECT ${PROPOSAL_COLUMNS} FROM dbo.MyobProposals WHERE ProposalId = @Id`,
    [p("Id", TYPES.Int, id)],
  );
  return rows[0] ? toProposalRow(rows[0]) : null;
}

export async function proposalsForSubject(connection: Connection, subjectType: string, subjectId: number): Promise<ProposalRow[]> {
  const rows = await executeQuery(
    connection,
    `SELECT ${PROPOSAL_COLUMNS} FROM dbo.MyobProposals WHERE SubjectType = @SubjectType AND SubjectId = @SubjectId ORDER BY ProposalId DESC`,
    [p("SubjectType", TYPES.NVarChar, subjectType), p("SubjectId", TYPES.Int, subjectId)],
  );
  return rows.map(toProposalRow);
}

/** The review queue: everything not yet verified or withdrawn, oldest first. */
export async function openProposals(connection: Connection): Promise<ProposalRow[]> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP 200 ${PROPOSAL_COLUMNS} FROM dbo.MyobProposals
      WHERE State IN (N'proposed', N'approved', N'pushed', N'exception') ORDER BY ProposalId ASC`,
  );
  return rows.map(toProposalRow);
}

/** The latest verified record Floorplan holds for a MYOB uid: what Floorplan last saw. */
export async function latestVerifiedForUid(connection: Connection, companyFileId: string, uid: string): Promise<ProposalRow | null> {
  const rows = await executeQuery(
    connection,
    `SELECT TOP 1 ${PROPOSAL_COLUMNS} FROM dbo.MyobProposals
      WHERE CompanyFileId = @CompanyFileId AND MyobUid = @MyobUid AND State = N'verified' ORDER BY ProposalId DESC`,
    [p("CompanyFileId", TYPES.NVarChar, companyFileId), p("MyobUid", TYPES.NVarChar, uid)],
  );
  return rows[0] ? toProposalRow(rows[0]) : null;
}

export interface NewProposal {
  companyFileId: string;
  correlationId: string;
  idempotencyKey: string;
  jobId: number;
  operation: ProposalOperation;
  payload: Record<string, unknown>;
  payloadHash: string;
  proposedAt: Date;
  proposedBy: string;
  proposedByOid: string | null;
  rendered: RenderedProposal;
  subjectId: number;
  subjectType: ProposalRow["subjectType"];
  targetUid: string | null;
}

export async function insertProposal(tx: Connection, row: NewProposal): Promise<ProposalRow> {
  const rows = await executeQuery(
    tx,
    `INSERT INTO dbo.MyobProposals (Operation, SubjectType, SubjectId, JobId, CompanyFileId, TargetUid, Payload, PayloadHash,
       Rendered, IdempotencyKey, ProposedBy, ProposedByOid, ProposedAt, CorrelationId)
     OUTPUT ${INSERTED_PROPOSAL_COLUMNS}
     VALUES (@Operation, @SubjectType, @SubjectId, @JobId, @CompanyFileId, @TargetUid, @Payload, @PayloadHash,
       @Rendered, @IdempotencyKey, @ProposedBy, @ProposedByOid, @ProposedAt, @CorrelationId)`,
    [
      p("Operation", TYPES.NVarChar, row.operation),
      p("SubjectType", TYPES.NVarChar, row.subjectType),
      p("SubjectId", TYPES.Int, row.subjectId),
      p("JobId", TYPES.Int, row.jobId),
      p("CompanyFileId", TYPES.NVarChar, row.companyFileId),
      p("TargetUid", TYPES.NVarChar, row.targetUid),
      p("Payload", TYPES.NVarChar, JSON.stringify(row.payload)),
      p("PayloadHash", TYPES.Char, row.payloadHash),
      p("Rendered", TYPES.NVarChar, JSON.stringify(row.rendered)),
      p("IdempotencyKey", TYPES.Char, row.idempotencyKey),
      p("ProposedBy", TYPES.NVarChar, row.proposedBy.slice(0, 200)),
      p("ProposedByOid", TYPES.NVarChar, row.proposedByOid),
      p("ProposedAt", TYPES.DateTime2, row.proposedAt),
      p("CorrelationId", TYPES.UniqueIdentifier, row.correlationId),
    ],
  );
  return toProposalRow(rows[0]);
}

const TEXT = ["Diff", "MyobError", "MyobNumber", "MyobRowVersion", "MyobSnapshot", "MyobUid", "MyobUrl", "Payload", "ReadBack",
  "Rendered", "ReviewedBy", "ReviewedByOid", "State", "WithdrawnBy", "WithdrawReason"] as const;
const DATES = ["LastReadBackAt", "PushedAt", "ReviewedAt", "WithdrawnAt"] as const;
/** The columns a proposal's later steps may set; nothing else is writable after insert. */
const UPDATABLE = {
  ...Object.fromEntries(TEXT.map((column) => [column, TYPES.NVarChar])),
  ...Object.fromEntries(DATES.map((column) => [column, TYPES.DateTime2])),
  PayloadHash: TYPES.Char,
} as Record<(typeof TEXT)[number] | (typeof DATES)[number] | "PayloadHash", (typeof TYPES)[keyof typeof TYPES]>;

export type ProposalUpdate = Partial<Record<keyof typeof UPDATABLE, unknown>>;

/** Applies `fields` only if the row is still at `rowVersion`; null when someone else got there first. */
export async function updateProposal(tx: Connection, id: number, rowVersion: string, fields: ProposalUpdate): Promise<ProposalRow | null> {
  const update = buildUpdateSet(UPDATABLE, fields);
  if (!update) throw new Error("updateProposal: nothing to update");
  const rows = await executeQuery(
    tx,
    `UPDATE dbo.MyobProposals SET ${update.setClause}
     OUTPUT ${INSERTED_PROPOSAL_COLUMNS}
      WHERE ProposalId = @ProposalId AND RowVersion = @RowVersion`,
    [p("ProposalId", TYPES.Int, id), p("RowVersion", TYPES.Binary, Buffer.from(rowVersion, "base64")), ...update.params],
  );
  return rows[0] ? toProposalRow(rows[0]) : null;
}
