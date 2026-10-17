// The Basis of a review (PLAN §3.2): the lease terms this review is decided on,
// snapshotted when someone commences it, so a later edit to the tenancy cannot
// quietly change a review in progress. Stored as JSON in RentReviews.Basis.
// While the review is in_progress or awaiting_index its owner (or an accounts
// manager and up) can correct it, with a reason, which is ledgered
// (rent_review.basis_update).
//
// Keys common to every method: method, reviewDate, reviewType (the lease's own
// words), intervalMonths, ratchet. Then by method:
//   cpi     region, referenceQuarterRule, capPercent, floorPercent
//   fixed   fixedPercent
//   market  leaseClause, deadlines [{ label, date }]   (nothing stores these on
//           the tenancy yet, so they start empty and are filled in here)
//   other   description
//
// method, reviewDate and reviewType are facts of the snapshot, not editable.
// Pure.

import { isIsoDate } from "../darwinDate";
import type { RentReviewMethod } from "../rentReviewMachine";
import type { ScheduledRateStep } from "../scheduledRateStepLogic";

export type RentReviewBasis = Record<string, unknown>;

/** The reference quarter convention (PLAN Q5): the quarter ending immediately
 *  before the review date. Kept as a named rule so a tenancy can override it
 *  here later. */
export const CPI_REFERENCE_RULES = ["quarter_before_review_date"] as const;
export type CpiReferenceRule = (typeof CPI_REFERENCE_RULES)[number];
export const DEFAULT_CPI_REFERENCE_RULE: CpiReferenceRule = "quarter_before_review_date";

export const CPI_REGIONS_IN_BASIS = ["AUS", "DARWIN"] as const;

/** Review interval assumed when the lease states none (deriveNextReviewDate does the same). */
export const DEFAULT_REVIEW_INTERVAL_MONTHS = 12;

const PERCENT_MIN = -100;
const PERCENT_MAX = 100;
const INTERVAL_MIN = 1;
const INTERVAL_MAX = 120;
const CLAUSE_MAX_CHARS = 500;
const DESCRIPTION_MAX_CHARS = 2000;
const DEADLINES_MAX = 20;
const DEADLINE_LABEL_MAX_CHARS = 100;

export interface BasisSource {
  cpiCapPercent: number | null;
  cpiFloorPercent: number | null;
  /** Tenants.CpiRegion. */
  cpiRegion: string | null;
  fixedReviewPercent: number | null;
  intervalMonths: number | null;
  method: RentReviewMethod;
  ratchet: boolean;
  /** Tenants.ReviewType as typed. */
  reviewType: string | null;
  reviewDate: string;
  /** The schedule step on the review date, if there is one. */
  step: Pick<ScheduledRateStep, "methodKind" | "ratePercent"> | null;
}

const finiteOrNull = (value: number | null): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

function regionOrNull(value: string | null): "AUS" | "DARWIN" | null {
  const upper = value?.trim().toUpperCase();
  return upper === "AUS" || upper === "DARWIN" ? upper : null;
}

/** The lease's fixed %: the tenancy's own, else the fixed step's rate. */
function fixedPercentOf(source: BasisSource): number | null {
  const lease = finiteOrNull(source.fixedReviewPercent);
  if (lease !== null) return lease;
  return source.step?.methodKind === "fixed" ? finiteOrNull(source.step.ratePercent) : null;
}

export function buildBasisSnapshot(source: BasisSource): RentReviewBasis {
  const common = {
    intervalMonths: source.intervalMonths ?? DEFAULT_REVIEW_INTERVAL_MONTHS,
    method: source.method,
    ratchet: source.ratchet,
    reviewDate: source.reviewDate,
    reviewType: source.reviewType?.trim() ? source.reviewType.trim() : null,
  };
  switch (source.method) {
    case "cpi":
      return {
        ...common,
        capPercent: finiteOrNull(source.cpiCapPercent),
        floorPercent: finiteOrNull(source.cpiFloorPercent),
        referenceQuarterRule: DEFAULT_CPI_REFERENCE_RULE,
        region: regionOrNull(source.cpiRegion),
      };
    case "fixed":
      return { ...common, fixedPercent: fixedPercentOf(source) };
    case "market":
      return { ...common, deadlines: [], leaseClause: null };
    case "other":
      return { ...common, description: null };
  }
}

// ── Editing ─────────────────────────────────────────────────────────────────

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

type KeyCheck = (value: unknown) => { error: string } | { value: unknown };

const bad = (error: string): { error: string } => ({ error });
const good = (value: unknown): { value: unknown } => ({ value });

function percent(label: string): KeyCheck {
  return (value) => {
    if (value === null) return good(null);
    if (typeof value !== "number" || !Number.isFinite(value) || value < PERCENT_MIN || value > PERCENT_MAX) {
      return bad(`${label} must be a percentage between ${PERCENT_MIN} and ${PERCENT_MAX}, or null`);
    }
    return good(value);
  };
}

function text(label: string, max: number): KeyCheck {
  return (value) => {
    if (value === null) return good(null);
    if (typeof value !== "string") return bad(`${label} must be text, or null`);
    const trimmed = value.trim();
    if (trimmed.length > max) return bad(`${label} can be at most ${max} characters`);
    return good(trimmed === "" ? null : trimmed);
  };
}

const checkInterval: KeyCheck = (value) =>
  typeof value === "number" && Number.isInteger(value) && value >= INTERVAL_MIN && value <= INTERVAL_MAX
    ? good(value)
    : bad(`intervalMonths must be a whole number of months from ${INTERVAL_MIN} to ${INTERVAL_MAX}`);

const checkRatchet: KeyCheck = (value) =>
  typeof value === "boolean" ? good(value) : bad("ratchet must be true or false");

const checkRegion: KeyCheck = (value) =>
  value === null || value === "AUS" || value === "DARWIN" ? good(value) : bad("region must be AUS, DARWIN or null");

const checkRule: KeyCheck = (value) =>
  typeof value === "string" && (CPI_REFERENCE_RULES as readonly string[]).includes(value)
    ? good(value)
    : bad(`referenceQuarterRule must be one of ${CPI_REFERENCE_RULES.join(", ")}`);

const checkDeadlines: KeyCheck = (value) => {
  if (!Array.isArray(value) || value.length > DEADLINES_MAX) {
    return bad(`deadlines must be a list of at most ${DEADLINES_MAX} dates`);
  }
  const cleaned: Array<{ date: string; label: string }> = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) return bad("Each deadline needs a label and a date");
    const extra = Object.keys(entry).find((key) => key !== "label" && key !== "date");
    if (extra) return bad(`A deadline has no "${extra}"`);
    const label = typeof entry.label === "string" ? entry.label.trim() : "";
    if (label === "" || label.length > DEADLINE_LABEL_MAX_CHARS) {
      return bad(`Each deadline needs a label of at most ${DEADLINE_LABEL_MAX_CHARS} characters`);
    }
    if (!isIsoDate(entry.date)) return bad(`The deadline "${label}" needs a date as YYYY-MM-DD`);
    cleaned.push({ date: entry.date, label });
  }
  return good(cleaned);
};

const COMMON_KEYS: Record<string, KeyCheck> = {
  intervalMonths: checkInterval,
  ratchet: checkRatchet,
};

const KEYS_BY_METHOD: Record<RentReviewMethod, Record<string, KeyCheck>> = {
  cpi: {
    ...COMMON_KEYS,
    capPercent: percent("capPercent"),
    floorPercent: percent("floorPercent"),
    referenceQuarterRule: checkRule,
    region: checkRegion,
  },
  fixed: { ...COMMON_KEYS, fixedPercent: percent("fixedPercent") },
  market: {
    ...COMMON_KEYS,
    deadlines: checkDeadlines,
    leaseClause: text("leaseClause", CLAUSE_MAX_CHARS),
  },
  other: { ...COMMON_KEYS, description: text("description", DESCRIPTION_MAX_CHARS) },
};

/** The keys a review of this method lets its owner edit. */
export function editableBasisKeys(method: RentReviewMethod): string[] {
  return Object.keys(KEYS_BY_METHOD[method]);
}

export type BasisPatchResult =
  | { ok: true; patch: Record<string, unknown> }
  | { error: string; ok: false };

/** Checks a requested change to the basis and cleans its values. Unknown keys,
 *  and keys another method owns, are refused rather than ignored. */
export function validateBasisPatch(method: RentReviewMethod, raw: unknown): BasisPatchResult {
  if (!isPlainObject(raw) || Object.keys(raw).length === 0) {
    return { error: "basis must be an object naming at least one field to change", ok: false };
  }
  const checks = KEYS_BY_METHOD[method];
  const patch: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!Object.prototype.hasOwnProperty.call(checks, key)) {
      return { error: `"${key}" can't be changed on a ${method} review`, ok: false };
    }
    const checked = checks[key](value);
    if ("error" in checked) return { error: checked.error, ok: false };
    patch[key] = checked.value;
  }
  return { ok: true, patch };
}

export interface BasisChange {
  after: Record<string, unknown>;
  basis: RentReviewBasis;
  before: Record<string, unknown>;
  /** The keys whose value actually changed. */
  changed: string[];
}

export type BasisChangeResult =
  | { change: BasisChange; ok: true }
  | { error: string; kind: "invalid" | "no_change"; ok: false };

/**
 * Applies a validated patch to the current basis. before and after hold only
 * the keys that changed (what the ledger records); a patch that changes
 * nothing is refused so no empty decision is recorded. The floor can't sit
 * above the cap.
 */
export function applyBasisPatch(current: RentReviewBasis, patch: Record<string, unknown>): BasisChangeResult {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(patch)) {
    const old = current[key] === undefined ? null : current[key];
    if (JSON.stringify(old) === JSON.stringify(value)) continue;
    before[key] = old;
    after[key] = value;
  }
  const changed = Object.keys(after);
  if (changed.length === 0) return { error: "That is already the basis; nothing to change", kind: "no_change", ok: false };

  const basis: RentReviewBasis = { ...current, ...after };
  const cap = basis.capPercent;
  const floor = basis.floorPercent;
  if (typeof cap === "number" && typeof floor === "number" && floor > cap) {
    return { error: "The CPI floor can't be above the cap", kind: "invalid", ok: false };
  }
  return { change: { after, basis, before, changed }, ok: true };
}

/** Parses RentReviews.Basis; null when empty or not a JSON object. */
export function parseBasis(raw: unknown): RentReviewBasis | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
