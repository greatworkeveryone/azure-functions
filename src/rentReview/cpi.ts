// The CPI suggestion on a CPI review: the two index values the rent change will
// be worked from, read from dbo.CpiIndex (PLAN §3.2, Q5). Pure; the endpoint
// loads the two rows and passes them in.
//
// Reference quarter rule (Q5, the default): the quarter ending immediately
// before the review date, i.e. the quarter before the one the review date falls
// in (a review on 1 Jul 2026 is worked from the June 2026 quarter; one on
// 30 Jun 2026, still inside that quarter, from March). The earlier value is
// the same quarter one review interval before. Both must come from the same
// series on the same base: ABS restates every value when it rebases, so two
// values on different or unknown bases are not comparable and are not offered.
//
// ABS publishes a quarter's CPI in the month after it ends; the plan's
// expectedIndexAt is the quarter end plus 30 days.

import { addDaysIso } from "../darwinDate";
import { type CpiReferenceRule, DEFAULT_CPI_REFERENCE_RULE, DEFAULT_REVIEW_INTERVAL_MONTHS } from "./basis";

const PERIOD_RE = /^(\d{4})-Q([1-4])$/;
const QUARTER_END_MONTH_DAY = ["03-31", "06-30", "09-30", "12-31"] as const;
export const CPI_RELEASE_LAG_DAYS = 30;

interface Quarter {
  q: number;
  year: number;
}

function parsePeriod(period: string): Quarter {
  const match = period.match(PERIOD_RE);
  if (!match) throw new Error(`Not a CPI quarter: ${period}`);
  return { q: Number(match[2]), year: Number(match[1]) };
}

const formatPeriod = ({ q, year }: Quarter): string => `${String(year).padStart(4, "0")}-Q${q}`;

/** The quarter n quarters after `period` (negative n: before). */
export function shiftQuarters(period: string, delta: number): string {
  const { q, year } = parsePeriod(period);
  const index = year * 4 + (q - 1) + delta;
  const shiftedYear = Math.floor(index / 4);
  return formatPeriod({ q: index - shiftedYear * 4 + 1, year: shiftedYear });
}

/** The last day of a quarter, ISO. */
export function quarterEnd(period: string): string {
  const { q, year } = parsePeriod(period);
  return `${String(year).padStart(4, "0")}-${QUARTER_END_MONTH_DAY[q - 1]}`;
}

/** The quarter an ISO date falls in, as "YYYY-Qn". */
export function quarterOf(isoDate: string): string {
  const year = Number(isoDate.slice(0, 4));
  const month = Number(isoDate.slice(5, 7));
  return formatPeriod({ q: Math.floor((month - 1) / 3) + 1, year });
}

/** Q5's default rule: the quarter before the one the review date falls in. */
export function referenceQuarter(reviewDate: string): string {
  return shiftQuarters(quarterOf(reviewDate), -1);
}

/**
 * The reference quarter for a review dated `reviewDate` under the lease's rule
 * (M4): the quarter before the review date's (the default), or the latest one
 * expected to be published before the review date (quarter end + 30 days, as
 * expectedRelease; a release on the review date itself isn't before it).
 */
export function referenceQuarterFor(rule: CpiReferenceRule, reviewDate: string): string {
  let quarter = referenceQuarter(reviewDate);
  if (rule !== "latest_published_before_review") return quarter;
  while (expectedRelease(quarter) >= reviewDate) quarter = shiftQuarters(quarter, -1);
  return quarter;
}

/** The quarter the earlier index value is read from: one review interval
 *  before the reference quarter (a whole number of quarters, at least one). */
export function previousQuarter(reference: string, intervalMonths: number | null): string {
  const months = intervalMonths !== null && intervalMonths > 0 ? intervalMonths : DEFAULT_REVIEW_INTERVAL_MONTHS;
  return shiftQuarters(reference, -Math.max(1, Math.round(months / 3)));
}

/** When ABS is expected to have published `period`: its last day plus 30 days. */
export function expectedRelease(period: string): string {
  return addDaysIso(quarterEnd(period), CPI_RELEASE_LAG_DAYS);
}

export interface CpiIndexRow {
  indexValue: number;
  period: string;
  referenceBase: string | null;
}

export interface CpiSuggestion {
  /** When the reference quarter is expected to be published; set while it isn't. */
  expectedRelease: string | null;
  previousQuarter: string;
  referenceQuarter: string;
  region: string;
  rule: CpiReferenceRule;
  /** The two index values; null until both quarters are published on one base. */
  values: { current: number; previous: number; referenceBase: string } | null;
}

/**
 * The suggestion for a CPI review dated `reviewDate`. `rows` are whatever the
 * caller found in CpiIndex for this region; only the two quarters matter.
 */
export function buildCpiSuggestion(input: {
  intervalMonths: number | null;
  region: string;
  reviewDate: string;
  rows: readonly CpiIndexRow[];
  /** The basis's rule (the lease's before commence); the default when left out. */
  rule?: CpiReferenceRule;
}): CpiSuggestion {
  const rule = input.rule ?? DEFAULT_CPI_REFERENCE_RULE;
  const reference = referenceQuarterFor(rule, input.reviewDate);
  const previous = previousQuarter(reference, input.intervalMonths);
  const current = input.rows.find((row) => row.period === reference);
  const earlier = input.rows.find((row) => row.period === previous);
  const comparable =
    current !== undefined &&
    earlier !== undefined &&
    current.referenceBase !== null &&
    current.referenceBase === earlier.referenceBase &&
    Number.isFinite(current.indexValue) &&
    Number.isFinite(earlier.indexValue);
  return {
    expectedRelease: current ? null : expectedRelease(reference),
    previousQuarter: previous,
    referenceQuarter: reference,
    region: input.region,
    rule,
    values: comparable
      ? { current: current.indexValue, previous: earlier.indexValue, referenceBase: current.referenceBase as string }
      : null,
  };
}
