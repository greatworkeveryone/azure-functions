// Working a review out from the database (PLAN §3.2, WP26): what CALCULATE does
// for a person and what the CPI timer does by itself once a waiting review's
// index is published (L7). Loads the CPI pair for the basis's region, the
// schedule and the tenancy's area, works out which basis terms depart from the
// lease, and runs the calculation (rentReviewCalc.ts). Writes nothing.

import { randomUUID } from "node:crypto";
import type { Connection } from "tedious";
import type { SqlRow } from "../db";
import { calculateReview, leaseDepartures, sanityBandFromEnv, type CalcMethod, type CalcResult } from "../rentReviewCalc";
import { parseSteps } from "../scheduledRateStepLogic";
import { cpiReferenceRuleOf, parseBasis } from "./basis";
import { previousQuarter, referenceQuarterFor } from "./cpi";
import { toReviewDto } from "./dto";
import { stepOnDate } from "./method";
import { leaseTermsOf, scheduleOf } from "./reviewTenancy";
import { loadCpiRows, totalOccupancySqm } from "./store";

export interface WorkOutInput {
  computedBy: { name: string; userId: number | null };
  manual: { explanation: string; newAnnual: number } | null;
  method: CalcMethod;
  /** The review row (store.reviewForUpdate). */
  review: SqlRow;
  /** The tenancy row (store.loadTenancyForReview). */
  tenancy: SqlRow;
  today: string;
}

export async function workOutReview(connection: Connection, input: WorkOutInput): Promise<CalcResult> {
  const { review, tenancy } = input;
  const reviewId = String(review.ReviewId);
  const tenantId = Number(review.TenantId);
  const basis = parseBasis(review.Basis) ?? {};
  const scheduledFor = toReviewDto(review, input.today).scheduledFor;
  const region = typeof basis.region === "string" ? basis.region.toUpperCase() : "";
  const interval = typeof basis.intervalMonths === "number" ? basis.intervalMonths : null;
  const reference = referenceQuarterFor(cpiReferenceRuleOf(basis.referenceQuarterRule), scheduledFor);
  const cpiRows =
    input.method === "cpi" && (region === "AUS" || region === "DARWIN")
      ? await loadCpiRows(connection, region, [reference, previousQuarter(reference, interval)])
      : [];
  const steps = parseSteps(tenancy.ScheduledRateSteps as string | null | undefined);
  const schedule = scheduleOf(tenancy, steps, await totalOccupancySqm(connection, tenantId));
  const departures = input.method === "other" ? [] : leaseDepartures(input.method, basis, leaseTermsOf(tenancy, stepOnDate(steps, scheduledFor)));
  return calculateReview({
    basis,
    carparkGroups: schedule.carparkGroups,
    computedAt: new Date().toISOString(),
    computedBy: input.computedBy,
    cpiRows,
    departures,
    fallbackAnnual: schedule.context.fallbackAnnual,
    fallbackSqm: schedule.context.fallbackSqm,
    lease: {
      cpiCapPercent: schedule.context.lease.cpiCapPercent ?? null,
      cpiFloorPercent: schedule.context.lease.cpiFloorPercent ?? null,
      reviewRatchet: schedule.context.lease.reviewRatchet === true,
      workflowLiveFrom: schedule.context.lease.workflowLiveFrom ?? null,
    },
    manual: input.manual,
    method: input.method,
    miscFees: schedule.miscFees,
    newStepId: randomUUID(),
    reliefs: schedule.reliefs,
    reviewId,
    sanity: sanityBandFromEnv(),
    scheduledFor,
    scheduleVersion: Number(tenancy.ScheduleVersion ?? 0),
    stepId: typeof review.StepId === "string" ? review.StepId : null,
    steps,
    today: input.today,
  });
}
