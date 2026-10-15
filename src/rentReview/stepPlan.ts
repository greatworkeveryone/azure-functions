// Where a rent review lands on the schedule (PLAN §3.1 APPLY, D1). Pure.
//
// The schedule engine (scheduledRateStepLogic.ts, mirrored in the frontend) is
// the one source of the rent, so a review never stores a figure of its own: it
// writes a step, and the engine works the rent out from it. Everything here runs
// the real engine over the steps as they would be written, so what a review
// shows and what the schedule then says can't drift apart.
//
// Placing a review step: the step already dated on the review date (the one
// commence linked, else the first review row on that date) is updated in place;
// with none, a new row is added there, ending (exclusively) where the next row
// starts, and the open-ended row before it is closed on the review date — the
// same thing upsertScheduledRateStep does for a step added by hand.
//
// Choosing how to write an approved rent (representStep): the engine clamps a
// CPI row to the lease's cap and floor and holds every review row of a ratchet
// lease at no decrease, using the tenancy's own terms. A computed CPI result on
// the lease's terms is written as the CPI row it is (both index values on it).
// Anything the engine would compute differently — an override, a basis that
// departs from the lease — is written as a rate the engine reproduces to the
// cent: first on the review's own method, then, when the lease's CPI cap or
// floor would clamp that rate, as an `other` row (which nothing clamps), still
// carrying the index pair for the record. A rent the engine can't reproduce at
// all (a decrease on a ratchet lease) is refused by the caller before this.

import {
  closeOpenPredecessor,
  computeScheduleRows,
  normaliseLegacyEnds,
  type RentScheduleMethodKind,
  type ScheduleRow,
  type ScheduledRateStep,
  type ScheduleTerms,
  sortSteps,
  type StepDiff,
  upsertStep,
} from "../scheduledRateStepLogic";

/** The schedule a review is worked on: the tenancy's steps and the inputs the engine needs. */
export interface ScheduleContext {
  /** Tenants.RentPerAnnum: the schedule's starting rent when no commencement row carries one. */
  fallbackAnnual: number;
  /** The tenancy's total area, the $/m² fallback. */
  fallbackSqm: number;
  /** The lease's terms, as the engine applies them to every row. */
  lease: ScheduleTerms;
  steps: readonly ScheduledRateStep[];
}

export interface ReviewRowTarget {
  /** The review's method, for a row this review adds. */
  method: RentScheduleMethodKind;
  /** Id for a row this review adds (the caller generates it). */
  newStepId: string;
  reviewId: string;
  scheduledFor: string;
  /** RentReviews.StepId: the step commence linked, if any. */
  stepId: string | null;
}

export type ReviewRowResult =
  | { base: ScheduledRateStep; existing: ScheduledRateStep | null; ok: true }
  | { ok: false; reason: "step_settled"; step: ScheduledRateStep };

/** The row this review settles: the linked step if it is still a review row on
 *  the date, else the first review row on the date, else a new row there. A row
 *  another review (or a person) already settled is refused. */
export function reviewRow(steps: readonly ScheduledRateStep[], target: ReviewRowTarget): ReviewRowResult {
  const onDate = (step: ScheduledRateStep) => step.effectiveFrom === target.scheduledFor && step.methodKind !== "commencement";
  const linked = target.stepId ? steps.find((step) => step.id === target.stepId && onDate(step)) : undefined;
  const existing = linked ?? steps.find(onDate) ?? null;
  if (existing) {
    if (existing.resolution && existing.reviewId !== target.reviewId) return { ok: false, reason: "step_settled", step: existing };
    return { base: { ...existing }, existing, ok: true };
  }
  const next = sortSteps([...steps]).find((step) => step.effectiveFrom > target.scheduledFor);
  const base: ScheduledRateStep = {
    effectiveFrom: target.scheduledFor,
    id: target.newStepId,
    methodKind: target.method,
    ratePercent: 0,
    ...(next ? { effectiveTo: next.effectiveFrom } : {}),
  };
  return { base, existing: null, ok: true };
}

export interface PlacedSteps {
  /** The open-ended row before a new row, closed on its date. */
  closed: { after: ScheduledRateStep; before: ScheduledRateStep } | null;
  steps: ScheduledRateStep[];
}

/** The steps with `step` written: updated in place, or added (closing the
 *  open-ended row before it), exactly as upsertScheduledRateStep writes one. */
export function placeStep(steps: readonly ScheduledRateStep[], step: ScheduledRateStep): PlacedSteps {
  const { closed, steps: withClosed } = closeOpenPredecessor([...steps], step);
  return { closed, steps: normaliseLegacyEnds(upsertStep(withClosed, step)) };
}

export interface Simulation {
  placed: PlacedSteps;
  /** The review's row as the engine computes it; null if it vanished (can't happen for a placed step). */
  row: ScheduleRow | null;
  rows: ScheduleRow[];
}

/** Runs the engine over the schedule with `step` written. */
export function simulate(context: ScheduleContext, step: ScheduledRateStep): Simulation {
  const placed = placeStep(context.steps, step);
  const rows = computeScheduleRows(placed.steps, context.fallbackAnnual, context.fallbackSqm, context.lease);
  return { placed, row: rows.find((row) => row.step.id === step.id) ?? null, rows };
}

/** The review row with the review settled as waived: factor 1, so its annual is
 *  the rent in force on the review date before the review (any area change on
 *  that row included). */
export function waivedStep(base: ScheduledRateStep, reviewId: string): ScheduledRateStep {
  return { ...base, resolution: "waived", reviewId };
}

/** A review row settled as applied, with only the fields given for its value. */
export function appliedStep(
  base: ScheduledRateStep,
  reviewId: string,
  value: { cpiValue?: number; cpiValuePrev?: number; methodKind: RentScheduleMethodKind; ratePercent: number },
): ScheduledRateStep {
  // The index pair is the value's to give: a row written as a rate must not keep
  // an old pair, or the engine would read the pair instead of the rate.
  const rest: ScheduledRateStep = { ...base };
  delete rest.cpiValue;
  delete rest.cpiValuePrev;
  return {
    ...rest,
    methodKind: value.methodKind,
    ratePercent: value.ratePercent,
    ...(value.cpiValue !== undefined ? { cpiValue: value.cpiValue } : {}),
    ...(value.cpiValuePrev !== undefined ? { cpiValuePrev: value.cpiValuePrev } : {}),
    resolution: "applied",
    reviewId,
  };
}

const RATE_LIMIT = 100;
const SEARCH_STEPS = 200;

/**
 * The rate % (full precision) that makes the engine put exactly `target` on the
 * review row, or null when no rate does (the lease clamps or ratchets it away,
 * or it is outside ±100%). The engine's annual is monotone in the rate, so a
 * bracket and a bisection find one.
 */
export function exactRate(
  context: ScheduleContext,
  make: (ratePercent: number) => ScheduledRateStep,
  currentAnnual: number,
  target: number,
): number | null {
  const annualAt = (rate: number): number => {
    const row = simulate(context, make(rate)).row;
    return row && !row.pending ? row.annual : Number.NaN;
  };
  if (!(currentAnnual > 0) || !Number.isFinite(target)) return null;
  const first = (target / currentAnnual - 1) * 100;
  if (Math.abs(first) <= RATE_LIMIT && annualAt(first) === target) return first;

  // Bracket the target, widening by a few cents' worth of rate at a time.
  let width = (0.02 / currentAnnual) * 100;
  let lo = first - width;
  let hi = first + width;
  for (let i = 0; i < 40 && !(annualAt(lo) < target); i++) lo = first - (width *= 2);
  width = (0.02 / currentAnnual) * 100;
  for (let i = 0; i < 40 && !(annualAt(hi) > target); i++) hi = first + (width *= 2);
  if (!(annualAt(lo) < target) || !(annualAt(hi) > target)) return null;

  for (let i = 0; i < SEARCH_STEPS; i++) {
    const mid = (lo + hi) / 2;
    const value = annualAt(mid);
    if (value === target) return Math.abs(mid) <= RATE_LIMIT ? mid : null;
    if (Number.isNaN(value)) return null;
    if (value < target) lo = mid;
    else hi = mid;
    if (hi - lo < 1e-15) break;
  }
  return null;
}

/** How a review's rent is written on its step. */
export type Representation =
  /** The method as it stands: a CPI row with both index values, a fixed row with its %. */
  | "natural"
  /** The review's method with an exact rate (a CPI row without its index pair, so the rate stands). */
  | "method_rate"
  /** An `other` row with an exact rate, which no lease cap or floor clamps. */
  | "other_rate";

export interface RepresentInput {
  base: ScheduledRateStep;
  context: ScheduleContext;
  /** The rent in force on the review date before the review (the waived row's annual). */
  currentAnnual: number;
  /** CPI reviews: the two index values the review was worked from. */
  cpi?: { current: number; previous: number } | null;
  /** The review's method and, for a natural row, its own value. */
  method: "cpi" | "fixed" | "other";
  /** The natural row's rate: the applied % for CPI (informational), the lease % for fixed. */
  naturalRate: number;
  reviewId: string;
  /** The approved new annual rent, to the cent. */
  target: number;
}

export type RepresentResult =
  | { ok: true; representation: Representation; row: ScheduleRow; simulation: Simulation; step: ScheduledRateStep }
  | { ok: false };

/** The first way of writing the step whose engine result is exactly `target`. */
export function representStep(input: RepresentInput): RepresentResult {
  const { base, context, cpi, reviewId, target } = input;
  const accept = (step: ScheduledRateStep, representation: Representation): RepresentResult | null => {
    const simulation = simulate(context, step);
    const row = simulation.row;
    return row && !row.pending && row.annual === target ? { ok: true, representation, row, simulation, step } : null;
  };

  if (input.method === "cpi" && cpi) {
    const natural = accept(
      appliedStep(base, reviewId, { cpiValue: cpi.current, cpiValuePrev: cpi.previous, methodKind: "cpi", ratePercent: input.naturalRate }),
      "natural",
    );
    if (natural) return natural;
  } else if (input.method === "fixed") {
    const natural = accept(appliedStep(base, reviewId, { methodKind: "fixed", ratePercent: input.naturalRate }), "natural");
    if (natural) return natural;
  }

  const prev = cpi ? { cpiValuePrev: cpi.previous } : {};
  if (input.method !== "other") {
    const make = (ratePercent: number) => appliedStep(base, reviewId, { ...prev, methodKind: input.method, ratePercent });
    const rate = exactRate(context, make, input.currentAnnual, target);
    const found = rate === null ? null : accept(make(rate), "method_rate");
    if (found) return found;
  }

  const pair = cpi ? { cpiValue: cpi.current, cpiValuePrev: cpi.previous } : {};
  const makeOther = (ratePercent: number) => appliedStep(base, reviewId, { ...pair, methodKind: "other", ratePercent });
  const rate = exactRate(context, makeOther, input.currentAnnual, target);
  const found = rate === null ? null : accept(makeOther(rate), "other_rate");
  return found ?? { ok: false };
}

/** Whether Tenants.RentPerAnnum is only a cache for this schedule: true when the
 *  first row is a commencement row carrying its own starting rent, so the engine
 *  never reads RentPerAnnum. Otherwise it is the schedule's starting rent, and
 *  overwriting it with a reviewed rent would apply the review twice. */
export function rentPerAnnumIsCache(steps: readonly ScheduledRateStep[]): boolean {
  const first = sortSteps([...steps])[0];
  return first !== undefined && first.methodKind === "commencement" && first.baseRentPerAnnum != null;
}

// ── Undoing a review's write (REVERT) ──────────────────────────────────────────

/** A change-log entry as REVERT reads it. */
export interface LoggedChange {
  changeKind: "added" | "deleted" | "updated";
  diff: StepDiff | null;
  snapshot: ScheduledRateStep;
  stepId: string;
}

/** The step as it was before an `updated` entry: the snapshot with every
 *  changed field set back (a field that was absent is removed again). */
export function priorStep(change: LoggedChange): ScheduledRateStep {
  const prior: Record<string, unknown> = { ...change.snapshot };
  for (const [field, { from }] of Object.entries(change.diff ?? {})) {
    if (from === null || from === undefined) delete prior[field];
    else prior[field] = from;
  }
  return prior as unknown as ScheduledRateStep;
}

const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : inner,
  );

/** Two steps hold the same values, key order aside. */
export function sameStep(a: ScheduledRateStep | null | undefined, b: ScheduledRateStep | null | undefined): boolean {
  return canonical(a ?? null) === canonical(b ?? null);
}

export type UndoResult =
  | { ok: true; restored: Array<{ after: ScheduledRateStep | null; before: ScheduledRateStep; stepId: string }>; steps: ScheduledRateStep[] }
  | { ok: false; stepId: string };

/**
 * The steps with a review's own writes taken back, newest first: a row it
 * added is removed, a row it updated gets its earlier values back. Refused
 * (ok: false) when a row it wrote has been changed since, so a later edit is
 * never silently undone.
 */
export function undoChanges(steps: readonly ScheduledRateStep[], changes: readonly LoggedChange[]): UndoResult {
  let next = [...steps];
  const restored: Array<{ after: ScheduledRateStep | null; before: ScheduledRateStep; stepId: string }> = [];
  for (const change of [...changes].reverse()) {
    const current = next.find((step) => step.id === change.stepId);
    if (!current || !sameStep(current, change.snapshot)) return { ok: false, stepId: change.stepId };
    if (change.changeKind === "added") {
      next = next.filter((step) => step.id !== change.stepId);
      restored.push({ after: null, before: current, stepId: change.stepId });
    } else if (change.changeKind === "updated") {
      const prior = priorStep(change);
      next = next.map((step) => (step.id === change.stepId ? prior : step));
      restored.push({ after: prior, before: current, stepId: change.stepId });
    } else {
      return { ok: false, stepId: change.stepId };
    }
  }
  return { ok: true, restored, steps: next };
}
