// Calendar-date helpers for lease maths. Mirrors FE src/helpers/darwinDate.ts.
//
// Rent, reviews and expiries run on the Darwin calendar: a step dated the 1st
// takes effect at midnight in Darwin, not at 09:30 when UTC rolls over.
// Everything here works on ISO "YYYY-MM-DD" strings so no local time zone can
// shift a day.

const DARWIN_DATE = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Australia/Darwin",
  year: "numeric",
});

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/** Today's date in Darwin as "YYYY-MM-DD". */
export function todayInDarwin(now: Date = new Date()): string {
  const parts = DARWIN_DATE.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function parseIso(iso: string): { day: number; month: number; year: number } {
  const match = iso.slice(0, 10).match(ISO_DATE_RE);
  if (!match) throw new Error(`Not an ISO date: ${iso}`);
  return { day: Number(match[3]), month: Number(match[2]), year: Number(match[1]) };
}

function formatIso(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDaysIso(iso: string, days: number): string {
  const { day, month, year } = parseIso(iso);
  const date = new Date(Date.UTC(year, month - 1, day) + days * DAY_MS);
  return formatIso(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

/** Adds calendar months; a day past the end of the target month clamps to its
 *  last day (31 Jan + 1 month = 28/29 Feb). Always computed from `iso`, never
 *  iteratively, so an anniversary series doesn't drift. */
export function addMonthsClamped(iso: string, months: number): string {
  const { day, month, year } = parseIso(iso);
  const total = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - targetYear * 12 + 1;
  return formatIso(targetYear, targetMonth, Math.min(day, daysInMonth(targetYear, targetMonth)));
}

/** Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier). */
export function daysBetweenIso(fromIso: string, toIso: string): number {
  const start = parseIso(fromIso);
  const end = parseIso(toIso);
  return Math.round(
    (Date.UTC(end.year, end.month - 1, end.day) - Date.UTC(start.year, start.month - 1, start.day)) / DAY_MS,
  );
}

export function isIsoDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = value.match(ISO_DATE_RE);
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth(Number(match[1]), month);
}
