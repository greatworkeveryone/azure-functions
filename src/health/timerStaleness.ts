// How long each timer may go without a run before health calls it stale: twice its
// schedule. A timer that stopped (host asleep, app setting, deploy slot) reads red
// instead of green. A timer with no run at all is not stale: most are new or opt-in
// and say "never ran" instead.

import { TIMER_NAMES, type TimerName } from "../timerRuns";

const MIN = 1;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Longest gap, in minutes, that is still healthy. Twice the schedule, widened where the schedule skips days. */
export const MAX_GAP_MINUTES: Record<TimerName, number> = {
  absenceCoverTimer: 4 * DAY, // every 30 minutes Mon-Fri: Friday evening to Monday plus a public holiday
  accessReportTimer: 2 * DAY,
  commsSendTimer: 10 * MIN,
  digestTimer: 4 * DAY, // Sunday to Thursday nights: Thursday to Sunday is 3 days
  escalationSweepTimer: 2 * HOUR,
  leaseEventsGeneratorTimer: 2 * DAY,
  ledgerVerifyTimer: 2 * DAY,
  myobDailyEmailTimer: 4 * DAY, // shares the digest schedule
  myobReadbackTimer: 2 * HOUR,
  parseEmailsDailyRetry: 2 * DAY,
  parseEmailsTimer: 10 * MIN,
  plannerSyncTimer: 2 * DAY,
  renewGraphSubscription: 2 * DAY,
  schedulerTimer: 2 * DAY,
  syncAllWorkRequestsTimer: 2 * DAY,
  tenancyCpiSyncTimer: 2 * DAY,
  tenancyReviewScheduleTimer: 2 * DAY,
  timesheetSyncTimer: 14 * DAY, // weekly
  usagePurgeTimer: 2 * DAY,
  usageRollupTimer: 2 * DAY,
};

export interface TimerReading {
  lastRun: { error: string | null; finishedAt: string | null; outcome: string; startedAt: string | null } | null;
  /** Longest healthy gap since the last start, in minutes. */
  maxGapMinutes: number;
  name: string;
  /** True when the last run started longer ago than maxGapMinutes. False when it has never run. */
  stale: boolean;
}

export function readTimer(
  name: string,
  lastRun: TimerReading["lastRun"],
  now: Date,
): TimerReading {
  const maxGapMinutes = (MAX_GAP_MINUTES as Record<string, number | undefined>)[name] ?? 2 * DAY;
  const started = lastRun?.startedAt ? new Date(lastRun.startedAt).getTime() : Number.NaN;
  const stale = Number.isFinite(started) && now.getTime() - started > maxGapMinutes * 60_000;
  return { lastRun, maxGapMinutes, name, stale };
}

/** Every timer in TIMER_NAMES has a stated gap (a guard test keeps this true). */
export const TIMERS_WITHOUT_GAP: string[] = TIMER_NAMES.filter((n) => MAX_GAP_MINUTES[n] === undefined);
