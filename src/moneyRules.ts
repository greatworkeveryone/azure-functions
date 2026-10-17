// Money-record rules shared by the quote, invoice, purchase-order and payment
// handlers (beta sprint J3, WP42b), and R13's variance margin. Pure: each takes what the handler already
// loaded and says whether to refuse, with the code the ledger records, the
// sentence the person sees and the HTTP status.

import { canApprove, decideAuthority, type AuthorityFacts, type Identity } from "./approvalAuthority";

export interface MoneyRefusal {
  code: string;
  message: string;
  status: 403 | 409 | 422;
}

export type MoneySubject = "quote" | "invoice" | "purchase_order";

const WORDS: Record<MoneySubject, string> = {
  invoice: "invoice",
  purchase_order: "purchase order",
  quote: "quote",
};

function refuse(code: string, message: string, status: MoneyRefusal["status"]): MoneyRefusal {
  return { code, message, status };
}

/**
 * The job a money record belongs to must accept money changes: internal jobs
 * have no quotes, POs or invoices; a done job is reopened first (J2's
 * reopenJob); an archived job is restored first. Decision 18: an outgoing
 * (on-charge) invoice may still be raised and worked on after the job is done;
 * contractor-side quotes, POs and incoming invoices need the reopen.
 */
export function jobMoneyRefusal(
  job: { isArchived?: unknown; isInternal?: unknown; status?: unknown },
  options: { outgoingInvoice?: boolean } = {},
): MoneyRefusal | null {
  if (job.isInternal === true || job.isInternal === 1) {
    return refuse("internal_job", "Internal jobs have no quotes, purchase orders or invoices.", 422);
  }
  if (job.status === "Done" && !options.outgoingInvoice) {
    return refuse("job_done", "This job is done. A manager can reopen it before its quotes, purchase orders or invoices change.", 409);
  }
  if (job.isArchived === true || job.isArchived === 1) {
    return refuse("job_archived", "This job is archived. Restore it before its quotes, purchase orders or invoices change.", 409);
  }
  return null;
}

/**
 * An amount must be a number above $0. `required` is for creating a record;
 * on an edit, leaving the field out is no change, but clearing it is refused.
 */
export function amountRefusal(value: unknown, label: string, required: boolean): MoneyRefusal | null {
  if (value === undefined && !required) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    return refuse("amount_invalid", `${label} is required and must be more than $0.`, 422);
  }
  return null;
}

/**
 * A purchase order's cost: a cap or an estimate above $0 is required when it
 * is raised, and any cost sent (on create or edit) must be above $0.
 */
export function purchaseOrderCostRefusal(estimated: unknown, cap: unknown, required: boolean): MoneyRefusal | null {
  const sent = [estimated, cap].filter((value) => value !== undefined);
  const bad = sent.some((value) => typeof value !== "number" || !Number.isFinite(value) || value <= 0);
  if (bad || (required && sent.length === 0)) {
    return refuse("amount_invalid", "A purchase order needs a cost cap or an estimated cost, and every cost must be more than $0.", 422);
  }
  return null;
}

/** A PO rests on an approved quote, except on a standing-contract job. */
export function purchaseOrderQuoteRefusal(job: { hasApprovedQuote: boolean; isContract: boolean }): MoneyRefusal | null {
  return job.isContract || job.hasApprovedQuote
    ? null
    : refuse("quote_not_approved", "Approve the quote before raising or sending a purchase order (the approval applies the spending limit).", 422);
}

function nameKey(name: unknown): string {
  return typeof name === "string" ? name.trim().toLowerCase() : "";
}

/** Two stored display names are the same person (names are all these tables keep). */
export function samePerson(left: unknown, right: unknown): boolean {
  const key = nameKey(left);
  return key !== "" && key === nameKey(right);
}

/**
 * Whoever added a quote or invoice doesn't approve it. Decision 17: a director
 * is never blocked by separation of duties, so a director may approve what
 * they added (and give the director approval after their own first approval).
 */
export function creatorRefusal(
  createdBy: unknown,
  approver: { name: string; roles: readonly string[] },
  subject: MoneySubject,
): MoneyRefusal | null {
  if (approver.roles.some((role) => role.trim().toLowerCase() === "director")) return null;
  return samePerson(createdBy, approver.name)
    ? refuse("creator", `You added this ${WORDS[subject]}, so someone else has to approve it.`, 403)
    : null;
}

/** Statuses a quote or invoice can be approved from: anything else is stale or already decided. */
const APPROVABLE = new Set(["pending", "awaiting_approval"]);

export function approvableRefusal(status: unknown, subject: MoneySubject): MoneyRefusal | null {
  if (typeof status === "string" && APPROVABLE.has(status)) return null;
  const now = typeof status === "string" && status !== "" ? status.replace(/_/g, " ") : "in another state";
  return refuse("not_approvable", `This ${WORDS[subject]} is ${now}, so it can't be approved now. Reload to see where it stands.`, 409);
}

/**
 * Beta sprint decision 4: admin approves, pays and marks in MYOB only on
 * records flagged as test data. Applies to a caller whose only working role
 * is admin; production gives each person one role.
 */
export function adminRefusal(roles: readonly string[], isTestRecord: boolean): MoneyRefusal | null {
  const keys = roles.map((role) => role.trim().toLowerCase());
  const adminOnly = keys.includes("admin") && keys.every((role) => role === "admin" || role === "user");
  return adminOnly && !isTestRecord
    ? refuse("admin_test_records_only", "Admin can do this on test records only.", 403)
    : null;
}

/** True when the caller holds admin (so the handler checks whether the record is test data). */
export function holdsAdmin(roles: readonly string[]): boolean {
  return roles.some((role) => role.trim().toLowerCase() === "admin");
}

/** A refusal as the HTTP answer: the code the ledger records and the sentence people see. */
export function refusalResponse(refusal: MoneyRefusal): { jsonBody: { code: string; error: string }; status: number } {
  return { jsonBody: { code: refusal.code, error: refusal.message }, status: refusal.status };
}

// ── R13: amount variance within a margin (Connor, 13 Oct 2026) ──────────────

/** The Admin-editable margin (ApprovalFacts): the smaller of `marginPercent` of
 *  the original approved amount and `capDollars`. */
export interface VarianceFacts {
  capDollars: number;
  marginPercent: number;
}

export const DEFAULT_VARIANCE_FACTS: VarianceFacts = Object.freeze({ capDollars: 1000, marginPercent: 10 });

export type VariancePerson = Identity & { displayName?: string };

/** What the editor sent with the change. */
export interface VarianceRequest {
  attributedTo?: VariancePerson | null;
  /** Decision 17: a director overrides the check with a reason, ledgered as an exception. */
  directorOverride?: { reason: string } | null;
  rationale?: string | null;
}

export interface VarianceInput {
  /** The highest amount already accepted within the margin for this record (undisputed), if any. */
  acceptedAmount?: number | null;
  buildingId: number;
  editor: Identity;
  newAmount: number | null;
  /** The originally approved amount; null when there is none (a contract job). */
  originalAmount: number | null;
  request: VarianceRequest;
  subject: "invoice" | "purchase_order";
}

export interface VarianceFigures {
  allowance: number;
  deltaAmount: number;
  deltaPercent: number;
  newAmount: number;
  originalAmount: number;
}

export type VarianceDecision =
  | { kind: "no_variance" }
  | { attributedTo: VariancePerson; figures: VarianceFigures; kind: "within_tolerance"; rationale: string }
  | { figures: VarianceFigures | null; kind: "director_override"; overridden: MoneyRefusal; reason: string }
  | { figures: VarianceFigures | null; kind: "refused"; refusal: MoneyRefusal };

const cents = (dollars: number): number => Math.round(dollars * 100);

/** $1,240 or $1,240.50: Australian grouping, cents only when there are some. */
export function formatDollars(amount: number): string {
  const whole = cents(amount) % 100 === 0;
  return `$${amount.toLocaleString("en-AU", { maximumFractionDigits: whole ? 0 : 2, minimumFractionDigits: whole ? 0 : 2 })}`;
}

function formatPercent(percent: number): string {
  return `${Math.round(percent * 10) / 10}%`;
}

function withoutAdmin(person: VariancePerson): VariancePerson {
  const roles = Array.isArray(person.roles) ? person.roles.filter((role) => role.trim().toLowerCase() !== "admin") : [];
  return { ...person, roles };
}

function samePersonIdentity(left: Identity, right: Identity): boolean {
  if (typeof left.userId === "number" && left.userId === right.userId) return true;
  const email = (left.email ?? "").trim().toLowerCase();
  return email !== "" && email === (right.email ?? "").trim().toLowerCase();
}

/** The lowest approval threshold (a role's row or the director gate) that `from` is at or under and `to` is over. */
function crossedThreshold(from: number, to: number, authority: AuthorityFacts): { amount: number; director: boolean } | null {
  const director = decideAuthority({ amount: 0, buildingId: 0, subject: "quote" }, authority).effectiveDirectorThreshold;
  if (director !== null && cents(from) <= cents(director) && cents(to) > cents(director)) return { amount: director, director: true };
  const crossed = authority.limits
    .filter((row) => row.role.trim().toLowerCase() !== "director" && typeof row.limit === "number" && Number.isFinite(row.limit))
    .map((row) => row.limit as number)
    .filter((limit) => cents(from) <= cents(limit) && cents(to) > cents(limit))
    .sort((a, b) => a - b);
  return crossed.length > 0 ? { amount: crossed[0], director: false } : null;
}

/**
 * R13 (LAUNCH-READINESS, PLAN D6). A rise in a purchase order's or incoming
 * invoice's amount stays approved when, measured cumulatively against the
 * ORIGINAL approved amount:
 *  - the rise is within the smaller of marginPercent of that amount and capDollars;
 *  - the new total crosses no approval threshold (a role's ApprovalLimits row,
 *    which includes the original approver's limit, or the director gate);
 *  - a rationale is given; and
 *  - a named manager, who is not the editor, could approve the new total on
 *    their own authority (canApprove, basis own_authority; admin counts for
 *    nothing here, decision 4).
 * Decreases, and amounts up to one already accepted, need nothing. With no
 * original amount there is nothing to measure against. An unknown new amount is
 * refused, never read as $0. A director may override any refusal with a reason
 * (decision 17); the refusal overridden is returned for the ledger.
 */
export function varianceDecision(input: VarianceInput, facts: VarianceFacts, authority: AuthorityFacts): VarianceDecision {
  const original = input.originalAmount;
  if (typeof original !== "number" || !Number.isFinite(original) || original <= 0) return { kind: "no_variance" };

  const decided = decideVariance(input, original, facts, authority);
  if (decided.kind !== "refused") return decided;
  const reason = input.request.directorOverride?.reason?.trim() ?? "";
  const isDirector = (input.editor.roles ?? []).some((role) => role.trim().toLowerCase() === "director");
  return isDirector && reason !== ""
    ? { figures: decided.figures, kind: "director_override", overridden: decided.refusal, reason }
    : decided;
}

function decideVariance(input: VarianceInput, original: number, facts: VarianceFacts, authority: AuthorityFacts): VarianceDecision {
  const word = input.subject === "invoice" ? "invoice" : "purchase order";
  const next = input.newAmount;
  if (typeof next !== "number" || !Number.isFinite(next) || next < 0) {
    return {
      figures: null,
      kind: "refused",
      refusal: refuse("variance_amount_unknown", `This ${word} has no amount, so it can't be checked against the approved ${formatDollars(original)}. Add its amount first.`, 422),
    };
  }
  const covered = Math.max(cents(original), cents(input.acceptedAmount ?? 0));
  if (cents(next) <= covered) return { kind: "no_variance" };

  const deltaCents = cents(next) - cents(original);
  const allowanceCents = Math.min(Math.floor((cents(original) * facts.marginPercent) / 100), cents(facts.capDollars));
  const figures: VarianceFigures = {
    allowance: allowanceCents / 100,
    deltaAmount: deltaCents / 100,
    deltaPercent: Math.round((deltaCents / cents(original)) * 10000) / 100,
    newAmount: next,
    originalAmount: original,
  };
  const above = `This is ${formatDollars(figures.deltaAmount)} (${formatPercent(figures.deltaPercent)}) above the approved ${formatDollars(original)}`;
  const refused = (code: string, message: string): VarianceDecision => ({ figures, kind: "refused", refusal: refuse(code, message, 422) });

  if (deltaCents > allowanceCents) {
    return refused(
      "variance_over_margin",
      `${above} — the allowed margin is ${formatPercent(facts.marginPercent)} up to ${formatDollars(facts.capDollars)}. Get it re-approved.`,
    );
  }
  const crossed = crossedThreshold(original, next, authority);
  if (crossed?.director) {
    return refused("variance_crosses_director", `${above} and takes it past the director approval threshold of ${formatDollars(crossed.amount)}. A director has to approve it.`);
  }
  if (crossed) {
    return refused("variance_crosses_limit", `${above} and takes it past the ${formatDollars(crossed.amount)} approval limit. Get it re-approved.`);
  }

  const rationale = input.request.rationale?.trim() ?? "";
  if (rationale === "") return refused("variance_rationale_required", `${above}, within the margin. Say why it went up (a rationale is required).`);

  const named = input.request.attributedTo;
  if (!named) return refused("variance_manager_required", `${above}, within the margin. Name the manager who agreed to it.`);
  const theirs = canApprove(withoutAdmin(named), { amount: next, buildingId: input.buildingId, subject: input.subject }, authority);
  if (samePersonIdentity(input.editor, named) || !theirs.allowed || theirs.basis !== "own_authority") {
    const who = named.displayName?.trim() || "The person you named";
    return refused("variance_manager_invalid", `${who} can't approve ${formatDollars(next)} themselves, so they can't agree to this increase. Name a manager who can, and not yourself.`);
  }
  return { attributedTo: named, figures, kind: "within_tolerance", rationale };
}
