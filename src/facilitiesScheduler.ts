// The facilities scheduler (sprint F; LAUNCH-READINESS §5 behaviour 5, WP50):
// everything facilities needs to happen because a date arrived. Run daily by
// schedulerTimer at 22:00 UTC (07:30 in Darwin).
//
//   defects reminders   60 and 30 days before a defects liability period ends,
//                       a defects_period escalation to the facilities manager
//                       (digest, not urgent). Raised once per period per end
//                       date: a reminder someone already dealt with is not
//                       raised again unless the end date changes.
//   service jobs        every active schedule whose NextDue - LeadDays has
//                       arrived and has no run for that due date gets its
//                       maintenance job (WP50), job and run row in one
//                       transaction. A due date inside a blocking defects period
//                       for the schedule's scope and service is skipped instead
//                       (run row "skipped_defects", NextDue moves on) and the log
//                       says why: the builder owes it, and the schedule resumes
//                       after the period ends.
//   overdue servicing   NextDue has passed: a service_schedule escalation, urgent
//                       for Fire & life safety and Lifts, digest for the rest.
//                       Once per schedule per due date.
//
// SCHEDULER_MAX_ACTIONS (default 100) caps the writes in one run, so switching
// it on against a backlog is paced over several days rather than one flood.
//
// Opt-in, because it writes: SCHEDULER_ENABLED must equal "true".
// SCHEDULER_DRY_RUN=true reads, logs with counts what it would do, and writes
// nothing (it wins over ENABLED). A failure on one record is collected and the
// run carries on; the timer reports the failures.

import { TYPES, type Connection } from "tedious";
import { addDaysIso, todayInDarwin } from "./darwinDate";
import { beginTransaction, commitTransaction, executeQuery, rollbackTransaction } from "./db";
import { displayDate, livePeriodsForBuilding, periodRowToApi, periodsEndingBetween, toCoveragePeriod } from "./defectsPeriods";
import { DEFECTS_POLICIES, DEFECTS_SUBJECT_TYPE, defectsPeriodLabel, defectsReminderHeadline } from "./escalation/adapters/defectsPeriod";
import { SCHEDULE_SUBJECT_TYPE, scheduleLabel, schedulePolicyFor } from "./escalation/adapters/serviceSchedule";
import { raise } from "./escalation/engine";
import { coveringPeriods, daysFromTo, defectsReminderStage, isGenerationDue, nextDueAfter } from "./facilitiesRules";
import type { LedgerActor } from "./ledger";
import { advanceNextDue, createScheduledJob, insertRun } from "./serviceScheduleRuns";
import { SELECT_SCHEDULE, scheduleCoverageJob, scheduleRowToApi, seriesOf, type ScheduleApi } from "./serviceSchedules";

export type SchedulerMode = "off" | "dry-run" | "live";

export function schedulerMode(env: NodeJS.ProcessEnv = process.env): SchedulerMode {
  if (env.SCHEDULER_DRY_RUN === "true") return "dry-run";
  return env.SCHEDULER_ENABLED === "true" ? "live" : "off";
}

export const SCHEDULER_ACTOR: LedgerActor = { kind: "system", name: "schedulerTimer" };
/** CreatedBy on the jobs and runs the scheduler writes. */
export const SCHEDULER_NAME = "Floorplan scheduler";
export const DEFAULT_SCHEDULER_MAX_ACTIONS = 100;

export function schedulerMaxActions(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number((env.SCHEDULER_MAX_ACTIONS ?? "").trim());
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SCHEDULER_MAX_ACTIONS;
}

export interface SchedulerOptions {
  dryRun: boolean;
  log: (message: string) => void;
  maxActions?: number;
  now?: Date;
  warn: (message: string) => void;
}

type RaiseCounts = { alreadyOpen: number; considered: number; raised: number; skippedAlreadySent: number; wouldRaise: number };

export interface SchedulerReport {
  /** Writes made (jobs, skips, escalations), against maxActions. */
  actions: number;
  defects: RaiseCounts;
  errors: string[];
  overdue: RaiseCounts;
  schedules: { alreadyDone: number; considered: number; created: number; skippedDefects: number; wouldCreate: number; wouldSkip: number };
  /** The run stopped at maxActions; the rest waits for tomorrow. */
  truncated: boolean;
}

const emptyCounts = (): RaiseCounts => ({ alreadyOpen: 0, considered: 0, raised: 0, skippedAlreadySent: 0, wouldRaise: 0 });

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const RAISED_FOR_END_DATE = `SELECT TOP 1 EscalationId FROM dbo.Escalations
  WHERE SubjectType = @SubjectType AND SubjectId = @SubjectId AND PolicyKey = @PolicyKey
    AND JSON_VALUE(Context, '$.endsOn') = @Date`;
const RAISED_FOR_DUE_DATE = `SELECT TOP 1 EscalationId FROM dbo.Escalations
  WHERE SubjectType = @SubjectType AND SubjectId = @SubjectId AND PolicyKey = @PolicyKey
    AND JSON_VALUE(Context, '$.nextDue') = @Date`;

/** Whether this escalation was ever raised (any status) for this subject and date. */
async function alreadyRaised(connection: Connection, sql: string, subjectType: string, subjectId: string, policyKey: string, date: string): Promise<boolean> {
  const rows = await executeQuery(connection, sql, [
    { name: "SubjectType", type: TYPES.NVarChar, value: subjectType },
    { name: "SubjectId", type: TYPES.NVarChar, value: subjectId },
    { name: "PolicyKey", type: TYPES.NVarChar, value: policyKey },
    { name: "Date", type: TYPES.NVarChar, value: date },
  ]);
  return rows.length > 0;
}

function hasRoom(options: SchedulerOptions, report: SchedulerReport): boolean {
  if (options.dryRun) return true;
  if (report.actions < (options.maxActions ?? DEFAULT_SCHEDULER_MAX_ACTIONS)) return true;
  report.truncated = true;
  return false;
}

async function runDefectsReminders(connection: Connection, options: SchedulerOptions, report: SchedulerReport): Promise<void> {
  const now = options.now ?? new Date();
  const today = todayInDarwin(now);
  const rows = await periodsEndingBetween(connection, today, addDaysIso(today, 60));
  for (const row of rows) {
    const period = periodRowToApi(row, today);
    const stage = defectsReminderStage(toCoveragePeriod(period), today);
    if (stage === null) continue;
    report.defects.considered += 1;
    const policyKey = stage === 30 ? DEFECTS_POLICIES.endsIn30 : DEFECTS_POLICIES.endsIn60;
    const subjectId = String(period.defectsPeriodId);
    if (!hasRoom(options, report)) break;
    try {
      if (await alreadyRaised(connection, RAISED_FOR_END_DATE, DEFECTS_SUBJECT_TYPE, subjectId, policyKey, period.endsOn)) {
        report.defects.skippedAlreadySent += 1;
        continue;
      }
      if (options.dryRun) {
        report.defects.wouldRaise += 1;
        options.log(`schedulerTimer (dry run): would raise ${policyKey} for defects period ${subjectId} (${defectsPeriodLabel(period)})`);
        continue;
      }
      const result = await raise(connection, {
        actor: SCHEDULER_ACTOR,
        context: { endsOn: period.endsOn },
        headline: defectsReminderHeadline(period, today),
        notify: { attempts: 2 },
        now,
        policyKey,
        skipConditionCheck: true,
        subjectId,
        subjectType: DEFECTS_SUBJECT_TYPE,
      });
      if (result.created) {
        report.defects.raised += 1;
        report.actions += 1;
      } else report.defects.alreadyOpen += 1;
    } catch (error) {
      report.errors.push(`defects period ${subjectId}: ${errorText(error)}`);
    }
  }
  const d = report.defects;
  options.log(
    `schedulerTimer: defects reminders: ${d.considered} due, ${d.raised} raised, ${d.alreadyOpen} already open, ${d.skippedAlreadySent} already sent${options.dryRun ? `, ${d.wouldRaise} would be raised (dry run)` : ""}`,
  );
}

// ── Service jobs ─────────────────────────────────────────────────────────────

const DUE_SCHEDULES = `${SELECT_SCHEDULE}
  WHERE s.Active = 1 AND s.ArchivedAt IS NULL AND s.NextDue <= DATEADD(day, s.LeadDays, @Today)
    AND NOT EXISTS (SELECT 1 FROM dbo.ServiceScheduleRuns r
                     WHERE r.ServiceScheduleId = s.ServiceScheduleId AND r.DueDate = s.NextDue)
  ORDER BY s.NextDue, s.ServiceScheduleId`;

const OVERDUE_SCHEDULES = `${SELECT_SCHEDULE}
  WHERE s.Active = 1 AND s.ArchivedAt IS NULL AND s.NextDue < @Today
  ORDER BY s.NextDue, s.ServiceScheduleId`;

const isUniqueViolation = (error: unknown): boolean => /UX_ServiceScheduleRuns_Schedule_Due|duplicate key/i.test(errorText(error));

async function inTx(connection: Connection, work: () => Promise<void>): Promise<void> {
  await beginTransaction(connection);
  try {
    await work();
    await commitTransaction(connection);
  } catch (error) {
    await rollbackTransaction(connection).catch(() => undefined);
    throw error;
  }
}

async function generateOne(connection: Connection, schedule: ScheduleApi, options: SchedulerOptions, report: SchedulerReport): Promise<void> {
  const due = schedule.nextDue;
  const id = schedule.serviceScheduleId;
  const label = `schedule ${id} (${schedule.name}) due ${displayDate(due)}`;
  const covering = coveringPeriods(scheduleCoverageJob(schedule), await livePeriodsForBuilding(connection, schedule.buildingId, due), due)
    .filter((period) => period.enforcement === "block");

  if (covering.length > 0) {
    const [period] = covering;
    const why = `inside the ${period.works} defects period to ${displayDate(period.endsOn)}: ${period.contractorName ?? "the builder"} owes it`;
    if (options.dryRun) {
      report.schedules.wouldSkip += 1;
      options.log(`schedulerTimer (dry run): would skip ${label}, ${why}`);
      return;
    }
    const next = nextDueAfter(seriesOf(schedule), due);
    await inTx(connection, async () => {
      await insertRun(connection, { actorName: SCHEDULER_NAME, defectsPeriodId: period.defectsPeriodId, due, jobId: null, outcome: "skipped_defects", scheduleId: id });
      await advanceNextDue(connection, id, due, next, null, SCHEDULER_NAME);
    });
    report.schedules.skippedDefects += 1;
    report.actions += 1;
    options.log(`schedulerTimer: skipped ${label}, ${why}; next due ${displayDate(next)}`);
    return;
  }

  if (options.dryRun) {
    report.schedules.wouldCreate += 1;
    options.log(`schedulerTimer (dry run): would create the job for ${label}`);
    return;
  }
  let jobId = 0;
  await inTx(connection, async () => {
    jobId = await createScheduledJob(connection, schedule, due, SCHEDULER_NAME);
  });
  report.schedules.created += 1;
  report.actions += 1;
  options.log(`schedulerTimer: created job #${jobId} for ${label}`);
}

async function runServiceJobs(connection: Connection, options: SchedulerOptions, report: SchedulerReport, today: string): Promise<void> {
  const rows = await executeQuery(connection, DUE_SCHEDULES, [{ name: "Today", type: TYPES.Date, value: today }]);
  for (const row of rows) {
    const schedule = scheduleRowToApi(row, today);
    if (!isGenerationDue(schedule.nextDue, schedule.leadDays, today)) continue;
    report.schedules.considered += 1;
    if (!hasRoom(options, report)) break;
    try {
      await generateOne(connection, schedule, options, report);
    } catch (error) {
      if (isUniqueViolation(error)) report.schedules.alreadyDone += 1;
      else report.errors.push(`schedule ${schedule.serviceScheduleId}: ${errorText(error)}`);
    }
  }
  const c = report.schedules;
  options.log(
    `schedulerTimer: service jobs: ${c.considered} due, ${c.created} created, ${c.skippedDefects} skipped (defects period), ${c.alreadyDone} already done${options.dryRun ? `, ${c.wouldCreate} would be created, ${c.wouldSkip} would be skipped (dry run)` : ""}`,
  );
}

async function runOverdue(connection: Connection, options: SchedulerOptions, report: SchedulerReport, today: string, now: Date): Promise<void> {
  const rows = await executeQuery(connection, OVERDUE_SCHEDULES, [{ name: "Today", type: TYPES.Date, value: today }]);
  for (const row of rows) {
    const schedule = scheduleRowToApi(row, today);
    report.overdue.considered += 1;
    if (!hasRoom(options, report)) break;
    const policyKey = schedulePolicyFor(schedule);
    const subjectId = String(schedule.serviceScheduleId);
    try {
      if (await alreadyRaised(connection, RAISED_FOR_DUE_DATE, SCHEDULE_SUBJECT_TYPE, subjectId, policyKey, schedule.nextDue)) {
        report.overdue.skippedAlreadySent += 1;
        continue;
      }
      if (options.dryRun) {
        report.overdue.wouldRaise += 1;
        options.log(`schedulerTimer (dry run): would raise ${policyKey} for ${scheduleLabel(schedule)}`);
        continue;
      }
      const days = daysFromTo(schedule.nextDue, today);
      const result = await raise(connection, {
        actor: SCHEDULER_ACTOR,
        context: { nextDue: schedule.nextDue },
        headline: `Overdue by ${days} day${days === 1 ? "" : "s"}`,
        notify: { attempts: 2 },
        now,
        policyKey,
        skipConditionCheck: true,
        subjectId,
        subjectType: SCHEDULE_SUBJECT_TYPE,
      });
      if (result.created) {
        report.overdue.raised += 1;
        report.actions += 1;
      } else report.overdue.alreadyOpen += 1;
    } catch (error) {
      report.errors.push(`overdue schedule ${subjectId}: ${errorText(error)}`);
    }
  }
  const o = report.overdue;
  options.log(
    `schedulerTimer: overdue servicing: ${o.considered} overdue, ${o.raised} raised, ${o.alreadyOpen} already open, ${o.skippedAlreadySent} already sent${options.dryRun ? `, ${o.wouldRaise} would be raised (dry run)` : ""}`,
  );
}

export async function runFacilitiesScheduler(connection: Connection, options: SchedulerOptions): Promise<SchedulerReport> {
  const now = options.now ?? new Date();
  const today = todayInDarwin(now);
  const report: SchedulerReport = {
    actions: 0,
    defects: emptyCounts(),
    errors: [],
    overdue: emptyCounts(),
    schedules: { alreadyDone: 0, considered: 0, created: 0, skippedDefects: 0, wouldCreate: 0, wouldSkip: 0 },
    truncated: false,
  };
  const steps: Array<[string, () => Promise<void>]> = [
    ["defects reminders", () => runDefectsReminders(connection, options, report)],
    ["service jobs", () => runServiceJobs(connection, options, report, today)],
    ["overdue servicing", () => runOverdue(connection, options, report, today, now)],
  ];
  for (const [name, step] of steps) {
    try {
      await step();
    } catch (error) {
      report.errors.push(`${name}: ${errorText(error)}`);
    }
  }
  if (report.truncated) options.warn(`schedulerTimer: stopped at ${options.maxActions ?? DEFAULT_SCHEDULER_MAX_ACTIONS} writes; the rest waits for the next run`);
  return report;
}
