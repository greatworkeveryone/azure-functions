// NextReviewDate is derived, never hand-maintained (PLAN D1, WP23b). Reads
// derive it for "today" (Darwin); every schedule write and every
// review-affecting tenant write stores it, and the admin one-off
// recomputeNextReviewDates brings existing rows into line.
//
// The next review is the earliest review row (not commencement) after
// LastReviewDate that nothing has settled; failing that, the next lease
// anniversary — the lease's latest commencement (a later commencement row is a
// renewal or reset) + n × ReviewIntervalMonths, month-end clamped and always
// counted from that commencement, so a review processed late doesn't move the
// anniversary.
//
// What settles a review depends on REVIEW_WORKFLOW_LIVE_FROM
// (reviewWorkflowLiveFrom). A row whose value is still unknown (CPI index,
// market or other rate) never settles by itself, so an unkeyed review past its
// date reads overdue either way.

import { addMonthsClamped, isIsoDate, todayInDarwin } from "./darwinDate";
import { type ScheduledRateStep, sortSteps, stepPendingReason } from "./scheduledRateStepLogic";

let warnedSetting: string | null = null;

/**
 * REVIEW_WORKFLOW_LIVE_FROM (app setting, YYYY-MM-DD): the day the rent-review
 * workflow (WP25/WP26) went live, set at gate B.
 *  • Unset: reviews are done in Excel and their values keyed by hand, so a
 *    keyed row settles its review once its date has come (Darwin). A row keyed
 *    ahead — a pre-filled fixed step — stays the upcoming review until then.
 *  • Set: a review dated on or after it is settled only by a resolution on its
 *    row, a completed or waived RentReviews row for its date, or
 *    LastReviewDate; earlier rows still settle by their known value.
 * An invalid value logs a warning and counts as unset.
 */
export function reviewWorkflowLiveFrom(raw: string | undefined = process.env.REVIEW_WORKFLOW_LIVE_FROM): string | null {
  const value = raw?.trim() ?? "";
  if (value === "") return null;
  if (isIsoDate(value)) return value;
  if (warnedSetting !== value) {
    warnedSetting = value;
    console.warn(`[nextReviewDate] REVIEW_WORKFLOW_LIVE_FROM "${value}" is not a YYYY-MM-DD date; treating it as unset`);
  }
  return null;
}

const DEFAULT_INTERVAL_MONTHS = 12;
/** 200 years of monthly reviews — the loop below can't run away. */
const MAX_ANNIVERSARIES = 2400;

export interface NextReviewInput {
  /** Tenants.Commencement (ISO date). */
  commencement: string | null;
  /** Tenants.LastReviewDate (ISO date). */
  lastReviewDate: string | null;
  /** ScheduledFor of the tenancy's completed or waived RentReviews rows. */
  resolvedReviewDates: ReadonlySet<string>;
  /** Tenants.ReviewIntervalMonths; 12 when unset. */
  reviewIntervalMonths: number | null;
  steps: ScheduledRateStep[];
  /** Tenants.NextReviewDate as stored. */
  storedNextReviewDate: string | null;
  /** The Darwin date the derivation is for. */
  today: string;
  /** reviewWorkflowLiveFrom(): null while reviews are keyed by hand. */
  workflowLiveFrom: string | null;
}

function isSettled(step: ScheduledRateStep, input: NextReviewInput): boolean {
  if (step.resolution) return true;
  if (input.resolvedReviewDates.has(step.effectiveFrom)) return true;
  if (stepPendingReason(step) !== null) return false;
  // Keyed by hand: while the workflow isn't live, once the row's date has come;
  // after it is, only rows dated before it.
  return input.workflowLiveFrom === null
    ? step.effectiveFrom <= input.today
    : step.effectiveFrom < input.workflowLiveFrom;
}

function latest(dates: Iterable<string | null>): string | null {
  let max: string | null = null;
  for (const date of dates) if (date !== null && (max === null || date > max)) max = date;
  return max;
}

/** The first anniversary of `anchor` (every `intervalMonths`, month-end
 *  clamped, counted from the anchor) strictly after `after`. */
export function nextAnniversary(anchor: string, intervalMonths: number, after: string): string | null {
  for (let n = 1; n <= MAX_ANNIVERSARIES; n++) {
    const candidate = addMonthsClamped(anchor, n * intervalMonths);
    if (candidate > after) return candidate;
  }
  return null;
}

/**
 * The tenancy's next review date, or null when there is nothing to derive it
 * from — the caller then keeps the stored value. Without a schedule the
 * stored date is the only record of where the reviews stand, so it is kept;
 * one is derived only when none is stored (a new tenancy).
 */
export function deriveNextReviewDate(input: NextReviewInput): string | null {
  const steps = sortSteps(input.steps);
  const reviews = steps.filter((step) => step.methodKind !== "commencement");
  const last = input.lastReviewDate;

  const open = reviews.find(
    (step) => (last === null || step.effectiveFrom > last) && !isSettled(step, input),
  );
  if (open) return open.effectiveFrom;

  const anchor =
    steps.filter((step) => step.methodKind === "commencement").at(-1)?.effectiveFrom ??
    input.commencement ??
    steps[0]?.effectiveFrom ??
    null;
  if (anchor === null) return null;
  if (steps.length === 0 && input.storedNextReviewDate !== null) return null;

  const interval =
    input.reviewIntervalMonths !== null && input.reviewIntervalMonths > 0
      ? input.reviewIntervalMonths
      : DEFAULT_INTERVAL_MONTHS;
  const settledDates = reviews.filter((step) => isSettled(step, input)).map((step) => step.effectiveFrom);
  const after = latest([anchor, last, ...settledDates, ...input.resolvedReviewDates]) ?? anchor;
  return nextAnniversary(anchor, interval, after);
}

/** Parses the comma-separated ScheduledFor dates RESOLVED_REVIEW_DATES_SQL returns. */
export function parseResolvedReviewDates(raw: unknown): Set<string> {
  if (typeof raw !== "string" || raw.trim() === "") return new Set();
  return new Set(raw.split(",").map((date) => date.trim().slice(0, 10)).filter((date) => date.length === 10));
}

/**
 * Select-list column for a query over `dbo.Tenants t`: the ScheduledFor dates
 * of the tenancy's settled reviews, comma-separated (parseResolvedReviewDates).
 *
 * A workflow review (State set, WP25/WP26) settles its date when it is
 * approved, completed or waived; a cancelled one does not, so a review
 * cancelled as superseded leaves its date still to be reviewed (the generator
 * schedules it again) and only a tenancy that has gone stops needing it. A row
 * from before the workflow (State NULL) settles by its legacy Status, where
 * 'skipped' is the old name for a waived review. The workflow writes 'skipped'
 * for a cancelled review too (legacyMap.ts), which is why State is read first.
 */
export const RESOLVED_REVIEW_DATES_SQL = `(
    SELECT STRING_AGG(CONVERT(CHAR(10), rr.ScheduledFor, 23), ',')
    FROM dbo.RentReviews rr
    WHERE rr.TenantId = t.TenantId
      AND (rr.State IN ('approved', 'completed', 'waived')
        OR (rr.State IS NULL AND rr.Status IN ('completed', 'skipped', 'waived')))
  ) AS ResolvedReviewDates`;

/** A DATE column (tedious returns a Date at UTC midnight) or an ISO string as
 *  "YYYY-MM-DD"; null when absent or not a date. */
export function sqlDateToIso(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  if (typeof value !== "string") return null;
  const iso = value.slice(0, 10);
  return isIsoDate(iso) ? iso : null;
}

/** NextReviewInput from a Tenants row selected with Commencement,
 *  LastReviewDate, ReviewIntervalMonths, NextReviewDate and
 *  RESOLVED_REVIEW_DATES_SQL, for `today` (Darwin) under the current
 *  REVIEW_WORKFLOW_LIVE_FROM. */
export function nextReviewInputFromRow(
  row: Record<string, unknown>,
  steps: ScheduledRateStep[],
  today: string = todayInDarwin(),
): NextReviewInput {
  const interval = row.ReviewIntervalMonths == null ? Number.NaN : Number(row.ReviewIntervalMonths);
  return {
    commencement: sqlDateToIso(row.Commencement),
    lastReviewDate: sqlDateToIso(row.LastReviewDate),
    resolvedReviewDates: parseResolvedReviewDates(row.ResolvedReviewDates),
    reviewIntervalMonths: Number.isFinite(interval) ? interval : null,
    steps,
    storedNextReviewDate: sqlDateToIso(row.NextReviewDate),
    today,
    workflowLiveFrom: reviewWorkflowLiveFrom(),
  };
}
