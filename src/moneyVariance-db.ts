// R13 in the handlers (LAUNCH-READINESS R13, PLAN D6): the DB half of the
// variance margin. moneyRules.varianceDecision decides; this loads what it
// decides on (the original approved amount, what was accepted before, the
// margin, the named manager) and records an accepted variance: a
// dbo.MoneyVariances row (migration 117) and its ledger row, in the caller's
// transaction. The named manager's notice is raised after commit
// (approvalAttribution.ts).
//
// The original approved amount is the job's approved quote: a purchase order
// and an incoming invoice both rest on it (a PO's own approval gate is WP21's).
// A job with none (a standing contract) has nothing to measure against.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { loadApprovalFacts, loadNamedUser, loadVarianceFacts } from "./approvalAuthority-db";
import { executeQuery } from "./db";
import { record } from "./ledger";
import type { LedgerScope } from "./ledger/moneyDecisions";
import type { LedgerActor } from "./ledger/types";
import { type MoneyRefusal, type VarianceDecision, type VarianceRequest, varianceDecision } from "./moneyRules";

export type VarianceSubject = "invoice" | "purchase_order";

/** body.variance as sent: { attributedToUserId?, rationale?, directorOverrideReason? }. */
export interface VarianceBody {
  attributedToUserId?: unknown;
  directorOverrideReason?: unknown;
  rationale?: unknown;
}

const RATIONALE_MAX = 1000;

/** A malformed body.variance is a 400 with this sentence; absent is no variance sent. */
export function readVarianceBody(raw: unknown): { ok: true; value: VarianceBody | null } | { error: string; ok: false } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "object" || Array.isArray(raw)) return { error: "variance must be { attributedToUserId, rationale }", ok: false };
  const body = raw as VarianceBody;
  const id = body.attributedToUserId;
  if (id !== undefined && id !== null && (typeof id !== "number" || !Number.isInteger(id) || id <= 0)) {
    return { error: "variance.attributedToUserId must be a user id", ok: false };
  }
  for (const key of ["rationale", "directorOverrideReason"] as const) {
    const text = body[key];
    if (text !== undefined && text !== null && (typeof text !== "string" || text.length > RATIONALE_MAX)) {
      return { error: `variance.${key} must be text of ${RATIONALE_MAX} characters or fewer`, ok: false };
    }
  }
  return { ok: true, value: body };
}

// An accepted rise counts only against the quote it was measured from (review
// 117, B6): once that quote is deselected and another approved, it covers
// nothing. A disputed rise never counts (B7).
const ACCEPTED_FOR_PO_SQL = `SELECT MAX(NewAmount) AS Accepted FROM dbo.MoneyVariances
  WHERE SubjectType = N'purchase_order' AND SubjectID = @Id AND QuoteID = @QuoteID AND ISNULL(Disputed, 0) = 0`;
const ACCEPTED_FOR_JOB_SQL = `SELECT MAX(NewAmount) AS Accepted FROM dbo.MoneyVariances
  WHERE JobID = @Id AND QuoteID = @QuoteID AND ISNULL(Disputed, 0) = 0`;
const APPROVED_QUOTE_SQL = `SELECT q.Amount, q.QuoteID FROM Jobs j INNER JOIN Quotes q ON q.QuoteID = j.ApprovedQuoteID WHERE j.JobID = @JobID`;

/** The highest undisputed amount accepted within the margin: for one purchase order, or anywhere on the job. */
export async function acceptedVarianceAmount(
  connection: Connection,
  where: { jobId: number } | { purchaseOrderId: number },
  quoteId: number | null,
): Promise<number | null> {
  if (quoteId === null) return null;
  const byPo = "purchaseOrderId" in where;
  const rows = await executeQuery(connection, byPo ? ACCEPTED_FOR_PO_SQL : ACCEPTED_FOR_JOB_SQL, [
    { name: "Id", type: TYPES.Int, value: byPo ? where.purchaseOrderId : where.jobId },
    { name: "QuoteID", type: TYPES.Int, value: quoteId },
  ]);
  const value = rows[0]?.Accepted;
  return value === null || value === undefined ? null : Number(value);
}

export interface VarianceCheckInput {
  /** Where earlier accepted amounts are looked up. */
  accepted: { jobId: number } | { purchaseOrderId: number };
  body: VarianceBody | null;
  buildingId: number | null;
  editor: { email?: string; roles: string[]; userId?: number };
  jobId: number;
  newAmount: number | null;
  subject: VarianceSubject;
}

export interface VarianceCheck {
  decision: VarianceDecision;
  originalAmount: number | null;
  /** The job's approved quote the rise was measured against (MoneyVariances.QuoteID). */
  quoteId: number | null;
}

/** The job's approved quote: its amount (null when unknown) and id. */
export async function approvedQuoteOf(connection: Connection, jobId: number): Promise<{ amount: number | null; quoteId: number | null }> {
  const row = (await executeQuery(connection, APPROVED_QUOTE_SQL, [{ name: "JobID", type: TYPES.Int, value: jobId }]))[0];
  if (!row) return { amount: null, quoteId: null };
  return {
    amount: row.Amount === null || row.Amount === undefined ? null : Number(row.Amount),
    quoteId: typeof row.QuoteID === "number" ? row.QuoteID : null,
  };
}

/** Loads the facts and decides. Reads the margin and the named manager only when the amount has risen past what was approved. */
export async function checkVariance(connection: Connection, input: VarianceCheckInput): Promise<VarianceCheck> {
  const { amount: originalAmount, quoteId } = await approvedQuoteOf(connection, input.jobId);
  if (originalAmount === null) return { decision: { kind: "no_variance" }, originalAmount, quoteId };
  const next = input.newAmount;
  if (typeof next === "number" && Number.isFinite(next) && Math.round(next * 100) <= Math.round(originalAmount * 100)) {
    return { decision: { kind: "no_variance" }, originalAmount, quoteId };
  }

  const acceptedAmount = await acceptedVarianceAmount(connection, input.accepted, quoteId);
  const request: VarianceRequest = {
    directorOverride: typeof input.body?.directorOverrideReason === "string" ? { reason: input.body.directorOverrideReason } : null,
    rationale: typeof input.body?.rationale === "string" ? input.body.rationale : null,
  };
  const namedId = input.body?.attributedToUserId;
  if (typeof namedId === "number") {
    const named = await loadNamedUser(connection, namedId);
    // Someone who isn't an active user is named with no roles: the rule refuses them.
    request.attributedTo = named
      ? { displayName: named.displayName, email: named.email, roles: named.roles, userId: named.userId }
      : { roles: [], userId: namedId };
  }
  const [facts, authority] = await Promise.all([loadVarianceFacts(connection), loadApprovalFacts(connection, input.buildingId)]);
  const decision = varianceDecision(
    { acceptedAmount, buildingId: input.buildingId ?? 0, editor: input.editor, newAmount: next, originalAmount, request, subject: input.subject },
    facts,
    authority,
  );
  return { decision, originalAmount, quoteId };
}

export interface RecordVarianceInput {
  actor: LedgerActor;
  /** The record's money facts (purchaseOrderFacts / invoiceFacts), for the ledger row's shape. */
  after: Record<string, unknown>;
  before: Record<string, unknown>;
  correlationId?: string;
  decision: Extract<VarianceDecision, { kind: "director_override" | "within_tolerance" }>;
  jobId: number;
  previousAmount: number | null;
  /** The approved quote the rise was measured against (VarianceCheck.quoteId). */
  quoteId: number | null;
  scope: LedgerScope;
  subject: { id: number; type: VarianceSubject };
}

/** The variance accepted (or overridden), as the notice and the ledger name it. */
export interface RecordedVariance {
  attributedToUserId: number | null;
  varianceId: number;
}

/**
 * Writes the dbo.MoneyVariances row and its ledger row on the caller's open
 * transaction: po.variance_within_tolerance (the editor as actor, the manager
 * as attributedTo, the rationale as reason) or po.variance_director_override
 * (an exception, with the refusal it overrode).
 */
export async function recordVariance(connection: Connection, input: RecordVarianceInput): Promise<RecordedVariance> {
  const { decision } = input;
  const figures = decision.figures;
  if (!figures) throw new Error("A variance is recorded only with its figures");
  const editorName = input.actor.name;
  const editorUserId = input.actor.kind === "user" ? input.actor.userId : null;
  const within = decision.kind === "within_tolerance";
  const named = within ? decision.attributedTo : null;
  // A director's override names nobody else: the row carries the director.
  const attributedName = named ? (named.displayName?.trim() || named.email || `User ${named.userId}`) : editorName;
  const attributedUserId = named ? (named.userId ?? null) : null;
  const rationale = within ? decision.rationale : decision.reason;

  const inserted = await executeQuery(
    connection,
    `INSERT INTO dbo.MoneyVariances
       (SubjectType, SubjectID, JobID, OriginalAmount, PreviousAmount, NewAmount, DeltaAmount, DeltaPercent,
        Rationale, EditorUserID, EditorName, AttributedToUserID, AttributedToName, DirectorOverride, QuoteID)
     OUTPUT INSERTED.VarianceID
     VALUES (@SubjectType, @SubjectID, @JobID, @OriginalAmount, @PreviousAmount, @NewAmount, @DeltaAmount, @DeltaPercent,
        @Rationale, @EditorUserID, @EditorName, @AttributedToUserID, @AttributedToName, @DirectorOverride, @QuoteID);`,
    [
      { name: "SubjectType", type: TYPES.NVarChar, value: input.subject.type },
      { name: "SubjectID", type: TYPES.Int, value: input.subject.id },
      { name: "JobID", type: TYPES.Int, value: input.jobId },
      { name: "OriginalAmount", options: { precision: 18, scale: 2 }, type: TYPES.Decimal, value: figures.originalAmount },
      { name: "PreviousAmount", options: { precision: 18, scale: 2 }, type: TYPES.Decimal, value: input.previousAmount },
      { name: "NewAmount", options: { precision: 18, scale: 2 }, type: TYPES.Decimal, value: figures.newAmount },
      { name: "DeltaAmount", options: { precision: 18, scale: 2 }, type: TYPES.Decimal, value: figures.deltaAmount },
      { name: "DeltaPercent", options: { precision: 9, scale: 2 }, type: TYPES.Decimal, value: figures.deltaPercent },
      { name: "Rationale", type: TYPES.NVarChar, value: rationale },
      { name: "EditorUserID", type: TYPES.Int, value: editorUserId },
      { name: "EditorName", type: TYPES.NVarChar, value: editorName },
      { name: "AttributedToUserID", type: TYPES.Int, value: attributedUserId },
      { name: "AttributedToName", type: TYPES.NVarChar, value: attributedName },
      { name: "DirectorOverride", type: TYPES.Bit, value: !within },
      { name: "QuoteID", type: TYPES.Int, value: input.quoteId },
    ],
  );
  const varianceId = Number(inserted[0]?.VarianceID);

  const change = {
    allowance: figures.allowance,
    amount: figures.newAmount,
    delta: figures.deltaAmount,
    deltaPercent: figures.deltaPercent,
    newAmount: figures.newAmount,
    originalApprovedAmount: figures.originalAmount,
    previousAmount: input.previousAmount,
    quoteId: input.quoteId,
    varianceId,
  };
  await record(connection, {
    action: within ? "po.variance_within_tolerance" : "po.variance_director_override",
    actor: input.actor,
    after: { ...input.after, ...change },
    attributedTo: named ? { name: attributedName, role: named.roles[0] ?? "", userId: attributedUserId } : undefined,
    before: input.before,
    buildingId: input.scope.buildingId,
    computed: within ? undefined : { refused: decision.overridden.code, sentence: decision.overridden.message },
    correlationId: input.correlationId,
    jobId: input.scope.jobId,
    reason: rationale,
    ruleApplied: within ? "within_margin" : decision.overridden.code,
    subject: input.subject,
  });
  return { attributedToUserId: attributedUserId, varianceId };
}

/** The refusal of a decision that refused, for refuseMoneyChange. */
export function varianceRefusal(decision: VarianceDecision): MoneyRefusal | null {
  return decision.kind === "refused" ? decision.refusal : null;
}
