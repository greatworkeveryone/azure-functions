// A review whose basis departs from the lease, worked again on the lease's own
// terms (PLAN §3.12, M3), so SUBMIT can record what the departure is worth: the
// result on the lease's terms beside the rent submitted, in the ledger and on
// the calc. Reads the CPI pair for the lease's own region and interval.

import type { Connection } from "tedious";
import { calculateReview, leaseBasis, type LeaseTermsForReview, type LeaseTermsResult } from "../rentReviewCalc";
import { previousQuarter, referenceQuarter } from "./cpi";
import type { ReviewSchedule } from "./reviewTenancy";
import { loadCpiRows } from "./store";
import { ancillaryAnnual } from "./written";

export interface LeaseTermsInput {
  lease: LeaseTermsForReview;
  method: "cpi" | "fixed";
  newStepId: string;
  reviewId: string;
  schedule: ReviewSchedule;
  scheduledFor: string;
  scheduleVersion: number;
  stepId: string | null;
  today: string;
}

export async function rentOnLeaseTerms(connection: Connection, input: LeaseTermsInput): Promise<LeaseTermsResult> {
  const basis = leaseBasis(input.method, input.lease, input.scheduledFor);
  const region = typeof basis.region === "string" ? basis.region : "";
  const reference = referenceQuarter(input.scheduledFor);
  const interval = typeof basis.intervalMonths === "number" ? basis.intervalMonths : null;
  const cpiRows =
    input.method === "cpi" && (region === "AUS" || region === "DARWIN")
      ? await loadCpiRows(connection, region, [reference, previousQuarter(reference, interval)])
      : [];
  const result = calculateReview({
    basis,
    carparkGroups: input.schedule.carparkGroups,
    computedAt: new Date().toISOString(),
    computedBy: { name: "on the lease's terms", userId: null },
    cpiRows,
    fallbackAnnual: input.schedule.context.fallbackAnnual,
    fallbackSqm: input.schedule.context.fallbackSqm,
    lease: {
      cpiCapPercent: input.schedule.context.lease.cpiCapPercent ?? null,
      cpiFloorPercent: input.schedule.context.lease.cpiFloorPercent ?? null,
      reviewRatchet: input.schedule.context.lease.reviewRatchet === true,
    },
    method: input.method,
    miscFees: input.schedule.miscFees,
    newStepId: input.newStepId,
    reviewId: input.reviewId,
    sanity: { maxPercent: 100, minPercent: -100 },
    scheduledFor: input.scheduledFor,
    scheduleVersion: input.scheduleVersion,
    stepId: input.stepId,
    steps: input.schedule.context.steps,
    today: input.today,
  });
  if (result.kind === "calc") {
    return { ancillaryAnnual: ancillaryAnnual(result.calc.cascade), appliedPercent: result.calc.appliedPercent, newAnnual: result.calc.newAnnual };
  }
  if (result.kind === "index_pending") {
    return { unavailable: `The lease's own CPI quarters (${result.missing.join(", ")}, ${result.region}) aren't published yet` };
  }
  return { unavailable: result.message };
}
