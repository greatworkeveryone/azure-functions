import { app, InvocationContext, Timer } from "@azure/functions";
import { closeConnection, createServiceRequestConnection } from "../db";
import { runFacilitiesScheduler, schedulerMode, type SchedulerReport } from "../facilitiesScheduler";
import { Sentry } from "../sentry";

// ── Timer trigger: daily at 22:00 UTC (07:30 in Darwin) ──────────────────────
// The facilities scheduler (src/facilitiesScheduler.ts, sprint F): defects
// period reminders 60 and 30 days before the end.
//
// Opt-in, because it writes:
//   SCHEDULER_ENABLED=true   it raises reminders (through the escalation engine)
//   SCHEDULER_DRY_RUN=true   logs, with counts, what it would do and writes nothing
//                            (wins over ENABLED)
//   neither                  it does nothing and does not touch the database
// Turn on the dry run first and read the counts in the log.
//
// runSchedulerTimer is the plain body so lane D's runTimer (TimerRuns) can wrap
// it at integration.

export async function runSchedulerTimer(
  context: InvocationContext,
  env: NodeJS.ProcessEnv = process.env,
): Promise<SchedulerReport | null> {
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
      warn: (message) => context.warn(message),
    });
    if (report.errors.length > 0) {
      for (const error of report.errors) context.warn(`schedulerTimer: ${error}`);
      Sentry.captureMessage(`Facilities scheduler finished with ${report.errors.length} problem(s): ${report.errors[0]}`, "error");
    }
    return report;
  } catch (error: unknown) {
    context.error("schedulerTimer failed:", error instanceof Error ? error.message : String(error));
    Sentry.captureException(error, { tags: { source: "scheduler_timer" } });
    throw error;
  } finally {
    if (connection) closeConnection(connection);
    await Sentry.flush(2000);
  }
}

export async function schedulerTimer(_timer: Timer, context: InvocationContext): Promise<void> {
  await runSchedulerTimer(context);
}

app.timer("schedulerTimer", {
  schedule: "0 0 22 * * *",
  handler: schedulerTimer,
});
