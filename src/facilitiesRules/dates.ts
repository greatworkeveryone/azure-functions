// Facilities rules (LAUNCH-READINESS §5, WP47/WP48, WP50): pure, no I/O.
// Mirrored byte for byte in command-centre src/helpers/facilitiesRules/ and
// rpcc-functions src/facilitiesRules/, pinned on both sides by the same vector
// file (facilities-rules.vectors.json). Change both copies and the vectors
// together. Dates are Darwin calendar dates as "YYYY-MM-DD" strings, so no
// time zone can shift a day.
//
// Calendar arithmetic on ISO dates.

export const DAY_MS = 86_400_000;

export function utcDay(iso: string): number {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier). */
export function daysFromTo(fromIso: string, toIso: string): number {
  return Math.round((utcDay(toIso) - utcDay(fromIso)) / DAY_MS);
}

export function isoFromUtc(millis: number): string {
  return new Date(millis).toISOString().slice(0, 10);
}

export function addDays(iso: string, days: number): string {
  return isoFromUtc(utcDay(iso) + days * DAY_MS);
}

/** Calendar months from `iso`; a day past the target month's end clamps to it. */
export function addMonths(iso: string, months: number): string {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  const total = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - targetYear * 12;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return isoFromUtc(Date.UTC(targetYear, targetMonth, Math.min(day, lastDay)));
}
