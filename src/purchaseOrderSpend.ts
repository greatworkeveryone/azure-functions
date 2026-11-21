// SECA-03 / JOB-20: who may commit spend on a purchase order, decided in one
// pure place from the existing approval-authority core (canApprove through
// approvalOutcome) and the variance rule in moneyRules. No new thresholds.
//
//  - On a job with an approved quote the quote approval already applied the
//    spending limit, so a purchase order must go to the quoted contractor, and
//    the job's purchase orders together must stay within the quote plus the
//    variance margin (the caller measures `total` with checkVariance).
//  - On a contract job (no quote) the per-job cap is the person's own approval
//    limit, summed across every purchase order on the job. Above it, someone
//    whose limit covers the total has to raise or send it.
//  - Admin counts for nothing on a real record (decision 4), on either kind.
//
// A plain accounts clerk holds no spending authority: they may draft a purchase
// order (nothing leaves the building), but the person who sends it is checked.

import { approvalOutcome } from "./approvalOutcome";
import type { AuthorityFacts, Identity } from "./approvalAuthority";
import { formatDollars, type MoneyRefusal } from "./moneyRules";

export type PoSpendStage = "create" | "send";

export interface PoSpendInput {
  actor: Identity;
  /** The approved quote's contractor and amount; null when the job has none. */
  approvedQuote: { amount: number | null; contractorId: number | null } | null;
  buildingId: number;
  isContract: boolean;
  isTest: boolean;
  /** What the job's other purchase orders add up to (cap, else estimate, each). */
  otherCommitted: number;
  poContractorId: number | null;
  stage: PoSpendStage;
  /** This purchase order's amount; null when it has none. */
  thisAmount: number | null;
}

const WORDS: Record<string, string> = {
  accounts_manager: "an accounts manager",
  cfo: "the CFO",
  director: "a director",
  facilities_manager: "a facilities manager",
};

function refusal(code: string, message: string, details?: Record<string, unknown>): MoneyRefusal {
  return { code, details, message, status: 422 };
}

/** Who can raise it, from the approval route, in the words people use. */
function whoCan(route: { role?: string }[]): string {
  const names = route.map((step) => (step.role ? WORDS[step.role] : undefined)).filter((word): word is string => Boolean(word));
  return names.length > 0 ? names.join(", ") : "a director";
}

/** The total the job's purchase orders would reach with this one. */
export function committedTotal(input: Pick<PoSpendInput, "otherCommitted" | "thisAmount">): number | null {
  return input.thisAmount === null ? null : Math.round((input.otherCommitted + input.thisAmount) * 100) / 100;
}

/** The refusal, or null when this purchase order may be raised (create) or go out (send). */
export function purchaseOrderSpendRefusal(input: PoSpendInput, facts: AuthorityFacts): MoneyRefusal | null {
  const quote = input.approvedQuote;
  if (quote && quote.contractorId !== null && input.poContractorId !== quote.contractorId) {
    return refusal(
      "po_contractor_not_quoted",
      "This job's approved quote is from a different contractor. Raise the purchase order to the quoted contractor, or get the other contractor's quote approved first.",
    );
  }

  const total = committedTotal(input);
  const outcome = approvalOutcome(
    input.actor,
    { amount: total ?? Number.NaN, buildingId: input.buildingId, subject: "purchase_order" },
    facts,
    { isTest: input.isTest },
  );
  if (outcome.kind === "approved") return null;
  if (outcome.kind === "refused") {
    if (outcome.reason === "admin_test_records_only") return { ...refusal("po_admin_test_only", outcome.message), status: 403 };
    // Not eligible to spend: may draft, may not send. On a quote job the quote's approval carried the limit.
    const drafting = input.stage === "create";
    return drafting || quote ? null : { ...refusal("po_not_authorised", outcome.message), status: 403 };
  }
  // A director is the authority above every threshold: raising it is their own decision.
  if (quote || (outcome.kind === "awaiting_director" && (input.actor.roles ?? []).some((role) => role.trim().toLowerCase() === "director"))) return null;

  const figure = total === null ? "an amount that isn't set" : formatDollars(total);
  const within =
    outcome.kind === "awaiting_approval" && typeof outcome.actorLimit === "number" ? ` Your limit is ${formatDollars(outcome.actorLimit)}.` : "";
  return {
    ...refusal(
      "po_over_authority",
      `The purchase orders on this job would total ${figure}, which is more than you can commit on a job with no approved quote.${within} Ask ${whoCan(outcome.route)} to raise or send it.`,
      { limit: outcome.kind === "awaiting_approval" ? outcome.actorLimit : null, total },
    ),
    status: 403,
  };
}
