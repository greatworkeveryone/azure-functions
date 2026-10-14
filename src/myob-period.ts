// No new data in prior periods (decision 11). Checked inside myobRequest on
// every company-file write, from the body actually being sent:
//   - a create must be dated today in Darwin;
//   - an update must keep a date inside the current period, up to today;
//   - nothing may be dated before the period start: MYOB_PERIOD_START
//     (YYYY-MM-DD, Johanne's lock date when she gives one), else the first day
//     of the current Darwin month.
// myobRequest passes the serialised bytes it will send, not the caller's
// object, so toJSON can't show the guard one date and MYOB another; and since
// MYOB reads JSON names without regard to case (last value wins), any other
// spelling of "Date" is refused. Anything unreadable is refused: this guard
// fails closed.

import { isIsoDate, todayInDarwin } from "./darwinDate";

const MYOB_DATE = /^(\d{4}-\d{2}-\d{2})(?:T00:00:00(?:\.0+)?Z?)?$/;

export type PeriodVerdict = { ok: true } | { ok: false; reason: string };

export function periodStart(now: Date = new Date()): { ok: true; date: string } | { ok: false; reason: string } {
  const configured = process.env.MYOB_PERIOD_START?.trim();
  if (configured) {
    return isIsoDate(configured)
      ? { date: configured, ok: true }
      : { ok: false, reason: `MYOB_PERIOD_START is not a date (YYYY-MM-DD): "${configured}"` };
  }
  return { date: `${todayInDarwin(now).slice(0, 8)}01`, ok: true };
}

function readBody(body: unknown): Record<string, unknown> | null {
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return body && typeof body === "object" && !Array.isArray(body) && !(body instanceof URLSearchParams)
    ? (body as Record<string, unknown>)
    : null;
}

/** Checks the `Date` a MYOB write carries against the current period. */
export function checkMyobPeriod(rule: "today" | "period", body: unknown, now: Date = new Date()): PeriodVerdict {
  const record = readBody(body);
  if (!record) return { ok: false, reason: "The MYOB write has no readable body, so its date can't be checked" };
  const stray = Object.keys(record).find((key) => /^date$/i.test(key) && key !== "Date");
  if (stray) {
    return { ok: false, reason: `The MYOB write carries "${stray}" beside Date; MYOB would read either, so it is refused` };
  }
  const raw = record.Date;
  const match = typeof raw === "string" ? MYOB_DATE.exec(raw) : null;
  if (!match || !isIsoDate(match[1])) {
    return { ok: false, reason: "The MYOB write has no Date (YYYY-MM-DD), so its period can't be checked" };
  }
  const date = match[1];
  const today = todayInDarwin(now);
  const start = periodStart(now);
  if (!start.ok) return start;

  if (date < start.date) {
    return { ok: false, reason: `Dated ${date}, before the current period (${start.date}): no new data in prior periods` };
  }
  if (rule === "today" && date !== today) {
    return { ok: false, reason: `Dated ${date}; a record Floorplan creates in MYOB must be dated today in Darwin (${today})` };
  }
  if (date > today) return { ok: false, reason: `Dated ${date}, after today in Darwin (${today})` };
  return { ok: true };
}
