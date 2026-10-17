// A rent review as APPLY will write it (PLAN §3.1, WP26 H1). Pure.
//
// Calculate, submit and APPLY all start here: the rent is written on the review
// row the way APPLY writes it (representStep), the schedule engine runs over the
// result, and the receipt is read off that schedule: the cascade to AHAC, car
// parks and misc fees from the rows as written, and the arrears for every charge
// that changes. So what an approver is shown is the schedule after APPLY, to the
// cent, whatever the rent is (the computed one, an override, a departure from
// the lease). A rent the schedule can't hold is null: calculate and submit
// refuse it, so nobody is asked to approve one.

import type { RentReviewCalc } from "../rentReviewCalc";
import type { CarparkScheduleGroup, MiscFee, ScheduledRateStep, ScheduleRow } from "../scheduledRateStepLogic";
import { arrearsFor, reviewChanges, type ArrearsLine } from "./arrears";
import { computeCascade, type CascadeBounds, type CascadeRow } from "./cascade";
import type { ReviewSchedule } from "./reviewTenancy";
import {
  representStep,
  type Representation,
  reviewRow,
  type ScheduleContext,
  simulate,
  type Simulation,
  waivedStep,
} from "./stepPlan";

export interface WrittenReviewInput {
  /** The review row before it is written (stepPlan.reviewRow). */
  base: ScheduledRateStep;
  /** The schedule with the review row waived: the rent and AHAC before the review. */
  before: Simulation;
  bounds: CascadeBounds | null;
  carparkGroups: readonly CarparkScheduleGroup[];
  context: ScheduleContext;
  cpi: { current: number; previous: number } | null;
  currentAnnual: number;
  /** An override or a basis that departs from the lease (stepPlan.representStep). */
  departs: boolean;
  method: "cpi" | "fixed" | "other";
  miscFees: readonly MiscFee[];
  /** The CPI row's rate (informational) or the fixed %. */
  naturalRate: number;
  reviewId: string;
  scheduledFor: string;
  /** The new annual rent, to the cent. */
  target: number;
  /** The Darwin date the arrears run to. */
  today: string;
}

export interface WrittenReview {
  arrears: ArrearsLine | null;
  cascade: CascadeRow[];
  representation: Representation;
  /** The review row as written. */
  row: ScheduleRow;
  simulation: Simulation;
  step: ScheduledRateStep;
}

export function writtenReview(input: WrittenReviewInput): WrittenReview | null {
  const written = representStep({
    base: input.base,
    context: input.context,
    cpi: input.cpi,
    currentAnnual: input.currentAnnual,
    departs: input.departs,
    method: input.method,
    naturalRate: input.naturalRate,
    reviewId: input.reviewId,
    target: input.target,
  });
  if (!written.ok) return null;
  const through = written.simulation.rows.indexOf(written.row);
  const rowsThrough = written.simulation.rows.slice(0, through + 1);
  const cascade = computeCascade({
    ahac: { after: written.row.ahacAnnual, before: input.before.row?.ahacAnnual ?? null },
    bounds: input.bounds,
    carparkGroups: input.carparkGroups,
    miscFees: input.miscFees,
    reviewRow: written.row,
    rowsBefore: rowsThrough.slice(0, -1),
    rowsThrough,
  });
  return {
    arrears: arrearsFor(input.scheduledFor, input.today, reviewChanges(input.currentAnnual, input.target, cascade)),
    cascade,
    representation: written.representation,
    row: written.row,
    simulation: written.simulation,
    step: written.step,
  };
}

/** The annual total of the charges that follow the rent (AHAC, car parks, misc fees). */
export function ancillaryAnnual(cascade: readonly CascadeRow[]): number {
  return Math.round(cascade.reduce((sum, row) => sum + row.newAnnual, 0) * 100) / 100;
}

export interface StoredCalcTarget {
  /** The stored calc: its method, CPI pair, bounds and the rent it started from. */
  calc: Pick<RentReviewCalc, "appliedPercent" | "bounds" | "cpi" | "currentAnnual" | "fixedPercent" | "method">;
  departs: boolean;
  /** Id for a schedule row the review adds. */
  newStepId: string;
  reviewId: string;
  schedule: ReviewSchedule;
  scheduledFor: string;
  /** RentReviews.StepId. */
  stepId: string | null;
  /** The new annual rent to write. */
  target: number;
  today: string;
}

export type FromCalc =
  | { kind: "written"; written: WrittenReview; existing: ScheduledRateStep | null }
  | { kind: "stale" }
  | { kind: "step_settled" }
  | { kind: "unrepresentable" };

/**
 * A stored calc's rent (or the chosen one) as APPLY writes it on the schedule
 * as it stands: what SUBMIT shows the approver and what APPLY writes, from one
 * function. `stale` when the rent on the review date is no longer the calc's
 * starting rent (C4 has held, so it means something moved underneath).
 */
export function writtenFromCalc(input: StoredCalcTarget): FromCalc {
  const { calc, schedule } = input;
  const placed = reviewRow(schedule.context.steps, {
    method: calc.method,
    newStepId: input.newStepId,
    reviewId: input.reviewId,
    scheduledFor: input.scheduledFor,
    stepId: input.stepId,
  });
  if (!placed.ok) return { kind: "step_settled" };
  const before = simulate(schedule.context, waivedStep(placed.base, input.reviewId));
  if (!before.row || before.row.pending || before.row.annual !== calc.currentAnnual) return { kind: "stale" };
  const written = writtenReview({
    base: placed.base,
    before,
    bounds: calc.bounds ? { capPercent: calc.bounds.capPercent, floorPercent: calc.bounds.floorPercent } : null,
    carparkGroups: schedule.carparkGroups,
    context: schedule.context,
    cpi: calc.cpi ? { current: calc.cpi.current, previous: calc.cpi.previous } : null,
    currentAnnual: calc.currentAnnual,
    departs: input.departs,
    method: calc.method,
    miscFees: schedule.miscFees,
    naturalRate: calc.method === "fixed" ? (calc.fixedPercent ?? 0) : calc.appliedPercent,
    reviewId: input.reviewId,
    scheduledFor: input.scheduledFor,
    target: input.target,
    today: input.today,
  });
  return written ? { existing: placed.existing, kind: "written", written } : { kind: "unrepresentable" };
}
