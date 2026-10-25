// The period every analytics route reads: ?days=7|30|90 (any whole number from 1 to 366) counted
// back from today in Darwin, or ?from=YYYY-MM-DD&to=YYYY-MM-DD. Anything malformed is refused,
// not ignored. Days are Darwin days, as on every other screen.

import { addDays, dayEndUtc, daysBetween, darwinDay, dayStartUtc } from "./days";

export const MAX_PERIOD_DAYS = 366;
export const DEFAULT_PERIOD_DAYS = 30;

export interface UsagePeriod {
  days: number;
  from: string;
  fromUtc: Date;
  to: string;
  toUtc: Date;
}

export type ParsedPeriod = { error: string } | { period: UsagePeriod };

function build(from: string, to: string): ParsedPeriod {
  const fromUtc = dayStartUtc(from);
  const toUtc = dayEndUtc(to);
  if (!fromUtc || !toUtc) return { error: "from and to must be dates written YYYY-MM-DD" };
  if (from > to) return { error: "from must not be after to" };
  const days = daysBetween(from, to) + 1;
  if (days > MAX_PERIOD_DAYS) return { error: `Choose a period of at most ${MAX_PERIOD_DAYS} days` };
  return { period: { days, from, fromUtc, to, toUtc } };
}

export function parsePeriod(query: URLSearchParams, now: Date = new Date()): ParsedPeriod {
  const from = query.get("from")?.trim() || null;
  const to = query.get("to")?.trim() || null;
  const today = darwinDay(now);
  if (from !== null || to !== null) {
    if (from === null || to === null) return { error: "Send both from and to, or neither" };
    return build(from, to);
  }
  const text = query.get("days")?.trim();
  const days = text ? Number(text) : DEFAULT_PERIOD_DAYS;
  if (!Number.isInteger(days) || days < 1 || days > MAX_PERIOD_DAYS) return { error: `days must be a whole number from 1 to ${MAX_PERIOD_DAYS}` };
  return build(addDays(today, 1 - days), today);
}
