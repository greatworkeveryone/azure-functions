// Darwin calendar days as YYYY-MM-DD text, and the UTC instants they start at. Darwin is a
// fixed UTC+09:30 (no daylight saving), so this is plain arithmetic; see ledger/darwinTime.

import { darwinDayStartUtc, darwinNextDayStartUtc, parseDarwinDate } from "../ledger/darwinTime";

const DARWIN_OFFSET_MS = 9.5 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** The Darwin calendar day an instant falls on. */
export function darwinDay(instant: Date): string {
  return new Date(instant.getTime() + DARWIN_OFFSET_MS).toISOString().slice(0, 10);
}

export function addDays(day: string, count: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + count * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** The UTC instant the Darwin day starts, or null when the text is not a real date. */
export function dayStartUtc(day: string): Date | null {
  const parsed = parseDarwinDate(day);
  return parsed ? darwinDayStartUtc(parsed) : null;
}

/** The UTC instant the day AFTER this Darwin day starts: an exclusive upper bound. */
export function dayEndUtc(day: string): Date | null {
  const parsed = parseDarwinDate(day);
  return parsed ? darwinNextDayStartUtc(parsed) : null;
}
