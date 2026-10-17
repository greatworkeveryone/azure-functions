// The rent review calculation (PLAN §3.2, WP26). Pure: the endpoint loads the
// review, the tenancy's schedule and the CPI rows, and this works out the new
// rent, the receipt the review workspace shows, and whether it may apply in one
// step. Nothing here reads a clock or the database.
//
//   CPI     both index values from CpiIndex at calc time, on one base (never a
//           stored old-base value): the reference quarter is the quarter ending
//           immediately before the review date (Q5), the earlier one a review
//           interval before it. ratio → clamp(1 + floor, 1 + cap) → ratchet.
//           Either quarter unpublished: INDEX_PENDING, expected at the quarter's
//           end + 30 days.
//   Fixed   old × (1 + the basis's fixed %), held at no decrease by the ratchet.
//   Other   the new annual rent keyed by hand, with an explanation; always
//           approved by someone else.
//
// The rent before the review is the schedule's own figure on the review date
// (the review row settled as waived, so any area change on that row counts),
// and when the review's terms are the lease's, the new rent is the schedule
// engine's own figure for the row as APPLY will write it, so the receipt and the
// schedule agree to the cent. When the review departs from the lease (a basis
// edited away from it) the new rent is the old one times the review's factor,
// and APPLY writes it as a rate the engine reproduces (rentReview/stepPlan.ts).
//
// Calc JSON (RentReviews.Calc), the contract with the frontend:
//   { method, computedAt, computedBy, scheduleVersion, currentAnnual,
//     cpi?: { region, referenceQuarter, previousQuarter, current, previous, referenceBase, ratio, rawPercent },
//     bounds?: { capPercent, floorPercent, ratchet, clampedBy: "cap"|"floor"|null, ratcheted },
//     fixedPercent?, manual?: { newAnnual, explanation },
//     appliedPercent, newAnnual, perMonth, perSqm,
//     cascade: [{ kind, label, currentAnnual, newAnnual, appliedPercent, note }],
//     arrears: { from, to, months, amount, lines: [{ kind, label, amount }] } | null,
//     departures: [the basis terms that differ from the lease's],
//     sanity: { minPercent, maxPercent, inBand },
//     override?: { newAnnual, reason, differenceAnnual, appliedPercent, perMonth,     set by submit:
//                  perSqm, cascade, arrears, ancillaryDifferenceAnnual } }            the chosen rent's receipt
// The top level is always the computed result; an override carries the chosen
// rent's own receipt. Either receipt is the schedule as APPLY writes that rent
// (rentReview/written.ts), and the arrears cover the rent, AHAC, car parks and
// misc fees alike.
// Money is to the cent, percentages to 4 dp, the index ratio to 6.

import type { ArrearsLine } from "./rentReview/arrears";
import type { CascadeRow } from "./rentReview/cascade";
import { expectedRelease, previousQuarter, referenceQuarter, type CpiIndexRow } from "./rentReview/cpi";
import { appliedStep, reviewRow, type ScheduleContext, simulate, waivedStep } from "./rentReview/stepPlan";
import { writtenReview } from "./rentReview/written";
import type { CarparkScheduleGroup, MiscFee, ScheduledRateStep } from "./scheduledRateStepLogic";

export { arrearsFor, computeArrears, reviewChanges, type ArrearsLine, type ArrearsPart } from "./rentReview/arrears";

export type CalcMethod = "cpi" | "fixed" | "other";

export interface CalcCpi {
  current: number;
  previous: number;
  previousQuarter: string;
  ratio: number;
  rawPercent: number;
  referenceBase: string;
  referenceQuarter: string;
  region: string;
}

export interface CalcBounds {
  capPercent: number | null;
  clampedBy: "cap" | "floor" | null;
  floorPercent: number | null;
  ratchet: boolean;
  ratcheted: boolean;
}

export interface SanityBand {
  inBand: boolean;
  maxPercent: number;
  minPercent: number;
}

/** The rent chosen instead of the computed one (SUBMIT), with its own receipt:
 *  the cascade and arrears worked from the schedule as APPLY writes the chosen
 *  rent, so the approver sees what the schedule will say (H1). */
export interface CalcOverride {
  /** Annual AHAC, car parks and misc fees at the chosen rent less at the computed one. */
  ancillaryDifferenceAnnual?: number;
  /** The chosen rent against the rent before the review (4 dp). */
  appliedPercent?: number;
  arrears?: ArrearsLine | null;
  cascade?: CascadeRow[];
  /** The chosen rent less the computed one. */
  differenceAnnual: number;
  newAnnual: number;
  perMonth?: number;
  perSqm?: number | null;
  reason: string;
}

export interface RentReviewCalc {
  appliedPercent: number;
  arrears: ArrearsLine | null;
  bounds?: CalcBounds;
  cascade: CascadeRow[];
  computedAt: string;
  /** Who calculated it. For a manual (`other`) review this person keyed the new rent. */
  computedBy: { name: string; userId: number | null };
  cpi?: CalcCpi;
  currentAnnual: number;
  /** The basis terms this review was worked on that differ from the lease's
   *  (leaseDepartures): any makes it a departure, written as an `other` row. */
  departures?: string[];
  /** Checks a director overrode at SUBMIT that APPLY honours later (C3 sign-off). */
  directorOverrides?: StoredOverride[];
  /** Set by submit when the basis departs from the lease: the result on the
   *  lease's own terms, to set beside the rent submitted (M3). */
  leaseTerms?: LeaseTermsResult;
  fixedPercent?: number;
  manual?: { explanation: string; newAnnual: number };
  method: CalcMethod;
  newAnnual: number;
  override?: CalcOverride;
  perMonth: number;
  perSqm: number | null;
  sanity: SanityBand;
  scheduleVersion: number;
}

export type { CascadeRow };

/** A check a director overrode, as the calc carries it to APPLY (rentReview/directorOverride.ts). */
export interface StoredOverride {
  at: string;
  by: { name: string; userId: number | null };
  check: "not_signed_off" | "out_of_band";
  reason: string;
}

/** A review worked on the lease's own terms instead of its basis: the rent and
 *  the charges that follow it, or why it can't be worked out. */
export type LeaseTermsResult =
  | { ancillaryAnnual: number; appliedPercent: number; newAnnual: number }
  | { unavailable: string };

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r4 = (n: number): number => Math.round(n * 10000) / 10000 || 0;
const r6 = (n: number): number => Math.round(n * 1_000_000) / 1_000_000;

// ── The sanity band (C5) ─────────────────────────────────────────────────────

export const DEFAULT_SANITY = { maxPercent: 15, minPercent: -5 } as const;

/**
 * REVIEW_SANITY_MIN_PERCENT / REVIEW_SANITY_MAX_PERCENT (PLAN C5, default −5 and
 * +15): an applied % outside the band goes to approval. A value that isn't a
 * percentage from −100 to 100, or a min above the max, falls back to the default.
 */
export function sanityBandFromEnv(env: NodeJS.ProcessEnv = process.env): { maxPercent: number; minPercent: number } {
  const read = (raw: string | undefined, fallback: number): number => {
    const text = (raw ?? "").trim();
    const value = text === "" ? Number.NaN : Number(text);
    return Number.isFinite(value) && value >= -100 && value <= 100 ? value : fallback;
  };
  const minPercent = read(env.REVIEW_SANITY_MIN_PERCENT, DEFAULT_SANITY.minPercent);
  const maxPercent = read(env.REVIEW_SANITY_MAX_PERCENT, DEFAULT_SANITY.maxPercent);
  return minPercent <= maxPercent ? { maxPercent, minPercent } : { ...DEFAULT_SANITY };
}

export function sanityOf(appliedPercent: number, band: { maxPercent: number; minPercent: number }): SanityBand {
  return { ...band, inBand: appliedPercent >= band.minPercent && appliedPercent <= band.maxPercent };
}

// ── The pieces ───────────────────────────────────────────────────────────────

/** ratio → clamp(1 + floor, 1 + cap) → ratchet, in the schedule engine's order
 *  (the floor first, so a cap below the floor would win; the basis forbids it). */
export function boundFactor(
  ratio: number,
  bounds: { capPercent: number | null; floorPercent: number | null; ratchet: boolean },
): { clampedBy: "cap" | "floor" | null; factor: number; ratcheted: boolean } {
  let factor = ratio;
  let clampedBy: "cap" | "floor" | null = null;
  if (bounds.floorPercent !== null && factor < 1 + bounds.floorPercent / 100) {
    factor = 1 + bounds.floorPercent / 100;
    clampedBy = "floor";
  }
  if (bounds.capPercent !== null && factor > 1 + bounds.capPercent / 100) {
    factor = 1 + bounds.capPercent / 100;
    clampedBy = "cap";
  }
  let ratcheted = false;
  if (bounds.ratchet && factor < 1) {
    factor = 1;
    ratcheted = true;
  }
  return { clampedBy, factor, ratcheted };
}

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export type CalcRefusalCode =
  | "basis_incomplete"
  | "cpi_base_mismatch"
  | "earlier_review_pending"
  | "manual_required"
  | "no_current_rent"
  | "not_representable"
  | "ratchet"
  | "step_settled";

/**
 * C9 on a lease with a ratchet: the schedule engine holds every review row of
 * such a lease at no decrease, so a lower rent can't be written. A director
 * override of the lease's ratchet needs a per-row exemption in the engine of
 * both repos (WP26c); until then it is refused for everyone, directors too.
 */
export const LEASE_RATCHET_MESSAGE =
  "This lease has a ratchet, so its rent can't go down on review, and a director can't override the lease's ratchet here yet. " +
  "To depart from the lease, a director turns the ratchet off in the lease's terms (a recorded change) and the review is calculated again.";

const money = (value: number): string => new Intl.NumberFormat("en-AU", { currency: "AUD", style: "currency" }).format(value);

/** Why the schedule can't hold a rent (L6): the lease's ratchet against a
 *  decrease, else a change past what one review row can carry (±100%). */
export function unrepresentableRent(newAnnual: number, currentAnnual: number, leaseRatchet: boolean): { code: "not_representable" | "ratchet"; message: string } {
  if (newAnnual < currentAnnual && leaseRatchet) return { code: "ratchet", message: LEASE_RATCHET_MESSAGE };
  return {
    code: "not_representable",
    message:
      `The schedule can't hold a new rent of ${money(newAnnual)} against ${money(currentAnnual)} on this lease, so it can't be applied. ` +
      "One review can't more than double the rent or take it to nothing; check the figures.",
  };
}

export type CalcResult =
  | { calc: RentReviewCalc; kind: "calc" }
  | {
      expectedIndexAt: string;
      kind: "index_pending";
      missing: string[];
      previousQuarter: string;
      referenceQuarter: string;
      region: string;
    }
  | { code: CalcRefusalCode; kind: "refused"; message: string };

export interface CalcInput {
  /** The review's basis snapshot (rentReview/basis.ts). */
  basis: Record<string, unknown>;
  carparkGroups: readonly CarparkScheduleGroup[];
  /** The basis terms that differ from the lease's (leaseDepartures); none when left out. */
  departures?: readonly string[];
  computedAt: string;
  computedBy: { name: string; userId: number | null };
  /** CpiIndex rows for the basis's region (only the two quarters matter). */
  cpiRows: readonly CpiIndexRow[];
  /** Tenants.RentPerAnnum and the tenancy's area, as the schedule engine takes them. */
  fallbackAnnual: number;
  fallbackSqm: number;
  /** The lease's terms on the tenancy: what the schedule engine computes with,
   *  and REVIEW_WORKFLOW_LIVE_FROM (a review row keyed ahead waits for its review, M2). */
  lease: { cpiCapPercent: number | null; cpiFloorPercent: number | null; reviewRatchet: boolean; workflowLiveFrom?: string | null };
  manual?: { explanation: string; newAnnual: number } | null;
  method: CalcMethod;
  miscFees: readonly MiscFee[];
  /** Id for a schedule row the review adds (when none is dated on the review date). */
  newStepId: string;
  reviewId: string;
  sanity: { maxPercent: number; minPercent: number };
  scheduledFor: string;
  scheduleVersion: number;
  /** RentReviews.StepId. */
  stepId: string | null;
  steps: readonly ScheduledRateStep[];
  /** The Darwin date the arrears run to. */
  today: string;
}

type Refused = Extract<CalcResult, { kind: "refused" }>;

const refused = (code: CalcRefusalCode, message: string): Refused => ({ code, kind: "refused", message });

interface FactorPlan {
  bounds?: CalcBounds;
  cpi?: CalcCpi;
  factor: number;
  fixedPercent?: number;
  /** The row as APPLY writes it when the review keeps to the lease. */
  natural: ScheduledRateStep;
}

/** CPI: the index pair and the bounded factor; or why it can't be worked out yet. */
function cpiFactor(input: CalcInput, base: ScheduledRateStep): FactorPlan | Exclude<CalcResult, { kind: "calc" }> {
  const region = typeof input.basis.region === "string" ? input.basis.region.toUpperCase() : null;
  if (region !== "AUS" && region !== "DARWIN") {
    return refused("basis_incomplete", "Set the CPI region (Australia or Darwin) on the review's basis before calculating.");
  }
  const interval = num(input.basis.intervalMonths);
  const reference = referenceQuarter(input.scheduledFor);
  const previous = previousQuarter(reference, interval);
  const current = input.cpiRows.find((row) => row.period === reference);
  const earlier = input.cpiRows.find((row) => row.period === previous);
  if (!current || !earlier) {
    const missing = [...(current ? [] : [reference]), ...(earlier ? [] : [previous])];
    const expectedIndexAt = missing.map(expectedRelease).sort().at(-1) as string;
    return { expectedIndexAt, kind: "index_pending", missing, previousQuarter: previous, referenceQuarter: reference, region };
  }
  if (
    current.referenceBase === null ||
    current.referenceBase !== earlier.referenceBase ||
    !(current.indexValue > 0) ||
    !(earlier.indexValue > 0)
  ) {
    return refused(
      "cpi_base_mismatch",
      `The CPI values for ${reference} and ${previous} aren't on the same index base ` +
        `(${current.referenceBase ?? "unknown"} and ${earlier.referenceBase ?? "unknown"}), so they can't be compared. ` +
        "The next CPI sync restates them; calculate again after it runs.",
    );
  }
  const capPercent = num(input.basis.capPercent);
  const floorPercent = num(input.basis.floorPercent);
  const ratchet = input.basis.ratchet === true;
  const ratio = current.indexValue / earlier.indexValue;
  const bounded = boundFactor(ratio, { capPercent, floorPercent, ratchet });
  return {
    bounds: { capPercent, clampedBy: bounded.clampedBy, floorPercent, ratchet, ratcheted: bounded.ratcheted },
    cpi: {
      current: current.indexValue,
      previous: earlier.indexValue,
      previousQuarter: previous,
      ratio: r6(ratio),
      rawPercent: r4((ratio - 1) * 100),
      referenceBase: current.referenceBase,
      referenceQuarter: reference,
      region,
    },
    factor: bounded.factor,
    natural: appliedStep(base, input.reviewId, {
      cpiValue: current.indexValue,
      cpiValuePrev: earlier.indexValue,
      methodKind: "cpi",
      ratePercent: r4((bounded.factor - 1) * 100),
    }),
  };
}

function fixedFactor(input: CalcInput, base: ScheduledRateStep): FactorPlan | Exclude<CalcResult, { kind: "calc" }> {
  const fixedPercent = num(input.basis.fixedPercent);
  if (fixedPercent === null) {
    return refused("basis_incomplete", "Set the fixed percentage on the review's basis before calculating.");
  }
  const ratchet = input.basis.ratchet === true;
  const bounded = boundFactor(1 + fixedPercent / 100, { capPercent: null, floorPercent: null, ratchet });
  return {
    bounds: { capPercent: null, clampedBy: null, floorPercent: null, ratchet, ratcheted: bounded.ratcheted },
    factor: bounded.factor,
    fixedPercent,
    natural: appliedStep(base, input.reviewId, { methodKind: "fixed", ratePercent: fixedPercent }),
  };
}

const EXPLANATION_MAX_CHARS = 2000;

/** Works out the review. See the header for the rules. */
export function calculateReview(input: CalcInput): CalcResult {
  const placed = reviewRow(input.steps, {
    method: input.method,
    newStepId: input.newStepId,
    reviewId: input.reviewId,
    scheduledFor: input.scheduledFor,
    stepId: input.stepId,
  });
  if (!placed.ok) {
    return refused("step_settled", "The schedule row on this review's date is already settled by another review, so this one can't change it.");
  }
  const context: ScheduleContext = {
    fallbackAnnual: input.fallbackAnnual,
    fallbackSqm: input.fallbackSqm,
    lease: input.lease,
    steps: input.steps,
  };

  // The rent in force on the review date before the review.
  const before = simulate(context, waivedStep(placed.base, input.reviewId));
  const row = before.row;
  if (!row || row.pending) {
    return refused(
      "earlier_review_pending",
      "An earlier review on this tenancy's schedule isn't settled yet, so the rent on this review's date isn't known. Settle that one first.",
    );
  }
  const currentAnnual = row.annual;
  if (!(currentAnnual > 0)) {
    return refused("no_current_rent", "The schedule has no rent on this review's date, so there is nothing to review. Check the schedule's starting rent.");
  }
  const area = row.areaMissing ? 0 : row.sqm;
  const departures = [...(input.departures ?? [])];

  let factor: number;
  let newAnnual: number;
  let plan: FactorPlan | null = null;
  let manual: RentReviewCalc["manual"];

  if (input.method === "other") {
    const keyed = input.manual;
    const explanation = typeof keyed?.explanation === "string" ? keyed.explanation.trim() : "";
    if (!keyed || !Number.isFinite(keyed.newAnnual) || keyed.newAnnual <= 0 || explanation === "") {
      return refused("manual_required", "An `other` review needs the new annual rent and an explanation of how it was reached.");
    }
    if (explanation.length > EXPLANATION_MAX_CHARS) {
      return refused("manual_required", `The explanation can be at most ${EXPLANATION_MAX_CHARS} characters.`);
    }
    newAnnual = r2(keyed.newAnnual);
    factor = newAnnual / currentAnnual;
    manual = { explanation, newAnnual };
  } else {
    const worked = input.method === "cpi" ? cpiFactor(input, placed.base) : fixedFactor(input, placed.base);
    if ("kind" in worked) return worked;
    plan = worked;
    factor = worked.factor;
    // The engine agrees when the review keeps to the lease: then its own figure is the new rent.
    const natural = simulate(context, worked.natural).row;
    const agrees = natural !== null && !natural.pending && natural.factor !== null && Math.abs(natural.factor - factor) < 1e-12;
    newAnnual = agrees && natural ? natural.annual : r2(currentAnnual * factor);
  }

  const appliedPercent = input.method === "other" ? r4((newAnnual / currentAnnual - 1) * 100) : r4((factor - 1) * 100);
  // The receipt is the schedule as APPLY writes this rent (rentReview/written.ts).
  const written = writtenReview({
    base: placed.base,
    before,
    bounds: plan?.bounds ? { capPercent: plan.bounds.capPercent, floorPercent: plan.bounds.floorPercent } : null,
    carparkGroups: input.carparkGroups,
    context,
    cpi: plan?.cpi ? { current: plan.cpi.current, previous: plan.cpi.previous } : null,
    currentAnnual,
    departs: departures.length > 0,
    method: input.method,
    miscFees: input.miscFees,
    naturalRate: input.method === "fixed" ? (plan?.fixedPercent ?? 0) : appliedPercent,
    reviewId: input.reviewId,
    scheduledFor: input.scheduledFor,
    target: newAnnual,
    today: input.today,
  });
  if (!written) {
    const why = unrepresentableRent(newAnnual, currentAnnual, input.lease.reviewRatchet);
    return refused(why.code, why.message);
  }

  const calc: RentReviewCalc = {
    appliedPercent,
    arrears: written.arrears,
    cascade: written.cascade,
    computedAt: input.computedAt,
    computedBy: input.computedBy,
    currentAnnual,
    departures,
    method: input.method,
    newAnnual,
    perMonth: r2(newAnnual / 12),
    perSqm: area > 0 ? r2(newAnnual / area) : null,
    sanity: sanityOf(appliedPercent, input.sanity),
    scheduleVersion: input.scheduleVersion,
    ...(plan?.cpi ? { cpi: plan.cpi } : {}),
    ...(plan?.bounds ? { bounds: plan.bounds } : {}),
    ...(plan?.fixedPercent !== undefined ? { fixedPercent: plan.fixedPercent } : {}),
    ...(manual ? { manual } : {}),
  };
  return { calc, kind: "calc" };
}

// ── Reading a stored calc ────────────────────────────────────────────────────

/** The rent the review applies and its %: the override's when there is one
 *  (its own %, never the computed one), else the computed result. */
export function chosenFigures(calc: RentReviewCalc): { appliedPercent: number; currentAnnual: number; newAnnual: number } {
  if (!calc.override) return { appliedPercent: calc.appliedPercent, currentAnnual: calc.currentAnnual, newAnnual: calc.newAnnual };
  const newAnnual = calc.override.newAnnual;
  return {
    appliedPercent: calc.override.appliedPercent ?? r4((newAnnual / calc.currentAnnual - 1) * 100),
    currentAnnual: calc.currentAnnual,
    newAnnual,
  };
}

/** Why a submitted review needs a second person, from its calc alone (E3's headline). */
export function approvalReasonsOf(calc: RentReviewCalc): string[] {
  return [
    ...(calc.override ? ["override"] : []),
    ...(calc.sanity && !calc.sanity.inBand ? ["out_of_band"] : []),
    ...(calc.method === "other" ? ["manual_method"] : []),
    ...((calc.departures?.length ?? 0) > 0 ? ["basis_departs_from_lease"] : []),
    ...(isReduction(calc) ? ["reduction"] : []),
  ];
}

/** The review lowers the rent (A3): never applied in one step, and only a director approves it. */
export function isReduction(calc: RentReviewCalc): boolean {
  return chosenFigures(calc).newAnnual < calc.currentAnnual;
}

/** The charges that follow the rent as the review applies them: the chosen
 *  rent's cascade when there is an override, else the computed one. */
export function appliedCascade(calc: RentReviewCalc | null): CascadeRow[] {
  if (!calc) return [];
  return calc.override?.cascade ?? calc.cascade ?? [];
}

/** RentReviews.Calc as a calc, or null when it is empty or not one. */
export function parseCalc(raw: unknown): RentReviewCalc | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const calc = parsed as Partial<RentReviewCalc>;
    const methods: readonly unknown[] = ["cpi", "fixed", "other"];
    return methods.includes(calc.method) &&
      typeof calc.newAnnual === "number" &&
      typeof calc.currentAnnual === "number" &&
      typeof calc.scheduleVersion === "number"
      ? (calc as RentReviewCalc)
      : null;
  } catch {
    return null;
  }
}

// ── Is it the lease? (SUBMIT's one-step rule) ────────────────────────────────

export interface LeaseTermsForReview {
  cpiCapPercent: number | null;
  cpiFloorPercent: number | null;
  cpiRegion: string | null;
  /** The lease's fixed %: Tenants.FixedReviewPercent, else the fixed step's rate. */
  fixedPercent: number | null;
  reviewIntervalMonths: number | null;
  reviewRatchet: boolean;
}

const sameNumber = (a: number | null | undefined, b: number | null | undefined): boolean =>
  (a ?? null) === null ? (b ?? null) === null : (b ?? null) !== null && Math.abs((a as number) - (b as number)) < 1e-9;

/** The lease's own terms as a basis for `method`: what leaseDepartures compares
 *  a review's basis with, so a review worked on it departs from nothing. */
export function leaseBasis(method: "cpi" | "fixed", lease: LeaseTermsForReview, reviewDate: string): Record<string, unknown> {
  const common = { intervalMonths: lease.reviewIntervalMonths ?? 12, method, ratchet: lease.reviewRatchet, reviewDate };
  if (method === "fixed") return { ...common, fixedPercent: lease.fixedPercent };
  const region = lease.cpiRegion?.trim().toUpperCase() || null;
  return { ...common, capPercent: lease.cpiCapPercent, floorPercent: lease.cpiFloorPercent, referenceQuarterRule: "quarter_before_review_date", region };
}

/**
 * The terms a review was worked on that differ from the lease's: an applied
 * review may only be one step when there are none (D3: "unchanged %"; an edited
 * basis is a departure, so it needs a second person). An `other` review always
 * goes to approval and isn't checked here.
 */
export function leaseDepartures(method: CalcMethod, basis: Record<string, unknown>, lease: LeaseTermsForReview): string[] {
  const departures: string[] = [];
  if ((basis.ratchet === true) !== lease.reviewRatchet) departures.push("ratchet");
  if (method === "cpi") {
    if (!sameNumber(num(basis.capPercent), lease.cpiCapPercent)) departures.push("capPercent");
    if (!sameNumber(num(basis.floorPercent), lease.cpiFloorPercent)) departures.push("floorPercent");
    const region = typeof basis.region === "string" ? basis.region.toUpperCase() : null;
    if (region !== (lease.cpiRegion?.trim().toUpperCase() || null)) departures.push("region");
    if (!sameNumber(num(basis.intervalMonths) ?? 12, lease.reviewIntervalMonths ?? 12)) departures.push("intervalMonths");
  }
  if (method === "fixed" && !sameNumber(num(basis.fixedPercent), lease.fixedPercent)) departures.push("fixedPercent");
  return departures;
}
