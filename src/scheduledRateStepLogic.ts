import { randomUUID } from "node:crypto";
import { addDaysIso, isIsoDate } from "./darwinDate";

export type RentScheduleMethodKind =
  | "cpi"
  | "commencement"
  | "fixed"
  | "market"
  | "other";

/** How a rent review settled a step: "applied" = its values stand (a market
 *  review agreed at 0% included); "waived" = no change to the rent. */
export type StepResolution = "applied" | "waived";

/** A director's override of the lease's ratchet for one review row (C9, D23):
 *  the engine applies that row's own factor even when it lowers the rent. Written
 *  only by a rent review a director approved with the ratchet overridden. */
export interface RatchetExemption {
  /** When the director overrode it (ISO timestamp or date). */
  at: string;
  byName: string;
  reason: string;
}

export interface ScheduledRateStep {
  id: string;
  /** Starting AHAC ph annual amount, set on commencement rows. Reviews at the same rate as rent. */
  ahacBasePerAnnum?: number;
  /** Starting annual rent for commencement rows — the origin the schedule builds from. */
  baseRentPerAnnum?: number;
  /** Total leaseable area (m²) for this period. Used to compute per-m² rate. */
  sqm?: number;
  effectiveFrom: string; // ISO date e.g. "2026-07-01"
  effectiveTo?: string;  // ISO date — end of this period (exclusive)
  methodKind?: RentScheduleMethodKind;
  /** Raw CPI index value for this period (e.g. 115.6). Present when methodKind="cpi". */
  cpiValue?: number;
  /** CPI index value from the previous period — stored explicitly so edits are stable. */
  cpiValuePrev?: number;
  /** Increase % from the previous period. 0 allowed for commencement rows. */
  ratePercent: number;
  note?: string;
  flagComment?: string;
  /** The RentReviews row that settled this step (RentReviews.ReviewId). */
  reviewId?: string;
  /** Set when a review settled the step; review rows only. */
  resolution?: StepResolution;
  /** The lease's ratchet doesn't hold this row (a director's override); review rows only. */
  ratchetExempt?: RatchetExemption;
}

export interface StepValidationOk {
  ok: true;
  step: ScheduledRateStep;
}

export interface StepValidationErr {
  ok: false;
  error: string;
}

export type StepValidationResult = StepValidationOk | StepValidationErr;

const UUID_RE = /^[0-9a-f-]{36}$/i;
// YYYY-MM-DD
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX_LEN = 300;
const RATE_MIN = -100;
const RATE_MAX = 100;
/** RentReviews.ReviewId is NVARCHAR(40). */
const REVIEW_ID_MAX_LEN = 40;
const RESOLUTIONS: ReadonlySet<string> = new Set(["applied", "waived"]);

const METHOD_KINDS: ReadonlySet<string> = new Set([
  "cpi",
  "commencement",
  "fixed",
  "market",
  "other",
]);

const ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "id",
  "ahacBasePerAnnum",
  "baseRentPerAnnum",
  "sqm",
  "effectiveFrom",
  "effectiveTo",
  "methodKind",
  "cpiValue",
  "cpiValuePrev",
  "ratePercent",
  "note",
  "flagComment",
  "reviewId",
  "resolution",
  "ratchetExempt",
]);

const EXEMPTION_NAME_MAX = 200;
const EXEMPTION_AT_MAX = 40;
const EXEMPTION_REASON_MAX = 2000;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function isUuidShaped(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** A step's ratchetExempt: { byName, at, reason }, each a non-empty string. */
export function validateRatchetExemption(raw: unknown): { ok: true; exemption: RatchetExemption } | StepValidationErr {
  if (!isPlainObject(raw)) return { ok: false, error: "ratchetExempt must be { byName, at, reason }" };
  const extra = Object.keys(raw).find((key) => key !== "byName" && key !== "at" && key !== "reason");
  if (extra) return { ok: false, error: `Unknown key on ratchetExempt: ${extra}` };
  const text = (value: unknown, max: number): string | null =>
    typeof value === "string" && value.trim() !== "" && value.trim().length <= max ? value.trim() : null;
  const byName = text(raw.byName, EXEMPTION_NAME_MAX);
  const at = text(raw.at, EXEMPTION_AT_MAX);
  const reason = text(raw.reason, EXEMPTION_REASON_MAX);
  if (byName === null) return { ok: false, error: `ratchetExempt.byName must be a name of at most ${EXEMPTION_NAME_MAX} chars` };
  if (at === null || Number.isNaN(Date.parse(at))) return { ok: false, error: "ratchetExempt.at must be an ISO date or timestamp" };
  if (reason === null) return { ok: false, error: `ratchetExempt.reason must be a reason of at most ${EXEMPTION_REASON_MAX} chars` };
  return { ok: true, exemption: { at, byName, reason } };
}

export function validateStep(raw: unknown): StepValidationResult {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "step must be an object" };
  }

  for (const key of Object.keys(raw)) {
    if (!ALLOWED_KEYS.has(key)) {
      return { ok: false, error: `Unknown key on step: ${key}` };
    }
  }

  const { id, ahacBasePerAnnum, baseRentPerAnnum, sqm, effectiveFrom, effectiveTo, methodKind, cpiValue, cpiValuePrev, ratePercent, note, flagComment, reviewId, resolution, ratchetExempt } = raw;

  if (id !== undefined && id !== "") {
    if (!isUuidShaped(id)) {
      return { ok: false, error: "id must be a UUID-shaped string" };
    }
  }

  if (!isIsoDate(effectiveFrom)) {
    return { ok: false, error: "effectiveFrom must be an ISO date string (YYYY-MM-DD)" };
  }

  if (effectiveTo !== undefined) {
    if (!isIsoDate(effectiveTo)) {
      return { ok: false, error: "effectiveTo must be an ISO date string (YYYY-MM-DD)" };
    }
    // Exclusive end: the first day the row no longer applies.
    if (effectiveTo <= effectiveFrom) {
      return { ok: false, error: "effectiveTo must be after effectiveFrom" };
    }
  }

  if (ahacBasePerAnnum !== undefined) {
    if (typeof ahacBasePerAnnum !== "number" || !Number.isFinite(ahacBasePerAnnum) || ahacBasePerAnnum < 0) {
      return { ok: false, error: "ahacBasePerAnnum must be a non-negative number" };
    }
  }

  if (baseRentPerAnnum !== undefined) {
    if (typeof baseRentPerAnnum !== "number" || !Number.isFinite(baseRentPerAnnum) || baseRentPerAnnum < 0) {
      return { ok: false, error: "baseRentPerAnnum must be a non-negative number" };
    }
  }

  if (sqm !== undefined) {
    if (typeof sqm !== "number" || !Number.isFinite(sqm) || sqm < 0) {
      return { ok: false, error: "sqm must be a non-negative number" };
    }
  }

  if (methodKind !== undefined) {
    if (!METHOD_KINDS.has(methodKind as string)) {
      return { ok: false, error: `methodKind must be one of: ${[...METHOD_KINDS].join(", ")}` };
    }
  }

  if (cpiValue !== undefined) {
    if (typeof cpiValue !== "number" || !Number.isFinite(cpiValue) || cpiValue <= 0) {
      return { ok: false, error: "cpiValue must be a positive number" };
    }
  }

  if (cpiValuePrev !== undefined) {
    if (typeof cpiValuePrev !== "number" || !Number.isFinite(cpiValuePrev) || cpiValuePrev <= 0) {
      return { ok: false, error: "cpiValuePrev must be a positive number" };
    }
  }

  if (
    typeof ratePercent !== "number" ||
    !Number.isFinite(ratePercent) ||
    ratePercent < RATE_MIN ||
    ratePercent > RATE_MAX
  ) {
    return {
      ok: false,
      error: `ratePercent must be a number in [${RATE_MIN}, ${RATE_MAX}]`,
    };
  }

  if (note !== undefined) {
    if (typeof note !== "string") return { ok: false, error: "note must be a string" };
    if (note.length > NOTE_MAX_LEN) {
      return { ok: false, error: `note must be ≤${NOTE_MAX_LEN} chars` };
    }
  }

  if (flagComment !== undefined) {
    if (typeof flagComment !== "string") return { ok: false, error: "flagComment must be a string" };
    if (flagComment.length > NOTE_MAX_LEN) {
      return { ok: false, error: `flagComment must be ≤${NOTE_MAX_LEN} chars` };
    }
  }

  if (reviewId !== undefined) {
    if (typeof reviewId !== "string" || reviewId.trim() === "" || reviewId.length > REVIEW_ID_MAX_LEN) {
      return { ok: false, error: `reviewId must be a non-empty string of at most ${REVIEW_ID_MAX_LEN} chars` };
    }
  }

  if (resolution !== undefined) {
    if (typeof resolution !== "string" || !RESOLUTIONS.has(resolution)) {
      return { ok: false, error: "resolution must be one of: applied, waived" };
    }
    if (methodKind === "commencement") {
      return { ok: false, error: "resolution applies to review rows, not commencement rows" };
    }
  }

  let exemption: RatchetExemption | undefined;
  if (ratchetExempt !== undefined) {
    if (methodKind === "commencement") {
      return { ok: false, error: "ratchetExempt applies to review rows, not commencement rows" };
    }
    const checked = validateRatchetExemption(ratchetExempt);
    if (!checked.ok) return checked;
    exemption = checked.exemption;
  }

  const normalised: ScheduledRateStep = {
    effectiveFrom,
    id: typeof id === "string" && id !== "" ? id : randomUUID(),
    ratePercent,
  };
  if (ahacBasePerAnnum !== undefined) normalised.ahacBasePerAnnum = ahacBasePerAnnum as number;
  if (baseRentPerAnnum !== undefined) normalised.baseRentPerAnnum = baseRentPerAnnum as number;
  if (sqm !== undefined) normalised.sqm = sqm as number;
  if (effectiveTo !== undefined) normalised.effectiveTo = effectiveTo as string;
  if (methodKind !== undefined) normalised.methodKind = methodKind as RentScheduleMethodKind;
  if (cpiValue !== undefined) normalised.cpiValue = cpiValue as number;
  if (cpiValuePrev !== undefined) normalised.cpiValuePrev = cpiValuePrev as number;
  if (note !== undefined) normalised.note = note as string;
  if (flagComment !== undefined) normalised.flagComment = flagComment as string;
  if (reviewId !== undefined) normalised.reviewId = reviewId as string;
  if (resolution !== undefined) normalised.resolution = resolution as StepResolution;
  if (exemption !== undefined) normalised.ratchetExempt = exemption;
  return { ok: true, step: normalised };
}

export function validateUpsertStepEnvelope(body: unknown):
  | { ok: true; TenantId: number; BuildingId: number; step: ScheduledRateStep }
  | StepValidationErr {
  if (!isPlainObject(body)) return { ok: false, error: "body must be an object" };
  const { TenantId, BuildingId } = body;
  if (typeof TenantId !== "number" || !Number.isInteger(TenantId) || TenantId <= 0) {
    return { ok: false, error: "TenantId must be a positive integer" };
  }
  if (typeof BuildingId !== "number" || !Number.isInteger(BuildingId) || BuildingId <= 0) {
    return { ok: false, error: "BuildingId must be a positive integer" };
  }
  const result = validateStep(body.step);
  if (!result.ok) return result;
  return { ok: true, TenantId: TenantId as number, BuildingId: BuildingId as number, step: result.step };
}

export function validateDeleteStepEnvelope(body: unknown):
  | { ok: true; TenantId: number; BuildingId: number; stepId: string }
  | StepValidationErr {
  if (!isPlainObject(body)) return { ok: false, error: "body must be an object" };
  const { TenantId, BuildingId, stepId } = body;
  if (typeof TenantId !== "number" || !Number.isInteger(TenantId) || TenantId <= 0) {
    return { ok: false, error: "TenantId must be a positive integer" };
  }
  if (typeof BuildingId !== "number" || !Number.isInteger(BuildingId) || BuildingId <= 0) {
    return { ok: false, error: "BuildingId must be a positive integer" };
  }
  if (!isUuidShaped(stepId)) {
    return { ok: false, error: "stepId must be a UUID-shaped string" };
  }
  return { ok: true, TenantId: TenantId as number, BuildingId: BuildingId as number, stepId: stepId as string };
}

// ── Schedule engine — mirror of FE src/helpers/rentScheduleCore.ts ───────────
//
// Every rule change lands in both repos; the parity fixtures
// (src/__tests__/rent-schedule-parity.fixtures.json here,
// src/__tests__/helpers/rent-schedule-parity.fixtures.json in command-centre)
// are identical and asserted by Jest on both sides.
//
//  • Rent and AHAC compound on the annual amount. An explicit area on a row
//    rescales from that row on at the prevailing $/m²; a row without one
//    carries the last explicit area. The tenancy's current area never enters
//    the rent — it is only the display fallback for $/m².
//  • A review's factor (PLAN §3.2): the CPI index ratio (or 1 + rate %),
//    clamped to the lease's CPI floor and cap on CPI rows, then held at ≥ 1 on
//    any review row when the lease has the ratchet ("no rent decreases on
//    review"), except a row carrying ratchetExempt (a director's override of the
//    lease's ratchet for that row alone, C9 / D23). A waived review has factor 1.
//    Car parks and misc fees that follow the rent take the same factor.
//  • A review row whose own value is unknown (CPI index missing, market/other
//    rate not set) is pending, and so is every row after it until the next
//    commencement row. A row a review settled (resolution) is never pending on
//    its own account. Once the rent review workflow is live
//    (terms.workflowLiveFrom, REVIEW_WORKFLOW_LIVE_FROM), an unsettled review
//    row dated on or after that day is pending too ("awaiting_review"), even
//    when its rate was keyed ahead: the rent moves only when a review applies
//    the row, so its arrears are never counted twice (independent review M2).
//  • effectiveTo is the exclusive end of a row (the first day it no longer
//    applies).
//  • The current row is the latest non-pending row with effectiveFrom ≤ today
//    (the Darwin date).
//  • Rent relief is not a row: it is an overlay on these figures
//    (scheduleCharges.ts), so the rows always say what the lease says.

const r2 = (n: number) => Math.round(n * 100) / 100;
const r4 = (n: number) => Math.round(n * 10000) / 10000;

export type SchedulePendingReason =
  | "awaiting_review"
  | "cpi_index_missing"
  | "earlier_review_pending"
  | "rate_not_set";

/** The lease terms the schedule computes with (Tenants columns). */
export interface ScheduleTerms {
  /** CPI reviews increase by at most this %. */
  cpiCapPercent?: number | null;
  /** CPI reviews increase by at least this %. */
  cpiFloorPercent?: number | null;
  /** No rent decreases on review: every review's factor is at least 1. */
  reviewRatchet?: boolean | null;
  /** REVIEW_WORKFLOW_LIVE_FROM (YYYY-MM-DD) once reviews run through the
   *  workflow; null or absent while they are keyed by hand. */
  workflowLiveFrom?: string | null;
}

export interface ScheduleRow {
  ahacAnnual: number | null;
  annual: number;
  /** Increase % the row applies, after cap, floor and ratchet (4 dp); 0 on a
   *  waived row; null on commencement and pending rows. */
  appliedPercent: number | null;
  /** No area to derive $/m² from — rent is still shown, never $0. */
  areaMissing: boolean;
  /** The lease's CPI cap lowered this row's increase. */
  capApplied: boolean;
  /** CPI baseline this row ratios against (explicit cpiValuePrev, else the last recorded index). */
  cpiBaseline: number | null;
  /** Multiplier applied to running amounts; null on commencement and pending rows. */
  factor: number | null;
  /** The lease's CPI floor raised this row's increase. */
  floorApplied: boolean;
  monthly: number;
  /** Amounts unknown until the review (or an earlier one) is settled. */
  pending: boolean;
  pendingReason: SchedulePendingReason | null;
  /** The ratchet stopped this review lowering the rent. */
  ratchetApplied: boolean;
  /** Increase % before cap, floor and ratchet (4 dp); null on commencement and
   *  pending rows, and on a waived row whose index or rate was never set. */
  rawPercent: number | null;
  sqm: number;
  sqmRate: number;
  step: ScheduledRateStep;
}

/** What the tenancy is paying today under its schedule. "base" = before the
 *  first review row when the schedule has no commencement row. */
export type CurrentRent =
  | { kind: "base" }
  | { kind: "notStarted"; startsOn: string }
  | { kind: "pending" }
  | { kind: "row"; row: ScheduleRow };

export function sortSteps(steps: ScheduledRateStep[]): ScheduledRateStep[] {
  return [...steps].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
}

/** The step's own value is unknown: a CPI row without its index, or a market
 *  or other row without its rate. */
function ownValueMissing(step: ScheduledRateStep): SchedulePendingReason | null {
  if (step.methodKind === "cpi" && step.cpiValue == null) return "cpi_index_missing";
  if ((step.methodKind === "market" || step.methodKind === "other") && step.ratePercent === 0) {
    return "rate_not_set";
  }
  return null;
}

/** Why a review row can't be computed on its own, or null when it can. A row
 *  a review settled (applied or waived) never waits. With the workflow live
 *  (`workflowLiveFrom`), an unsettled review row dated on or after that day
 *  waits for its review whatever was keyed on it. */
export function stepPendingReason(step: ScheduledRateStep, workflowLiveFrom: string | null = null): SchedulePendingReason | null {
  if (step.resolution) return null;
  if (workflowLiveFrom !== null && step.methodKind !== "commencement" && step.effectiveFrom >= workflowLiveFrom) {
    return "awaiting_review";
  }
  return ownValueMissing(step);
}

/** CPI uses the exact index ratio when both values are known; the stored
 *  ratePercent is truncated to 4 dp and would compound into a visible error. */
function reviewFactor(step: ScheduledRateStep, cpiBaseline: number | null): number {
  return step.methodKind === "cpi" && step.cpiValue != null && cpiBaseline != null
    ? step.cpiValue / cpiBaseline
    : 1 + step.ratePercent / 100;
}

interface ReviewOutcome {
  capApplied: boolean;
  factor: number;
  floorApplied: boolean;
  ratchetApplied: boolean;
  rawFactor: number | null;
}

/** Index ratio → clamp(1 + floor, 1 + cap) on CPI rows → ratchet (§3.2). */
function reviewOutcome(
  step: ScheduledRateStep,
  cpiBaseline: number | null,
  terms: ScheduleTerms,
): ReviewOutcome {
  const settled = { capApplied: false, floorApplied: false, ratchetApplied: false };
  if (step.resolution === "waived") {
    const rawFactor = ownValueMissing(step) === null ? reviewFactor(step, cpiBaseline) : null;
    return { ...settled, factor: 1, rawFactor };
  }
  const rawFactor = reviewFactor(step, cpiBaseline);
  let factor = rawFactor;
  if (step.methodKind === "cpi") {
    if (terms.cpiFloorPercent != null && factor < 1 + terms.cpiFloorPercent / 100) {
      factor = 1 + terms.cpiFloorPercent / 100;
      settled.floorApplied = true;
    }
    if (terms.cpiCapPercent != null && factor > 1 + terms.cpiCapPercent / 100) {
      factor = 1 + terms.cpiCapPercent / 100;
      settled.capApplied = true;
    }
  }
  if (terms.reviewRatchet && factor < 1 && !step.ratchetExempt) {
    factor = 1;
    settled.ratchetApplied = true;
  }
  return { ...settled, factor, rawFactor };
}

/** A factor as an increase % to 4 dp (1.03 → 3); `|| 0` turns -0 into 0. */
const percentOf = (factor: number | null) =>
  factor === null ? null : r4((factor - 1) * 100) || 0;

export function computeScheduleRows(
  steps: ScheduledRateStep[],
  fallbackAnnual: number,
  fallbackSqm: number,
  terms: ScheduleTerms = {},
): ScheduleRow[] {
  const fallbackArea = fallbackSqm > 0 ? fallbackSqm : 0;
  let annual = fallbackAnnual;
  let area: number | null = null;
  let rate: number | null = null;
  let ahac: number | null = null;
  let ahacRate: number | null = null;
  let prevCpi: number | null = null;
  let pendingCascade = false;
  const rows: ScheduleRow[] = [];

  const emit = (
    step: ScheduledRateStep,
    pendingReason: SchedulePendingReason | null,
    shownArea: number,
    cpiBaseline: number | null,
    outcome: ReviewOutcome | null,
  ) => {
    const pending = pendingReason !== null;
    const settled = pending ? null : outcome;
    rows.push({
      ahacAnnual: pending || ahac === null ? null : r2(ahac),
      annual: pending ? 0 : r2(annual),
      appliedPercent: settled ? percentOf(settled.factor) : null,
      areaMissing: shownArea <= 0,
      capApplied: settled?.capApplied ?? false,
      cpiBaseline,
      factor: settled ? settled.factor : null,
      floorApplied: settled?.floorApplied ?? false,
      monthly: pending ? 0 : r2(annual / 12),
      pending,
      pendingReason,
      ratchetApplied: settled?.ratchetApplied ?? false,
      rawPercent: settled ? percentOf(settled.rawFactor) : null,
      sqm: shownArea,
      sqmRate: pending || shownArea <= 0 ? 0 : r2(annual / shownArea),
      step,
    });
  };

  for (const step of sortSteps(steps)) {
    const explicitArea = typeof step.sqm === "number" && step.sqm > 0 ? step.sqm : null;
    const cpiBaseline = step.cpiValuePrev ?? prevCpi;

    if (step.methodKind === "commencement") {
      pendingCascade = false;
      if (step.baseRentPerAnnum != null) annual = step.baseRentPerAnnum;
      if (step.ahacBasePerAnnum != null) ahac = step.ahacBasePerAnnum;
      if (explicitArea !== null) area = explicitArea;
      rate = area !== null ? annual / area : null;
      ahacRate = area !== null && ahac !== null ? ahac / area : null;
      if (step.cpiValue != null) prevCpi = step.cpiValue;
      emit(step, null, area ?? fallbackArea, cpiBaseline, null);
      continue;
    }

    const ownReason = stepPendingReason(step, terms.workflowLiveFrom ?? null);
    if (ownReason !== null) pendingCascade = true;
    if (pendingCascade) {
      emit(step, ownReason ?? "earlier_review_pending", explicitArea ?? area ?? fallbackArea, cpiBaseline, null);
      continue;
    }

    const outcome = reviewOutcome(step, cpiBaseline, terms);
    const { factor } = outcome;
    if (area !== null && rate !== null) {
      rate *= factor;
      if (explicitArea !== null) area = explicitArea;
      annual = rate * area;
      if (ahacRate !== null) {
        ahacRate *= factor;
        ahac = ahacRate * area;
      }
    } else {
      annual *= factor;
      if (ahac !== null) ahac *= factor;
      if (explicitArea !== null) {
        area = explicitArea;
        rate = annual / area;
        ahacRate = ahac !== null ? ahac / area : null;
      }
    }
    if (step.cpiValue != null) prevCpi = step.cpiValue;
    emit(step, null, area ?? fallbackArea, cpiBaseline, outcome);
  }

  return rows;
}

/** Current rule (both repos): the latest non-pending row with effectiveFrom ≤
 *  today wins. Before any such row, a schedule without a commencement row is
 *  still on its base rent; one that opens with a future commencement hasn't
 *  started. */
export function resolveCurrentRent(
  rows: ScheduleRow[],
  fallbackAnnual: number,
  today: string,
): CurrentRent {
  let current: ScheduleRow | null = null;
  for (const row of rows) {
    if (row.step.effectiveFrom > today) break;
    if (!row.pending) current = row;
  }
  if (current) return { kind: "row", row: current };
  const first = rows[0];
  if (!first) return { kind: "base" };
  if (first.step.methodKind !== "commencement" && fallbackAnnual > 0) return { kind: "base" };
  if (first.step.effectiveFrom > today) return { kind: "notStarted", startsOn: first.step.effectiveFrom };
  return { kind: "pending" };
}

export interface ResolvedScheduleAnnual {
  /** Annual rent payable today; 0 when the schedule hasn't started or is pending. */
  annual: number;
  /** First schedule date when the schedule hasn't started yet. */
  startsOn: string | null;
}

/**
 * Today's annual rent under the schedule (`today` is the Darwin date). Mirrors
 * FE `resolveScheduleRent`, so the backend's `effectiveRentPerAnnum` /
 * `monthlyRental` / `dollarsToExpiry` agree with what the register shows.
 * A tenancy with no rows pays its stored `fallbackAnnual`.
 */
export function resolveScheduleAnnual(
  steps: ScheduledRateStep[],
  fallbackAnnual: number,
  sqm: number,
  today: string,
  terms: ScheduleTerms = {},
): ResolvedScheduleAnnual {
  if (steps.length === 0) return { annual: fallbackAnnual, startsOn: null };
  const current = resolveCurrentRent(computeScheduleRows(steps, fallbackAnnual, sqm, terms), fallbackAnnual, today);
  if (current.kind === "row") return { annual: current.row.annual, startsOn: null };
  if (current.kind === "base") return { annual: r2(fallbackAnnual), startsOn: null };
  return { annual: 0, startsOn: current.kind === "notStarted" ? current.startsOn : null };
}

// ── Row ends (effectiveTo is exclusive) ──────────────────────────────────────

/**
 * Rows written before WP23a stored an inclusive last day (the day before the
 * next row starts). A one-day gap before the next row can only be such an
 * end, so it is read as ending where the next row starts. Applied by
 * parseSteps, so reads return — and the next write stores — exclusive ends.
 */
export function normaliseLegacyEnds(steps: ScheduledRateStep[]): ScheduledRateStep[] {
  const sorted = sortSteps(steps);
  const closedAt = new Map<string, string>();
  for (let i = 0; i < sorted.length - 1; i++) {
    const { effectiveTo, id } = sorted[i];
    const nextStart = sorted[i + 1].effectiveFrom;
    if (effectiveTo && isIsoDate(effectiveTo) && addDaysIso(effectiveTo, 1) === nextStart) {
      closedAt.set(id, nextStart);
    }
  }
  if (closedAt.size === 0) return steps;
  return steps.map((step) => {
    const effectiveTo = closedAt.get(step.id);
    return effectiveTo ? { ...step, effectiveTo } : step;
  });
}

/** Adding a row closes the open-ended row before it: that row now ends
 *  (exclusively) where the new one starts. Returns the row it closed. */
export function closeOpenPredecessor(
  existing: ScheduledRateStep[],
  incoming: ScheduledRateStep,
): { closed: { after: ScheduledRateStep; before: ScheduledRateStep } | null; steps: ScheduledRateStep[] } {
  if (existing.some((s) => s.id === incoming.id)) return { closed: null, steps: existing };
  const predecessor = sortSteps(existing)
    .filter((s) => s.effectiveFrom < incoming.effectiveFrom)
    .at(-1);
  if (!predecessor || predecessor.effectiveTo) return { closed: null, steps: existing };
  const after = { ...predecessor, effectiveTo: incoming.effectiveFrom };
  return {
    closed: { after, before: predecessor },
    steps: existing.map((s) => (s.id === predecessor.id ? after : s)),
  };
}

export function parseSteps(raw: string | null | undefined): ScheduledRateStep[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return normaliseLegacyEnds(
      parsed.filter(
        (s): s is ScheduledRateStep =>
          isPlainObject(s) &&
          typeof s.id === "string" &&
          typeof s.effectiveFrom === "string" &&
          typeof s.ratePercent === "number",
      ),
    );
  } catch {
    return [];
  }
}

export function upsertStep(
  existing: ScheduledRateStep[],
  incoming: ScheduledRateStep,
): ScheduledRateStep[] {
  const idx = existing.findIndex((s) => s.id === incoming.id);
  if (idx === -1) return [...existing, incoming];
  const next = existing.slice();
  // Fields the client omits stay as stored (the edit dialog doesn't send them).
  const prev = existing[idx];
  next[idx] = {
    ...incoming,
    ...(incoming.sqm === undefined && prev.sqm !== undefined && { sqm: prev.sqm }),
    ...(incoming.flagComment === undefined && prev.flagComment !== undefined && { flagComment: prev.flagComment }),
    ...(incoming.reviewId === undefined && prev.reviewId !== undefined && { reviewId: prev.reviewId }),
    ...(incoming.resolution === undefined && prev.resolution !== undefined && { resolution: prev.resolution }),
  };
  return next;
}

export const NOT_FOUND: unique symbol = Symbol("step-not-found");

export function deleteStep(
  existing: ScheduledRateStep[],
  id: string,
): ScheduledRateStep[] | typeof NOT_FOUND {
  const idx = existing.findIndex((s) => s.id === id);
  if (idx === -1) return NOT_FOUND;
  const next = existing.slice();
  next.splice(idx, 1);
  return next;
}

// ── Change log diff ───────────────────────────────────────────────────────────

export type StepDiff = Record<string, { from: unknown; to: unknown }>;

const DIFF_FIELDS: ReadonlyArray<keyof ScheduledRateStep> = [
  "effectiveFrom",
  "effectiveTo",
  "methodKind",
  "ratePercent",
  "baseRentPerAnnum",
  "ahacBasePerAnnum",
  "sqm",
  "cpiValue",
  "cpiValuePrev",
  "note",
  "flagComment",
  "reviewId",
  "resolution",
  "ratchetExempt",
];

/** Field values compared by what they hold, key order aside: ratchetExempt is an object. */
const sameValue = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (typeof a !== "object" || a === null || typeof b !== "object" || b === null) return false;
  const sorted = (value: object) => JSON.stringify(Object.entries(value).sort(([x], [y]) => x.localeCompare(y)));
  return sorted(a) === sorted(b);
};

export function diffSteps(
  prev: ScheduledRateStep,
  next: ScheduledRateStep,
): StepDiff | null {
  const diff: StepDiff = {};
  for (const field of DIFF_FIELDS) {
    const from = prev[field];
    const to = next[field];
    if (!sameValue(from, to)) {
      diff[field] = { from: from ?? null, to: to ?? null };
    }
  }
  return Object.keys(diff).length > 0 ? diff : null;
}

// ── Carpark schedule groups (m057) ────────────────────────────────────────────

export interface CarparkRateStep {
  id: string;
  /** Must match a rent schedule row's effectiveFrom. */
  effectiveFrom: string;
  methodKind?: RentScheduleMethodKind;
  /** New monthly total when methodKind is undefined (manual reset). */
  newMonthlyRate?: number;
  /** CPI index value (new period) when methodKind === "cpi". */
  cpiValue?: number;
  /** CPI index value from the previous period — stored explicitly so edits are stable. */
  cpiValuePrev?: number;
  /** Rate % when methodKind is fixed / market / other. */
  ratePercent?: number;
  note?: string;
}

export interface CarparkScheduleGroup {
  id: string;
  label: string;
  carparkIds: string[];
  /** Starting total monthly rate for the group. */
  baseMonthlyRate: number;
  /** ISO date (YYYY-MM-DD) — which schedule period this group first applies from. */
  commencedAt: string;
  /** Manual rate overrides for specific review dates. */
  rateSteps?: CarparkRateStep[];
}

const LABEL_MAX = 200;
const CARPARK_IDS_MAX = 100;

const GROUP_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "id", "label", "carparkIds", "baseMonthlyRate", "commencedAt", "rateSteps",
]);

const RATE_STEP_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "id", "effectiveFrom", "methodKind", "newMonthlyRate", "cpiValue", "cpiValuePrev", "ratePercent", "note",
]);

const VALID_METHOD_KINDS = new Set<string>(["cpi", "commencement", "fixed", "market", "other"]);

function validateCarparkRateStep(raw: unknown, idx: number): { ok: true; step: CarparkRateStep } | StepValidationErr {
  if (!isPlainObject(raw)) return { ok: false, error: `rateSteps[${idx}] must be an object` };
  for (const key of Object.keys(raw)) {
    if (!RATE_STEP_ALLOWED_KEYS.has(key)) return { ok: false, error: `Unknown key on rateStep[${idx}]: ${key}` };
  }
  const { id, effectiveFrom, methodKind, newMonthlyRate, cpiValue, cpiValuePrev, ratePercent, note } = raw;
  if (!isUuidShaped(id)) return { ok: false, error: `rateSteps[${idx}].id must be a UUID` };
  if (typeof effectiveFrom !== "string" || !ISO_DATE_RE.test(effectiveFrom)) return { ok: false, error: `rateSteps[${idx}].effectiveFrom must be YYYY-MM-DD` };
  if (methodKind !== undefined && (typeof methodKind !== "string" || !VALID_METHOD_KINDS.has(methodKind))) return { ok: false, error: `rateSteps[${idx}].methodKind is invalid` };
  if (newMonthlyRate !== undefined && (typeof newMonthlyRate !== "number" || !Number.isFinite(newMonthlyRate) || newMonthlyRate < 0)) return { ok: false, error: `rateSteps[${idx}].newMonthlyRate must be a non-negative number` };
  if (cpiValue !== undefined && (typeof cpiValue !== "number" || !Number.isFinite(cpiValue) || cpiValue <= 0)) return { ok: false, error: `rateSteps[${idx}].cpiValue must be a positive number` };
  if (cpiValuePrev !== undefined && (typeof cpiValuePrev !== "number" || !Number.isFinite(cpiValuePrev) || cpiValuePrev <= 0)) return { ok: false, error: `rateSteps[${idx}].cpiValuePrev must be a positive number` };
  if (ratePercent !== undefined && (typeof ratePercent !== "number" || !Number.isFinite(ratePercent))) return { ok: false, error: `rateSteps[${idx}].ratePercent must be a number` };
  if (note !== undefined && typeof note !== "string") return { ok: false, error: `rateSteps[${idx}].note must be a string` };
  return {
    ok: true,
    step: {
      id: id as string,
      effectiveFrom: effectiveFrom as string,
      ...(methodKind !== undefined && { methodKind: methodKind as RentScheduleMethodKind }),
      ...(newMonthlyRate !== undefined && { newMonthlyRate: newMonthlyRate as number }),
      ...(cpiValue !== undefined && { cpiValue: cpiValue as number }),
      ...(cpiValuePrev !== undefined && { cpiValuePrev: cpiValuePrev as number }),
      ...(ratePercent !== undefined && { ratePercent: ratePercent as number }),
      ...(note !== undefined && { note: (note as string).trim() }),
    },
  };
}

export function validateCarparkScheduleGroup(raw: unknown): { ok: true; group: CarparkScheduleGroup } | StepValidationErr {
  if (!isPlainObject(raw)) return { ok: false, error: "group must be an object" };

  for (const key of Object.keys(raw)) {
    if (!GROUP_ALLOWED_KEYS.has(key)) return { ok: false, error: `Unknown key on group: ${key}` };
  }

  const { id, label, carparkIds, baseMonthlyRate, commencedAt } = raw;

  if (!isUuidShaped(id)) return { ok: false, error: "group.id must be a UUID-shaped string" };
  if (typeof label !== "string" || label.trim().length === 0) return { ok: false, error: "group.label must be a non-empty string" };
  if (label.length > LABEL_MAX) return { ok: false, error: `group.label must be ≤${LABEL_MAX} chars` };
  if (!Array.isArray(carparkIds) || carparkIds.length === 0) return { ok: false, error: "group.carparkIds must be a non-empty array" };
  if (carparkIds.length > CARPARK_IDS_MAX) return { ok: false, error: `group.carparkIds must have ≤${CARPARK_IDS_MAX} entries` };
  if (carparkIds.some((cid) => typeof cid !== "string" || cid.trim().length === 0)) return { ok: false, error: "each carparkId must be a non-empty string" };
  if (typeof baseMonthlyRate !== "number" || !Number.isFinite(baseMonthlyRate) || baseMonthlyRate < 0) return { ok: false, error: "group.baseMonthlyRate must be a non-negative number" };
  if (typeof commencedAt !== "string" || !ISO_DATE_RE.test(commencedAt)) return { ok: false, error: "group.commencedAt must be an ISO date string (YYYY-MM-DD)" };

  const { rateSteps } = raw;
  let validatedSteps: CarparkRateStep[] | undefined;
  if (rateSteps !== undefined) {
    if (!Array.isArray(rateSteps)) return { ok: false, error: "group.rateSteps must be an array" };
    validatedSteps = [];
    for (let i = 0; i < rateSteps.length; i++) {
      const result = validateCarparkRateStep(rateSteps[i], i);
      if (!result.ok) return result;
      validatedSteps.push(result.step);
    }
  }

  return {
    ok: true,
    group: {
      id: id as string,
      label: label.trim(),
      carparkIds: carparkIds as string[],
      baseMonthlyRate,
      commencedAt,
      ...(validatedSteps !== undefined && { rateSteps: validatedSteps }),
    },
  };
}

export function validateUpsertGroupEnvelope(body: unknown):
  | { ok: true; TenantId: number; BuildingId: number; group: CarparkScheduleGroup }
  | StepValidationErr {
  if (!isPlainObject(body)) return { ok: false, error: "body must be an object" };
  const { TenantId, BuildingId } = body;
  if (typeof TenantId !== "number" || !Number.isInteger(TenantId) || TenantId <= 0) return { ok: false, error: "TenantId must be a positive integer" };
  if (typeof BuildingId !== "number" || !Number.isInteger(BuildingId) || BuildingId <= 0) return { ok: false, error: "BuildingId must be a positive integer" };
  const result = validateCarparkScheduleGroup(body.group);
  if (!result.ok) return result;
  return { ok: true, TenantId: TenantId as number, BuildingId: BuildingId as number, group: result.group };
}

export function validateDeleteGroupEnvelope(body: unknown):
  | { ok: true; TenantId: number; BuildingId: number; groupId: string }
  | StepValidationErr {
  if (!isPlainObject(body)) return { ok: false, error: "body must be an object" };
  const { TenantId, BuildingId, groupId } = body;
  if (typeof TenantId !== "number" || !Number.isInteger(TenantId) || TenantId <= 0) return { ok: false, error: "TenantId must be a positive integer" };
  if (typeof BuildingId !== "number" || !Number.isInteger(BuildingId) || BuildingId <= 0) return { ok: false, error: "BuildingId must be a positive integer" };
  if (!isUuidShaped(groupId)) return { ok: false, error: "groupId must be a UUID-shaped string" };
  return { ok: true, TenantId: TenantId as number, BuildingId: BuildingId as number, groupId: groupId as string };
}

export function parseGroups(raw: string | null | undefined): CarparkScheduleGroup[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (g): g is Record<string, unknown> =>
          isPlainObject(g) &&
          isUuidShaped(g.id) &&
          typeof g.label === "string" &&
          Array.isArray(g.carparkIds) &&
          typeof g.baseMonthlyRate === "number" &&
          typeof g.commencedAt === "string",
      )
      .map((g): CarparkScheduleGroup => ({
        id: g.id as string,
        label: g.label as string,
        carparkIds: g.carparkIds as string[],
        baseMonthlyRate: g.baseMonthlyRate as number,
        commencedAt: g.commencedAt as string,
        ...(Array.isArray(g.rateSteps) && g.rateSteps.length > 0 && {
          rateSteps: (g.rateSteps as unknown[]).filter(
            (s): s is CarparkRateStep =>
              isPlainObject(s) && isUuidShaped(s.id) && typeof s.effectiveFrom === "string",
          ),
        }),
      }));
  } catch {
    return [];
  }
}

export function upsertGroup(existing: CarparkScheduleGroup[], incoming: CarparkScheduleGroup): CarparkScheduleGroup[] {
  const idx = existing.findIndex((g) => g.id === incoming.id);
  if (idx === -1) return [...existing, incoming];
  const next = existing.slice();
  // Absent rateSteps keeps the stored ones; an explicit [] clears them.
  const kept = incoming.rateSteps === undefined ? existing[idx].rateSteps : undefined;
  next[idx] = kept ? { ...incoming, rateSteps: kept } : incoming;
  return next;
}

export function deleteGroup(existing: CarparkScheduleGroup[], id: string): CarparkScheduleGroup[] | typeof NOT_FOUND {
  const idx = existing.findIndex((g) => g.id === id);
  if (idx === -1) return NOT_FOUND;
  const next = existing.slice();
  next.splice(idx, 1);
  return next;
}

// ── Misc fees (m059) ──────────────────────────────────────────────────────────

export type MiscFeeFrequency = "monthly" | "quarterly" | "annual";

export interface MiscFeeRateStep {
  id: string;
  effectiveFrom: string;
  methodKind?: RentScheduleMethodKind;
  /** Manual new amount in stated frequency. */
  newAmount?: number;
  cpiValue?: number;
  /** CPI index value from the previous period — stored explicitly so edits are stable. */
  cpiValuePrev?: number;
  ratePercent?: number;
  note?: string;
}

export interface MiscFee {
  id: string;
  title: string;
  frequency: MiscFeeFrequency;
  /** Starting amount in stated frequency (not normalised to monthly). */
  baseAmount: number;
  commencedAt: string;
  endsAt?: string;
  note?: string;
  rateSteps?: MiscFeeRateStep[];
}

const FEE_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "id", "title", "frequency", "baseAmount", "commencedAt", "endsAt", "note", "rateSteps",
]);

const FEE_RATE_STEP_ALLOWED_KEYS: ReadonlySet<string> = new Set([
  "id", "effectiveFrom", "methodKind", "newAmount", "cpiValue", "cpiValuePrev", "ratePercent", "note",
]);

const VALID_FREQUENCIES = new Set<string>(["monthly", "quarterly", "annual"]);

function validateMiscFeeRateStep(raw: unknown, idx: number): { ok: true; step: MiscFeeRateStep } | StepValidationErr {
  if (!isPlainObject(raw)) return { ok: false, error: `rateSteps[${idx}] must be an object` };
  for (const key of Object.keys(raw)) {
    if (!FEE_RATE_STEP_ALLOWED_KEYS.has(key)) return { ok: false, error: `Unknown key on rateStep[${idx}]: ${key}` };
  }
  const { id, effectiveFrom, methodKind, newAmount, cpiValue, cpiValuePrev, ratePercent, note } = raw;
  if (!isUuidShaped(id)) return { ok: false, error: `rateSteps[${idx}].id must be a UUID` };
  if (typeof effectiveFrom !== "string" || !ISO_DATE_RE.test(effectiveFrom)) return { ok: false, error: `rateSteps[${idx}].effectiveFrom must be YYYY-MM-DD` };
  if (methodKind !== undefined && (typeof methodKind !== "string" || !VALID_METHOD_KINDS.has(methodKind))) return { ok: false, error: `rateSteps[${idx}].methodKind is invalid` };
  if (newAmount !== undefined && (typeof newAmount !== "number" || !Number.isFinite(newAmount) || newAmount < 0)) return { ok: false, error: `rateSteps[${idx}].newAmount must be a non-negative number` };
  if (cpiValue !== undefined && (typeof cpiValue !== "number" || !Number.isFinite(cpiValue) || cpiValue <= 0)) return { ok: false, error: `rateSteps[${idx}].cpiValue must be a positive number` };
  if (cpiValuePrev !== undefined && (typeof cpiValuePrev !== "number" || !Number.isFinite(cpiValuePrev) || cpiValuePrev <= 0)) return { ok: false, error: `rateSteps[${idx}].cpiValuePrev must be a positive number` };
  if (ratePercent !== undefined && (typeof ratePercent !== "number" || !Number.isFinite(ratePercent))) return { ok: false, error: `rateSteps[${idx}].ratePercent must be a number` };
  if (note !== undefined && typeof note !== "string") return { ok: false, error: `rateSteps[${idx}].note must be a string` };
  return {
    ok: true,
    step: {
      id: id as string,
      effectiveFrom: effectiveFrom as string,
      ...(methodKind !== undefined && { methodKind: methodKind as RentScheduleMethodKind }),
      ...(newAmount !== undefined && { newAmount: newAmount as number }),
      ...(cpiValue !== undefined && { cpiValue: cpiValue as number }),
      ...(cpiValuePrev !== undefined && { cpiValuePrev: cpiValuePrev as number }),
      ...(ratePercent !== undefined && { ratePercent: ratePercent as number }),
      ...(note !== undefined && { note: (note as string).trim() }),
    },
  };
}

export function validateMiscFee(raw: unknown): { ok: true; fee: MiscFee } | StepValidationErr {
  if (!isPlainObject(raw)) return { ok: false, error: "fee must be an object" };
  for (const key of Object.keys(raw)) {
    if (!FEE_ALLOWED_KEYS.has(key)) return { ok: false, error: `Unknown key on fee: ${key}` };
  }
  const { id, title, frequency, baseAmount, commencedAt, endsAt, note } = raw;
  if (!isUuidShaped(id)) return { ok: false, error: "fee.id must be a UUID-shaped string" };
  if (typeof title !== "string" || title.trim().length === 0) return { ok: false, error: "fee.title must be a non-empty string" };
  if (title.length > 200) return { ok: false, error: "fee.title must be ≤200 chars" };
  if (typeof frequency !== "string" || !VALID_FREQUENCIES.has(frequency)) return { ok: false, error: "fee.frequency must be monthly | quarterly | annual" };
  if (typeof baseAmount !== "number" || !Number.isFinite(baseAmount) || baseAmount < 0) return { ok: false, error: "fee.baseAmount must be a non-negative number" };
  if (typeof commencedAt !== "string" || !ISO_DATE_RE.test(commencedAt)) return { ok: false, error: "fee.commencedAt must be an ISO date string (YYYY-MM-DD)" };
  if (endsAt !== undefined && (typeof endsAt !== "string" || !ISO_DATE_RE.test(endsAt))) return { ok: false, error: "fee.endsAt must be an ISO date string (YYYY-MM-DD) if provided" };
  if (note !== undefined && typeof note !== "string") return { ok: false, error: "fee.note must be a string" };

  const { rateSteps } = raw;
  let validatedSteps: MiscFeeRateStep[] | undefined;
  if (rateSteps !== undefined) {
    if (!Array.isArray(rateSteps)) return { ok: false, error: "fee.rateSteps must be an array" };
    validatedSteps = [];
    for (let i = 0; i < rateSteps.length; i++) {
      const result = validateMiscFeeRateStep(rateSteps[i], i);
      if (!result.ok) return result;
      validatedSteps.push(result.step);
    }
  }

  return {
    ok: true,
    fee: {
      id: id as string,
      title: (title as string).trim(),
      frequency: frequency as MiscFeeFrequency,
      baseAmount,
      commencedAt,
      ...(endsAt !== undefined && { endsAt }),
      ...(note !== undefined && { note: (note as string).trim() }),
      ...(validatedSteps !== undefined && { rateSteps: validatedSteps }),
    },
  };
}

export function validateUpsertFeeEnvelope(body: unknown):
  | { ok: true; TenantId: number; BuildingId: number; fee: MiscFee }
  | StepValidationErr {
  if (!isPlainObject(body)) return { ok: false, error: "body must be an object" };
  const { TenantId, BuildingId } = body;
  if (typeof TenantId !== "number" || !Number.isInteger(TenantId) || TenantId <= 0) return { ok: false, error: "TenantId must be a positive integer" };
  if (typeof BuildingId !== "number" || !Number.isInteger(BuildingId) || BuildingId <= 0) return { ok: false, error: "BuildingId must be a positive integer" };
  const result = validateMiscFee(body.fee);
  if (!result.ok) return result;
  return { ok: true, TenantId: TenantId as number, BuildingId: BuildingId as number, fee: result.fee };
}

export function validateDeleteFeeEnvelope(body: unknown):
  | { ok: true; TenantId: number; BuildingId: number; feeId: string }
  | StepValidationErr {
  if (!isPlainObject(body)) return { ok: false, error: "body must be an object" };
  const { TenantId, BuildingId, feeId } = body;
  if (typeof TenantId !== "number" || !Number.isInteger(TenantId) || TenantId <= 0) return { ok: false, error: "TenantId must be a positive integer" };
  if (typeof BuildingId !== "number" || !Number.isInteger(BuildingId) || BuildingId <= 0) return { ok: false, error: "BuildingId must be a positive integer" };
  if (!isUuidShaped(feeId)) return { ok: false, error: "feeId must be a UUID-shaped string" };
  return { ok: true, TenantId: TenantId as number, BuildingId: BuildingId as number, feeId: feeId as string };
}

export function parseMiscFees(raw: string | null | undefined): MiscFee[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(
        (f): f is Record<string, unknown> =>
          isPlainObject(f) &&
          isUuidShaped(f.id) &&
          typeof f.title === "string" &&
          typeof f.frequency === "string" &&
          typeof f.baseAmount === "number" &&
          typeof f.commencedAt === "string",
      )
      .map((f): MiscFee => ({
        id: f.id as string,
        title: f.title as string,
        frequency: f.frequency as MiscFeeFrequency,
        baseAmount: f.baseAmount as number,
        commencedAt: f.commencedAt as string,
        ...(typeof f.endsAt === "string" && { endsAt: f.endsAt }),
        ...(typeof f.note === "string" && f.note.length > 0 && { note: f.note }),
        ...(Array.isArray(f.rateSteps) && f.rateSteps.length > 0 && {
          rateSteps: (f.rateSteps as unknown[]).filter(
            (s): s is MiscFeeRateStep =>
              isPlainObject(s) && isUuidShaped(s.id) && typeof s.effectiveFrom === "string",
          ),
        }),
      }));
  } catch {
    return [];
  }
}

export function upsertMiscFee(existing: MiscFee[], incoming: MiscFee): MiscFee[] {
  const idx = existing.findIndex((f) => f.id === incoming.id);
  if (idx === -1) return [...existing, incoming];
  const next = existing.slice();
  // Absent rateSteps keeps the stored ones; an explicit [] clears them.
  const kept = incoming.rateSteps === undefined ? existing[idx].rateSteps : undefined;
  next[idx] = kept ? { ...incoming, rateSteps: kept } : incoming;
  return next;
}

export function deleteMiscFee(existing: MiscFee[], id: string): MiscFee[] | typeof NOT_FOUND {
  const idx = existing.findIndex((f) => f.id === id);
  if (idx === -1) return NOT_FOUND;
  const next = existing.slice();
  next.splice(idx, 1);
  return next;
}
