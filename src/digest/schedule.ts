// When the morning digest goes out, as pure rules over an instant. Darwin is
// UTC+09:30 all year, the Function host runs UTC and WEBSITE_TIME_ZONE stays
// unset, so the timer is written in UTC and the handler re-checks the Darwin
// calendar itself (src/escalation/businessTime.ts): a Darwin weekend or public
// holiday sends nothing, and neither does a run that is hours late.

import { darwinDateKey, darwinMinuteOfDay, holidaysFromEnv, isBusinessDay } from "../escalation/businessTime";

/** 22:00 UTC Sunday to Thursday is 07:30 Darwin Monday to Friday. */
export const DIGEST_CRON = "0 0 22 * * 0-4";

/** The digest is a morning email: a run that lands outside 07:00 to 12:00 Darwin
 *  (a missed run catching up after a restart) is skipped, not sent at teatime. */
export const WINDOW_START_MINUTES = 7 * 60;
export const WINDOW_END_MINUTES = 12 * 60;

export type SkipReason = "holiday" | "too_early" | "too_late" | "weekend";

export type DigestRunDecision =
  | { darwinDate: string; run: true }
  | { darwinDate: string; reason: SkipReason; run: false };

function isWeekend(dateKey: string): boolean {
  const weekday = new Date(`${dateKey}T00:00:00Z`).getUTCDay();
  return weekday === 0 || weekday === 6;
}

/** Whether a run starting at `now` should go ahead, by the Darwin calendar and clock. */
export function digestRunDecision(now: Date, env: NodeJS.ProcessEnv = process.env): DigestRunDecision {
  const darwinDate = darwinDateKey(now);
  if (!isBusinessDay(darwinDate, holidaysFromEnv(env))) {
    return { darwinDate, reason: isWeekend(darwinDate) ? "weekend" : "holiday", run: false };
  }
  const minute = darwinMinuteOfDay(now);
  if (minute < WINDOW_START_MINUTES) return { darwinDate, reason: "too_early", run: false };
  if (minute >= WINDOW_END_MINUTES) return { darwinDate, reason: "too_late", run: false };
  return { darwinDate, run: true };
}
