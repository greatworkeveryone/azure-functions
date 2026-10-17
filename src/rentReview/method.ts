// Which review method a review uses (PLAN check C2): the schedule step's own
// methodKind, else the tenancy's free-text review type read with mapMethodKind,
// else "other". "Other" is a real answer, not a failure: it is the manual path
// (a new rent keyed by hand, with an explanation, always approved by someone
// else), so C2 never refuses; it only says where the method came from.

import { mapMethodKind } from "../leaseMethod";
import type { RentReviewMethod } from "../rentReviewMachine";
import type { RentScheduleMethodKind, ScheduledRateStep } from "../scheduledRateStepLogic";

export type MethodSource = "fallback" | "review_type" | "step";

export interface ResolvedMethod {
  method: RentReviewMethod;
  source: MethodSource;
}

/** The ledger's ruleApplied for how the method was resolved. */
export const METHOD_RULE_APPLIED: Record<MethodSource, string> = {
  fallback: "method_other_fallback",
  review_type: "method_from_review_type",
  step: "method_from_step",
};

/** A schedule kind that names a review method. A commencement row is where the
 *  rent starts, not a review. */
function reviewMethodOf(kind: RentScheduleMethodKind | null | undefined): RentReviewMethod | null {
  return kind === "cpi" || kind === "fixed" || kind === "market" || kind === "other" ? kind : null;
}

export function resolveReviewMethod(input: {
  reviewType: string | null | undefined;
  step: Pick<ScheduledRateStep, "methodKind"> | null | undefined;
}): ResolvedMethod {
  const fromStep = reviewMethodOf(input.step?.methodKind);
  if (fromStep) return { method: fromStep, source: "step" };
  const fromType = reviewMethodOf(mapMethodKind(input.reviewType ?? ""));
  if (fromType) return { method: fromType, source: "review_type" };
  return { method: "other", source: "fallback" };
}

/** The lease says it has no review clause: Tenants.ReviewType is 'none', the
 *  register's default for a new tenancy. A blank or unrecognised type is not
 *  this: nobody has classified that lease yet. */
export function hasNoReviewClause(reviewType: string | null | undefined): boolean {
  return (reviewType ?? "").trim().toLowerCase() === "none";
}

/** The schedule step a review of `scheduledFor` is about: a review step dated
 *  that day. The first one wins if the schedule (wrongly) holds two. */
export function stepOnDate(
  steps: readonly ScheduledRateStep[],
  scheduledFor: string,
): ScheduledRateStep | null {
  return steps.find((step) => step.effectiveFrom === scheduledFor && step.methodKind !== "commencement") ?? null;
}
