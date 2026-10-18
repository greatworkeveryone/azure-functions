import { app, InvocationContext, Timer } from "@azure/functions";
import { runTimer, type TimerCounts } from "../timerRuns";
import { closeConnection, createServiceRequestConnection } from "../db";
import { runFacilitiesScheduler, schedulerMaxActions, schedulerMode, type SchedulerReport } from "../facilitiesScheduler";
import { Sentry } from "../sentry";

/** One flat set of counts, as lane D's runTimer records in TimerRuns. Errors
 *  are counted because a per-record failure doesn't throw: the wrap should
 *  not mark a run with failures as clean. */
export type SchedulerCounts = Record<string, boolean | number | string>;

export function schedulerCounts(report: SchedulerReport, mode: string): SchedulerCounts {
  return {
    alreadyDone: report.schedules.alreadyDone,
    created: report.schedules.created,
    errors: report.errors.length,
    escalated: report.overdue.raised,
    mode,
    remindersRaised: report.defects.raised,
    skippedDefects: report.schedules.skippedDefects,
    truncated: report.truncated,
    wouldCreate: report.schedules.wouldCreate,
    wouldEscalate: report.overdue.wouldRaise,
    wouldRemind: report.defects.wouldRaise,
    wouldSkip: report.schedules.wouldSkip,
  };
}

// ── Timer trigger: daily at 22:00 UTC (07:30 in Darwin) ──────────────────────
// The facilities scheduler (src/facilitiesScheduler.ts, sprint F): defects
// period reminders 60 and 30 days before the end (F1); maintenance jobs from
// service schedules, lead days before they are due, skipping due dates inside a
// blocking defects period; escalations for overdue servicing (F2).
//
// Opt-in, because it writes:
//   SCHEDULER_ENABLED=true   it raises reminders, creates service jobs, raises overdue
//                            escalations (through the escalation engine)
//   SCHEDULER_DRY_RUN=true   logs, with counts, what it would do and writes nothing
//                            (wins over ENABLED)
//   neither                  it does nothing and does not touch the scheduler's tables
//                            (runTimer still writes its own dbo.TimerRuns row)
//   SCHEDULER_MAX_ACTIONS    most writes in one run (default 100)
// Turn on the dry run first and read the counts in the log.
//
// runSchedulerTimer is the plain body. The registered handler wraps it in
// runTimer, stores its flat counts in TimerRuns, and fails the run (Outcome
// 'error', a failed invocation) when the scheduler reported any problem, as the
// other timers do: a per-record failure doesn't throw, so without this a run
// with errors was logged as clean.

interface SchedulerRun {
  counts: SchedulerCounts;
  firstError: string | null;
}

async function execute(context: InvocationContext, env: NodeJS.ProcessEnv): Promise<SchedulerRun | null> {
  const mode = schedulerMode(env);
  if (mode === "off") {
    context.log("schedulerTimer: off. Set SCHEDULER_DRY_RUN=true to see what it would do, then SCHEDULER_ENABLED=true.");
    return null;
  }

  let connection;
  try {
    connection = await createServiceRequestConnection();
    const report = await runFacilitiesScheduler(connection, {
      dryRun: mode === "dry-run",
      log: (message) => context.log(message),
      maxActions: schedulerMaxActions(env),
      warn: (message) => context.warn(message),
    });
    if (report.truncated) {
      Sentry.captureMessage("Facilities scheduler stopped at its action limit; the rest waits for the next run", "warning");
    }
    if (report.errors.length > 0) {
      for (const error of report.errors) context.warn(`schedulerTimer: ${error}`);
      Sentry.captureMessage(`Facilities scheduler finished with ${report.errors.length} problem(s): ${report.errors[0]}`, "error");
    }
    return { counts: schedulerCounts(report, mode), firstError: report.errors[0] ?? null };
  } catch (error: unknown) {
    context.error("schedulerTimer failed:", error instanceof Error ? error.message : String(error));
    Sentry.captureException(error, { tags: { source: "scheduler_timer" } });
    throw error;
  } finally {
    if (connection) closeConnection(connection);
    await Sentry.flush(2000);
  }
}

export async function runSchedulerTimer(
  context: InvocationContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SchedulerCounts | null> {
  return (await execute(context, env))?.counts ?? null;
}

export async function schedulerTimer(_timer: Timer, context: InvocationContext): Promise<TimerCounts> {
  const run = await execute(context, process.env);
  if (!run) return { mode: "off" };
  const errors = Number(run.counts.errors);
  if (errors > 0) throw new Error(`Facilities scheduler: ${errors} problem(s); first: ${run.firstError}`);
  return run.counts;
}

app.timer("schedulerTimer", {
  schedule: "0 0 22 * * *",
  handler: runTimer("schedulerTimer", schedulerTimer),
});
