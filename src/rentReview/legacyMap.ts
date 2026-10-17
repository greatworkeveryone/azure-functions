// The legacy RentReviews.Status and RentReviews.ReviewType columns stay as they
// are (PLAN WP25, database-safety rules: expand, then contract). Their CHECK
// constraints, from migration 037, only accept the old vocabularies, so every
// row the workflow writes also carries the nearest legacy value. Dropping the
// two columns and their CHECKs is a later, separately approved migration (111);
// until then this file is the only place the mapping lives.
//
// Readers that predate the workflow read Status: approved and completed reviews
// read as 'completed' and waived or cancelled ones as 'skipped'. The next-review
// derivation (RESOLVED_REVIEW_DATES_SQL) reads State first for workflow rows, so
// a cancelled review does not settle its date there (WP26).

import type { RentReviewMethod, RentReviewState } from "../rentReviewMachine";

/** CK_RentReviews_ReviewType (migration 037). */
export const LEGACY_REVIEW_TYPES = ["none", "fixedPercent", "cpi", "marketReview"] as const;
export type LegacyReviewType = (typeof LEGACY_REVIEW_TYPES)[number];

/** CK_RentReviews_Status (migration 037). 'overdue' is never written: overdue is derived. */
export const LEGACY_STATUSES = ["upcoming", "due", "overdue", "completed", "skipped"] as const;
export type LegacyStatus = (typeof LEGACY_STATUSES)[number];

const REVIEW_TYPE_OF_METHOD: Record<RentReviewMethod, LegacyReviewType> = {
  cpi: "cpi",
  fixed: "fixedPercent",
  market: "marketReview",
  other: "none",
};

const STATUS_OF_STATE: Record<RentReviewState, LegacyStatus> = {
  approved: "completed",
  awaiting_approval: "due",
  awaiting_index: "due",
  cancelled: "skipped",
  completed: "completed",
  due: "due",
  in_progress: "due",
  referred: "due",
  scheduled: "upcoming",
  waived: "skipped",
};

export function legacyReviewType(method: RentReviewMethod): LegacyReviewType {
  return REVIEW_TYPE_OF_METHOD[method];
}

export function legacyStatus(state: RentReviewState): LegacyStatus {
  return STATUS_OF_STATE[state];
}
