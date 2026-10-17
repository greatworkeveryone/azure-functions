// A rent review's escalations (PLAN §3.4) as the review workflow drives them:
//
//   raiseApprovalEscalation   E3, after SUBMIT commits a review to awaiting_approval
//   settleReviewEscalations   after any review decision commits: every live
//                             escalation on the review whose condition no longer
//                             holds ends with the decision as its code ("commenced",
//                             "approved", "returned", "waived"; a cancelled review's
//                             are withdrawn with the cancel's reason)
//   runReviewEscalations      the generator's step, live runs only: raises E1 and
//                             E2 where their condition holds, raises an E3 a
//                             review waiting for approval has lost (SUBMIT failed
//                             to raise it, or it ended without a decision) at the
//                             rung it had reached, and ends any E3 left behind by
//                             a decision whose after-commit step failed
//
// None of this is part of a decision's transaction: the decision commits first
// and its escalations follow (an escalation that fails to move never undoes a
// rent decision). A failure is logged and sent to Sentry; the next generator run
// and the escalation sweep (which ends attention escalations whose condition has
// cleared) catch up.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery } from "../db";
import { formatDisplayDate } from "../digest/format";
import { concludeForSubject, EscalationError, raise, type EscalationRow } from "../escalation";
import { sweepMaxActions } from "../escalation/config";
import type { LedgerActor } from "../ledger";
import { sqlDateToIso } from "../nextReviewDate";
import { OPEN_RENT_REVIEW_STATES, type RentReviewState } from "../rentReviewMachine";
import { approvalReasonsOf, chosenFigures, isReduction, parseCalc } from "../rentReviewCalc";
import { scheduleSignOffFromRow } from "../scheduleSignOff";
import { Sentry } from "../sentry";
import {
  approvalOutcomeCode,
  GENERATOR_POLICIES,
  type PolicyHistory,
  REVIEW_DECISION_CODES,
  REVIEW_POLICIES,
  reviewConditionActive,
  shouldRaise,
} from "./escalationRules";

export const REVIEW_SUBJECT = "rent_review";

const money = (value: number): string => new Intl.NumberFormat("en-AU", { currency: "AUD", style: "currency" }).format(value);
const signedPercent = (value: number): string => `${value > 0 ? "+" : ""}${(Math.round(value * 100) / 100).toFixed(2)}%`;

const REASON_WORDS: Record<string, string> = {
  basis_departs_from_lease: "terms differ from the lease",
  manual_method: "keyed by hand",
  out_of_band: "outside the usual range",
  override: "a different rent was chosen",
  reduction: "the rent goes down, so a director decides",
};

/** E3's headline: the change and why it needs a second person. */
export function approvalHeadline(change: { appliedPercent: number; currentAnnual: number; newAnnual: number; reasons: readonly string[] }): string {
  const why = change.reasons.map((reason) => REASON_WORDS[reason] ?? reason).join("; ");
  return `Waiting for approval: ${money(change.currentAnnual)} → ${money(change.newAnnual)} (${signedPercent(change.appliedPercent)})${why ? ` — ${why}` : ""}`;
}

function report(what: string, reviewId: string, error: unknown, log?: (message: string) => void): string {
  const message = error instanceof Error ? error.message : String(error);
  log?.(`rentReviewEscalations: ${what} on review ${reviewId} failed: ${message}`);
  Sentry.captureException(error, { extra: { context: `rent review escalation: ${what}`, reviewId } });
  return message;
}

/** A policy switched off or not seeded yet: the review goes on without the escalation. */
const isPolicyOff = (error: unknown): boolean =>
  error instanceof EscalationError && (error.code === "policy_inactive" || error.code === "unknown_policy");

export interface ApprovalEscalationInput {
  /** The preparer: the engine never sends an escalation to whoever raised it. */
  actor: LedgerActor;
  appliedPercent: number;
  currentAnnual: number;
  /** Separation of duties: the preparer, whoever keyed a manual rent, and whoever changed the basis. */
  excludeUserIds: readonly number[];
  log?: (message: string) => void;
  newAnnual: number;
  reasons: readonly string[];
  reviewId: string;
  /** "director" for a rent reduction (A3): straight to the directors. */
  startAtRole?: string | null;
}

/** E3 for a review that SUBMIT just sent to awaiting_approval. Null when it
 *  couldn't be raised (the policy is off, or the write failed). */
export async function raiseApprovalEscalation(connection: Connection, input: ApprovalEscalationInput): Promise<EscalationRow | null> {
  try {
    const { escalation } = await raise(connection, {
      actor: input.actor,
      context: {
        appliedPercent: input.appliedPercent,
        currentAnnual: input.currentAnnual,
        newAnnual: input.newAnnual,
        reasons: [...input.reasons],
      },
      excludeUserIds: input.excludeUserIds,
      headline: approvalHeadline(input),
      policyKey: REVIEW_POLICIES.approval,
      startAtRole: input.startAtRole ?? null,
      subjectId: input.reviewId,
      subjectType: REVIEW_SUBJECT,
    });
    return escalation;
  } catch (error) {
    if (isPolicyOff(error)) {
      input.log?.(`rentReviewEscalations: ${REVIEW_POLICIES.approval} is switched off or missing; review ${input.reviewId} waits without it`);
      return null;
    }
    report("raising E3", input.reviewId, error, input.log);
    return null;
  }
}

export interface SettleInput {
  actor: LedgerActor;
  /** commenced | approved | returned | waived | cancelled */
  code: string;
  log?: (message: string) => void;
  /** The decision's note or reason; a cancelled review's withdrawals carry it. */
  note?: string | null;
  reviewId: string;
  scheduledFor: string;
  /** The review's state now. */
  state: RentReviewState;
  today: string;
}

/** Every live escalation on the review whose condition no longer holds ends
 *  with the decision's code. Never throws; returns how many ended. */
export async function settleReviewEscalations(connection: Connection, input: SettleInput): Promise<number> {
  const facts = { scheduledFor: input.scheduledFor, state: input.state, tenancyClosed: false };
  const known = [...Object.values(REVIEW_POLICIES), "any.manual"];
  const cleared = known.filter((policyKey) => !reviewConditionActive(policyKey, facts, input.today));
  if (cleared.length === 0) return 0;
  try {
    const ended = await concludeForSubject(connection, {
      actor: input.actor,
      code: input.code,
      note: input.note ?? null,
      policyKeys: cleared,
      subjectId: input.reviewId,
      subjectType: REVIEW_SUBJECT,
      withdrawOpen: input.code === REVIEW_DECISION_CODES.cancelled,
    });
    return ended.length;
  } catch (error) {
    report(`ending escalations (${input.code})`, input.reviewId, error, input.log);
    return 0;
  }
}

// ── The generator's step ─────────────────────────────────────────────────────

const OPEN_STATE_LIST = OPEN_RENT_REVIEW_STATES.map((state) => `'${state}'`).join(", ");

const OPEN_REVIEWS_SQL = `SELECT r.ReviewId, r.ScheduledFor, r.State, r.PreparedById, r.SubmittedAt, r.Calc, r.ExpectedIndexAt,
    t.Status AS TenantStatus, t.ArchivedAt AS TenantArchivedAt, t.ScheduleSignedOffAt
  FROM dbo.RentReviews r
  INNER JOIN dbo.Tenants t ON t.TenantId = r.TenantId
  WHERE r.State IN (${OPEN_STATE_LIST})`;

const HISTORY_SQL = `SELECT e.EscalationId, e.SubjectId, e.PolicyKey, e.Status, e.ResolutionCode, e.CreatedAt,
    e.TargetRole, e.NoIndependentTarget
  FROM dbo.Escalations e
  WHERE e.SubjectType = N'rent_review'
    AND e.PolicyKey IN (@NotCommenced, @Overdue, @Approval)
    AND e.SubjectId IN (SELECT r.ReviewId FROM dbo.RentReviews r WHERE r.State IN (${OPEN_STATE_LIST}))`;

const STRANDED_APPROVALS_SQL = `SELECT e.SubjectId, r.State, r.ScheduledFor
  FROM dbo.Escalations e
  LEFT JOIN dbo.RentReviews r ON r.ReviewId = e.SubjectId
  WHERE e.SubjectType = N'rent_review' AND e.PolicyKey = @Approval
    AND e.Status IN ('open', 'acknowledged')
    AND (r.State IS NULL OR r.State <> 'awaiting_approval')`;

export interface OpenReviewFacts {
  calc: ReturnType<typeof parseCalc>;
  expectedIndexAt?: string | null;
  preparedById: number | null;
  reviewId: string;
  scheduledFor: string;
  signedOff?: boolean;
  state: RentReviewState;
  submittedAt: Date | null;
  tenancyClosed: boolean;
}

export type EscalationAction =
  | { kind: "raise"; policyKey: string; review: OpenReviewFacts; startAtRole: string | null }
  | { code: string; kind: "end"; reviewId: string; scheduledFor: string; state: RentReviewState };

/** What the generator's step should do. Pure. */
export function planReviewEscalations(
  reviews: readonly OpenReviewFacts[],
  history: ReadonlyMap<string, PolicyHistory>,
  stranded: ReadonlyArray<{ reviewId: string; scheduledFor: string; state: RentReviewState | null }>,
  today: string,
): EscalationAction[] {
  const actions: EscalationAction[] = [];
  for (const review of reviews) {
    for (const policyKey of [...GENERATOR_POLICIES, REVIEW_POLICIES.approval]) {
      const last = history.get(historyKey(review.reviewId, policyKey)) ?? null;
      if (shouldRaise(policyKey, review, last, today)) {
        actions.push({ kind: "raise", policyKey, review, startAtRole: policyKey === REVIEW_POLICIES.approval ? approvalStart(review, last) : null });
      }
    }
  }
  for (const left of stranded) {
    const state = left.state ?? "cancelled";
    const code = approvalOutcomeCode(state);
    if (code) actions.push({ code, kind: "end", reviewId: left.reviewId, scheduledFor: left.scheduledFor, state });
  }
  return actions;
}

export const historyKey = (reviewId: string, policyKey: string): string => `${reviewId}\u0000${policyKey}`;

/** Where a missing E3 starts again (L3): the directors for a lower rent (A3),
 *  else the rung the review's E3 had reached since it was submitted; the bottom
 *  when it never went past the first rung. */
function approvalStart(review: OpenReviewFacts, last: PolicyHistory | null): string | null {
  if (review.calc && isReduction(review.calc)) return "director";
  const reached = last?.reachedRole ?? null;
  return reached === null || reached === "accounts_manager" ? null : reached;
}

export interface SeparationFacts {
  /** Whoever changed the review's basis since it was commenced (M3). */
  basisEditorIds?: readonly number[];
  calc: ReturnType<typeof parseCalc>;
  preparedById: number | null;
}

/** Who had a hand in preparing a review (C6): its preparer, whoever keyed a manual
 *  rent, and whoever changed its basis since it was commenced. */
export function dutiesOf(review: SeparationFacts): { basisEditors: number[]; keyedBy: number | null; preparedBy: number | null } {
  const keyedBy = review.calc?.manual ? review.calc.computedBy?.userId : null;
  return {
    basisEditors: [...new Set(review.basisEditorIds ?? [])],
    keyedBy: typeof keyedBy === "number" ? keyedBy : null,
    preparedBy: review.preparedById,
  };
}

/** The people a review's E3 is not sent to and who may not approve it, directors
 *  aside (sprint decision 17): everyone dutiesOf names. */
export function separationOfDuties(review: SeparationFacts): number[] {
  const duties = dutiesOf(review);
  const ids = new Set<number>(duties.basisEditors);
  if (duties.preparedBy !== null) ids.add(duties.preparedBy);
  if (duties.keyedBy !== null) ids.add(duties.keyedBy);
  return [...ids].sort((a, b) => a - b);
}

const BASIS_EDITORS_SQL = `SELECT DISTINCT l.ActorUserId
  FROM dbo.DecisionLedger l
  WHERE l.SubjectType = N'rent_review' AND l.SubjectId = @ReviewId
    AND l.Action = N'rent_review.basis_update' AND l.ActorUserId IS NOT NULL
    AND l.LedgerId > COALESCE((
      SELECT MAX(c.LedgerId) FROM dbo.DecisionLedger c
      WHERE c.SubjectType = N'rent_review' AND c.SubjectId = @ReviewId AND c.Action = N'rent_review.commence'), 0)`;

/** Whoever changed the review's basis since it was last commenced, from the ledger
 *  (rent_review.basis_update rows; IX_DecisionLedger_Subject serves it). */
export async function basisEditorsSinceCommence(connection: Connection, reviewId: string): Promise<number[]> {
  const rows = await executeQuery(connection, BASIS_EDITORS_SQL, [{ name: "ReviewId", type: TYPES.NVarChar, value: reviewId }]);
  return rows.map((row) => Number(row.ActorUserId)).filter((id) => Number.isInteger(id));
}

function headlineFor(action: Extract<EscalationAction, { kind: "raise" }>, today: string): string {
  const due = formatDisplayDate(action.review.scheduledFor);
  if (action.policyKey === REVIEW_POLICIES.notCommenced) {
    return action.review.scheduledFor < today ? `Not started: the review was due ${due}` : `Not started: the review is due ${due}`;
  }
  if (action.policyKey === REVIEW_POLICIES.overdue) return `Overdue: the review was due ${due}`;
  const calc = action.review.calc;
  // The override's own % with the override's rent (L8), and why it waits.
  return calc ? approvalHeadline({ ...chosenFigures(calc), reasons: approvalReasonsOf(calc) }) : "Waiting for approval";
}

export interface ReviewEscalationRun {
  actor: LedgerActor;
  dryRun: boolean;
  env?: NodeJS.ProcessEnv;
  log: (message: string) => void;
  now?: Date;
  today: string;
  warn: (message: string) => void;
}

export interface ReviewEscalationReport {
  ended: number;
  errors: Array<{ message: string; reviewId: string }>;
  raised: number;
  /** The run stopped at ESCALATION_SWEEP_MAX_ACTIONS; the rest waits for the next run. */
  truncated: boolean;
}

const dateOf = (value: unknown): Date | null => (value instanceof Date && !Number.isNaN(value.getTime()) ? value : null);

/** The generator's escalation step. In a dry run it reads, logs what it would
 *  do, counts it, and writes nothing. */
export async function runReviewEscalations(connection: Connection, run: ReviewEscalationRun): Promise<ReviewEscalationReport> {
  const reviews: OpenReviewFacts[] = (await executeQuery(connection, OPEN_REVIEWS_SQL)).map((row) => ({
    calc: parseCalc(row.Calc),
    expectedIndexAt: sqlDateToIso(row.ExpectedIndexAt),
    preparedById: row.PreparedById === null || row.PreparedById === undefined ? null : Number(row.PreparedById),
    reviewId: String(row.ReviewId),
    scheduledFor: sqlDateToIso(row.ScheduledFor) ?? "",
    signedOff: scheduleSignOffFromRow(row) !== null,
    state: row.State as RentReviewState,
    submittedAt: dateOf(row.SubmittedAt),
    tenancyClosed: row.TenantStatus === "vacated" || (row.TenantArchivedAt !== null && row.TenantArchivedAt !== undefined),
  }));
  const policyParams = [
    { name: "Approval", type: TYPES.NVarChar, value: REVIEW_POLICIES.approval },
    { name: "NotCommenced", type: TYPES.NVarChar, value: REVIEW_POLICIES.notCommenced },
    { name: "Overdue", type: TYPES.NVarChar, value: REVIEW_POLICIES.overdue },
  ];
  const submittedAt = new Map(reviews.map((review) => [review.reviewId, review.submittedAt]));
  const history = new Map<string, PolicyHistory & { escalationId: number }>();
  for (const row of await executeQuery(connection, HISTORY_SQL, policyParams)) {
    const key = historyKey(String(row.SubjectId), String(row.PolicyKey));
    const escalationId = Number(row.EscalationId);
    const createdAt = dateOf(row.CreatedAt) ?? new Date(0);
    const seen = history.get(key);
    // E3: the highest rung reached since the review was last submitted, whatever became of it.
    const since = submittedAt.get(String(row.SubjectId)) ?? null;
    const counts = row.PolicyKey === REVIEW_POLICIES.approval && (since === null || createdAt.getTime() >= since.getTime());
    const reachedRole = counts ? higherRung(seen?.reachedRole ?? null, rungOf(row)) : (seen?.reachedRole ?? null);
    if (seen && seen.escalationId > escalationId) {
      seen.reachedRole = reachedRole;
      continue;
    }
    history.set(key, {
      createdAt,
      escalationId,
      live: row.Status === "open" || row.Status === "acknowledged",
      reachedRole,
      resolutionCode: typeof row.ResolutionCode === "string" ? row.ResolutionCode : null,
    });
  }
  const stranded = (await executeQuery(connection, STRANDED_APPROVALS_SQL, [policyParams[0]])).map((row) => ({
    reviewId: String(row.SubjectId),
    scheduledFor: sqlDateToIso(row.ScheduledFor) ?? "",
    state: (row.State ?? null) as RentReviewState | null,
  }));

  const actions = planReviewEscalations(reviews, history, stranded, run.today);
  const result: ReviewEscalationReport = { ended: 0, errors: [], raised: 0, truncated: false };
  let left = sweepMaxActions(run.env ?? process.env);

  for (const action of actions) {
    if (left <= 0) {
      result.truncated = true;
      break;
    }
    left -= 1;
    const reviewId = action.kind === "raise" ? action.review.reviewId : action.reviewId;
    if (run.dryRun) {
      run.log(
        action.kind === "raise"
          ? `rentReviewEscalations: would raise ${action.policyKey} on review ${reviewId}`
          : `rentReviewEscalations: would end ${REVIEW_POLICIES.approval} on review ${reviewId} (${action.code})`,
      );
      if (action.kind === "raise") result.raised += 1;
      else result.ended += 1;
      continue;
    }
    try {
      if (action.kind === "raise") {
        const outcome = await raise(connection, {
          actor: run.actor,
          context: { rule: action.policyKey, scheduledFor: action.review.scheduledFor },
          excludeUserIds:
            action.policyKey === REVIEW_POLICIES.approval
              ? separationOfDuties({ ...action.review, basisEditorIds: await basisEditorsSinceCommence(connection, reviewId) })
              : undefined,
          headline: headlineFor(action, run.today),
          now: run.now,
          policyKey: action.policyKey,
          skipConditionCheck: true,
          startAtRole: action.startAtRole,
          subjectId: reviewId,
          subjectType: REVIEW_SUBJECT,
        });
        if (outcome.created) result.raised += 1;
      } else {
        const ended = await concludeForSubject(connection, {
          actor: run.actor,
          code: action.code,
          note: action.code === REVIEW_DECISION_CODES.cancelled ? "The review was cancelled" : null,
          now: run.now,
          policyKeys: [REVIEW_POLICIES.approval],
          subjectId: reviewId,
          subjectType: REVIEW_SUBJECT,
          withdrawOpen: action.code === REVIEW_DECISION_CODES.cancelled,
        });
        result.ended += ended.length;
      }
    } catch (error) {
      if (isPolicyOff(error)) {
        run.log(`rentReviewEscalations: ${action.kind === "raise" ? action.policyKey : "a policy"} is switched off or missing; skipped`);
        continue;
      }
      const message = error instanceof Error ? error.message : String(error);
      result.errors.push({ message, reviewId });
      run.warn(`rentReviewEscalations: review ${reviewId} failed: ${message}`);
    }
  }
  run.log(
    `rentReviewEscalations: ${run.dryRun ? "dry run, nothing written. Would raise" : "raised"} ${result.raised}, ` +
      `${run.dryRun ? "would end" : "ended"} ${result.ended}, ${result.errors.length} failed` +
      (result.truncated ? " (stopped at ESCALATION_SWEEP_MAX_ACTIONS; the rest waits for the next run)" : ""),
  );
  return result;
}

// ── The rung an E3 stands at (the generator; C7 reads it in SQL) ─────────────

const APPROVAL_RUNGS = ["accounts_manager", "cfo", "director"] as const;

/** The rung one E3 row stands at: the directors when nobody independent was left;
 *  an unknown role counts as the directors. */
export function rungOf(row: { NoIndependentTarget?: unknown; TargetRole?: unknown }): string {
  if (row.NoIndependentTarget === true || row.NoIndependentTarget === 1) return "director";
  const role = typeof row.TargetRole === "string" ? row.TargetRole.trim().toLowerCase() : "";
  return (APPROVAL_RUNGS as readonly string[]).includes(role) ? role : "director";
}

/** The higher of two rungs. */
export const higherRung = (a: string | null, b: string): string =>
  a !== null && APPROVAL_RUNGS.indexOf(a as (typeof APPROVAL_RUNGS)[number]) >= APPROVAL_RUNGS.indexOf(b as (typeof APPROVAL_RUNGS)[number]) ? a : b;
