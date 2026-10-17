// The terms the schedule engine computes a tenancy's rows with (WP23b, WP26c):
// the lease's CPI cap, floor and ratchet from its Tenants row, and
// REVIEW_WORKFLOW_LIVE_FROM, after which a review row keyed ahead stays pending
// until a review applies it (M2). Every backend read and write that works out a
// rent from the schedule takes its terms from here, so they all agree; the
// frontend gets the same date as reviewWorkflowLiveFrom on the tenancy.

import { reviewWorkflowLiveFrom } from "./nextReviewDate";
import type { ScheduleTerms } from "./scheduledRateStepLogic";

const decimal = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export function scheduleTermsOf(row: { CpiCapPercent?: unknown; CpiFloorPercent?: unknown; ReviewRatchet?: unknown }): Required<ScheduleTerms> {
  return {
    cpiCapPercent: decimal(row.CpiCapPercent),
    cpiFloorPercent: decimal(row.CpiFloorPercent),
    reviewRatchet: row.ReviewRatchet === true || row.ReviewRatchet === 1,
    workflowLiveFrom: reviewWorkflowLiveFrom(),
  };
}
