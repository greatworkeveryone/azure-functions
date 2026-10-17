// Facilities rules (LAUNCH-READINESS §5, WP47/WP48, WP50): pure, no I/O.
// Mirrored byte for byte in command-centre src/helpers/facilitiesRules/ and
// rpcc-functions src/facilitiesRules/, pinned on both sides by the same vector
// file (facilities-rules.vectors.json). Change both copies and the vectors
// together. Dates are Darwin calendar dates as "YYYY-MM-DD" strings, so no
// time zone can shift a day.
//
// A schedule recurs every N weeks or months from an anchor date. Every due date
// is computed from the anchor (occurrence n = anchor + n intervals), never by
// stepping from the last one, so a month-end anchor doesn't drift (31 Jan,
// 28 Feb, 31 Mar). Completing a job moves the next due to the next occurrence
// after the one it served, never from the completion date.

import { addDays, addMonths, daysFromTo } from "./dates";

export type IntervalUnit = "weeks" | "months";
export const INTERVAL_UNITS: readonly IntervalUnit[] = ["weeks", "months"];
export const DEFAULT_LEAD_DAYS = 14;
/** Overdue servicing in these categories escalates as urgent; the rest goes to the digest. */
export const URGENT_SERVICES: readonly string[] = ["Fire & life safety", "Lifts"];

export interface ServiceSeries {
  anchorDate: string;
  intervalCount: number;
  intervalUnit: IntervalUnit;
}

/** Occurrence `index` (0 = the anchor). */
export function seriesDate(series: ServiceSeries, index: number): string {
  return series.intervalUnit === "weeks"
    ? addDays(series.anchorDate, 7 * series.intervalCount * index)
    : addMonths(series.anchorDate, series.intervalCount * index);
}

/** The first occurrence on or after `date` (strictly after when `strict`). */
function firstOccurrence(series: ServiceSeries, date: string, strict: boolean): string {
  const passes = (candidate: string) => (strict ? candidate > date : candidate >= date);
  const [anchorYear, anchorMonth] = series.anchorDate.split("-").map(Number);
  const [dateYear, dateMonth] = date.split("-").map(Number);
  const estimate =
    series.intervalUnit === "weeks"
      ? Math.floor(daysFromTo(series.anchorDate, date) / (7 * series.intervalCount))
      : Math.floor(((dateYear - anchorYear) * 12 + (dateMonth - anchorMonth)) / series.intervalCount);
  let index = Math.max(0, estimate - 1);
  while (index > 0 && passes(seriesDate(series, index - 1))) index -= 1;
  while (!passes(seriesDate(series, index))) index += 1;
  return seriesDate(series, index);
}

export function firstDueOnOrAfter(series: ServiceSeries, date: string): string {
  return firstOccurrence(series, date, false);
}

export function nextDueAfter(series: ServiceSeries, date: string): string {
  return firstOccurrence(series, date, true);
}

/** The scheduler creates the job `leadDays` before it is due. */
export function isGenerationDue(nextDue: string, leadDays: number, today: string): boolean {
  return addDays(nextDue, -leadDays) <= today;
}

/** Overdue against the service's own due date, not a job's chase date. */
export function isServiceOverdue(nextDue: string, today: string): boolean {
  return nextDue < today;
}

export function isUrgentService(category: string | null | undefined): boolean {
  return URGENT_SERVICES.includes((category ?? "").trim());
}

/** "{Name} — {Asset or scope} — due DD/MM/YYYY" */
export function serviceJobTitle(name: string, target: string | null, due: string): string {
  const [year, month, day] = due.split("-");
  return [name.trim(), target?.trim(), `due ${day}/${month}/${year}`].filter(Boolean).join(" — ");
}
