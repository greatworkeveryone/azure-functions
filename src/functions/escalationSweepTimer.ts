import { app, InvocationContext, Timer } from "@azure/functions";
import { closeConnection, createServiceRequestConnection } from "../db";
import { sweepMode } from "../escalation/config";
import { runSweep } from "../escalation/sweep";
import { Sentry } from "../sentry";
import { runTimer } from "../timerRuns";

// ── Timer trigger: every 30 minutes ───────────────────────────────────────────
// The escalation sweep (PLAN §3.7, src/escalation/sweep.ts): ends escalations
// whose condition has cleared, moves overdue ones up a level, raises the job
// policies (stalled, unassigned, quote not back, invoice waiting, past due),
// restarts the clock on follow-up emails, retries failed notifications and
// raises system.health to admin when something is wrong. It stands on its own:
// no PLANNER_* setting is needed.
//
// WEBSITE_TIME_ZONE is not set in production, so the schedule runs in UTC; every
// 30 minutes is every 30 minutes in Darwin (UTC+9:30) too.
//
// Opt-in, because it writes in bulk:
//   ESCALATION_SWEEP_ENABLED=true   the sweep writes (raises, moves up, ends, emails)
//   ESCALATION_SWEEP_DRY_RUN=true   logs, with counts, what it would raise, supersede
//                                   or resolve, and writes nothing (wins over ENABLED)
//   neither                         it does nothing and does not touch the database
//   ESCALATION_SWEEP_MAX_ACTIONS    most writes in one run (default 100), so turning it on
//                                   against a backlog is paced over several runs
// Turn on the dry run first and read the counts in the log.

export async function escalationSweepTimer(_timer: Timer, context: InvocationContext): Promise<void> {
  const mode = sweepMode();
  if (mode === "off") {
    context.log("escalationSweepTimer: off. Set ESCALATION_SWEEP_DRY_RUN=true to see what it would do, then ESCALATION_SWEEP_ENABLED=true.");
    return;
  }

  let connection;
  try {
    // A fresh connection, not the shared singleton: the sweep runs transactions.
    connection = await createServiceRequestConnection();
    const report = await runSweep(connection, {
      dryRun: mode === "dry-run",
      log: (message) => context.log(message),
      warn: (message) => context.warn(message),
    });
    if (report.truncated) {
      Sentry.captureMessage("Escalation sweep stopped at its action limit; the rest waits for the next run", "warning");
    }
    if (report.errors.length > 0) {
      Sentry.captureMessage(`Escalation sweep finished with ${report.errors.length} problem(s): ${report.errors[0]}`, "error");
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("escalationSweepTimer failed:", message);
    Sentry.captureException(error, { tags: { source: "escalation_sweep_timer" } });
    throw error;
  } finally {
    if (connection) closeConnection(connection);
    await Sentry.flush(2000);
  }
}

app.timer("escalationSweepTimer", {
  schedule: "0 */30 * * * *",
  handler: runTimer("escalationSweepTimer", escalationSweepTimer),
});
