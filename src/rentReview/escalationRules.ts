// When a rent review is escalated (PLAN §3.4) and when that ends. Pure, and
// free of the escalation engine, so the review adapter and the generator can
// both read it without an import cycle.
//
//   E1 rent_review.not_commenced  attention  accounts_manager → director
//      not commenced (scheduled or due) from 14 days before the review date;
//      ends when it is commenced (or stops being open)
//   E2 rent_review.overdue        attention  accounts_manager → director
//      open and past its date (Darwin); ends when it is approved, waived or
//      cancelled (a billing override does not end it)
//   E3 rent_review.approval       authority  accounts_manager (not the preparer) → cfo → director
//      raised on SUBMIT; ends when it is approved or returned (or waived or
//      cancelled while it waits)
// E1 and E2 are raised by the generator when it runs live; E3 by submit. An
// overdue review that nobody has started has both: it is late, and it hasn't
// been started. Every condition is read for today's Darwin date from the
// review's own date, never a stored next-review column. A vacated or archived
// tenancy's review is not chased.

import { daysBetweenIso } from "../darwinDate";
import { isOpenState, isOverdue, type RentReviewState } from "../rentReviewMachine";

export const REVIEW_POLICIES = {
  approval: "rent_review.approval",
  notCommenced: "rent_review.not_commenced",
  overdue: "rent_review.overdue",
} as const;

export const GENERATOR_POLICIES = [REVIEW_POLICIES.notCommenced, REVIEW_POLICIES.overdue] as const;

/** E1 starts this many days before the review date. */
export const NOT_COMMENCED_LEAD_DAYS = 14;

/** What ended a review's escalation, stored as its ResolutionCode (the review's decision). */
export const REVIEW_DECISION_CODES = {
  approved: "approved",
  cancelled: "cancelled",
  commenced: "commenced",
  returned: "returned",
  reverted: "reverted",
  waived: "waived",
} as const;

export interface ReviewConditionFacts {
  scheduledFor: string;
  state: RentReviewState;
  /** The tenancy is vacated or archived: its review isn't chased. */
  tenancyClosed: boolean;
}

/** Whether a review policy's condition holds today. A policy this module doesn't
 *  know (a manual one) holds while the review is open. */
export function reviewConditionActive(policyKey: string, facts: ReviewConditionFacts, today: string): boolean {
  if (facts.tenancyClosed) return false;
  switch (policyKey) {
    case REVIEW_POLICIES.notCommenced:
      return (facts.state === "scheduled" || facts.state === "due") && daysBetweenIso(today, facts.scheduledFor) <= NOT_COMMENCED_LEAD_DAYS;
    case REVIEW_POLICIES.overdue:
      return isOverdue(facts.state, facts.scheduledFor, today);
    case REVIEW_POLICIES.approval:
      return facts.state === "awaiting_approval";
    default:
      return isOpenState(facts.state);
  }
}

/** The code E3 ends with when the review has moved on from awaiting approval;
 *  null while it still waits. */
export function approvalOutcomeCode(state: RentReviewState): string | null {
  switch (state) {
    case "awaiting_approval":
      return null;
    case "approved":
    case "completed":
      return REVIEW_DECISION_CODES.approved;
    case "waived":
      return REVIEW_DECISION_CODES.waived;
    case "cancelled":
      return REVIEW_DECISION_CODES.cancelled;
    default:
      return REVIEW_DECISION_CODES.returned;
  }
}

const MANUAL_END_CODES: ReadonlySet<string> = new Set(["action_taken", "no_action_needed", "other", "withdrawn"]);

/** The last escalation under one policy for a review, as the generator reads it. */
export interface PolicyHistory {
  /** When it was raised. */
  createdAt: Date;
  live: boolean;
  /** E3: the highest rung any of the review's E3 reached since it was submitted. */
  reachedRole?: string | null;
  /** ResolutionCode of an escalation that ended. */
  resolutionCode: string | null;
}

/**
 * Whether the generator should raise `policyKey` on the review now: its
 * condition holds, nothing under the policy is live, and (E1, E2) the last one
 * did not end at a person's hand (resolved by someone or withdrawn), which is
 * not raised again. One that ended because the review moved on (a decision, or
 * the condition cleared) is raised again when the condition comes back, as it
 * does after a revert. E3 is raised whenever the review waits for approval with
 * none live: only the review's decision ends it.
 */
export function shouldRaise(
  policyKey: string,
  facts: ReviewConditionFacts & { submittedAt: Date | null },
  last: PolicyHistory | null,
  today: string,
): boolean {
  if (!reviewConditionActive(policyKey, facts, today)) return false;
  if (!last) return true;
  if (last.live) return false;
  // E3 ends only with the review's decision: one waiting for approval with no
  // live E3 always gets it back, however the last one ended (L3).
  if (policyKey === REVIEW_POLICIES.approval) return true;
  return !MANUAL_END_CODES.has(last.resolutionCode ?? "");
}
