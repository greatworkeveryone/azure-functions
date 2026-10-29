import {purgeWorkflowSignals} from "../performance/purgeSignals";
import { app, InvocationContext, Timer } from "@azure/functions";
import { closeConnection, createServiceRequestConnection } from "../db";
import { Sentry } from "../sentry";
import { runTimer, type TimerCounts } from "../timerRuns";
import { dailyRetentionDays, purgeMode, retentionDays } from "../usage/config";
import { MAX_PER_RUN, purgeUsage } from "../usage/purge";

// ── Timer trigger: 16:30 UTC daily (an hour after the roll-up) ──────────────────────────────────
// Usage retention (PLAN §14; src/usage/purge.ts). Deletes raw usage rows (UsageViews, UsageSessions)
// older than USAGE_RETENTION_DAYS (default 180, never fewer than 30), only for days that are already
// rolled up, and a person's daily totals (UsageDaily) older than USAGE_DAILY_RETENTION_DAYS (default 730, never
// fewer than the raw days), whole days at a time. Devices are never deleted. Opt-in, because it deletes in bulk
// (database-safety rule 2):
//   USAGE_PURGE_ENABLED=true   deletes
//   USAGE_PURGE_DRY_RUN=true   counts and logs what it would delete, deletes nothing (wins)
//   neither                    does nothing and does not touch the database
// Counts are logged and stored by runTimer; a run that reaches its cap raises a Sentry message,
// because that means far more than a normal day's rows were past retention.

export async function usagePurgeTimer(_timer: Timer, context: InvocationContext): Promise<TimerCounts | void> {
  const mode = purgeMode();
  if (mode === "off") {
    context.log("usagePurgeTimer: off. Set USAGE_PURGE_DRY_RUN=true to see what it would delete, then USAGE_PURGE_ENABLED=true.");
    return;
  }
  let connection;
  try {
    connection = await createServiceRequestConnection();
    const counts = await purgeUsage(connection, { dailyRetentionDays: dailyRetentionDays(), dryRun: mode === "dry-run", retentionDays: retentionDays() });
    const workflowSignals=await purgeWorkflowSignals(connection,retentionDays(),mode === "dry-run");
    context.log("Workflow signal retention",workflowSignals);
    context.log(
      `usagePurgeTimer: before ${counts.cutoffDay}: views ${counts.viewsDeleted} of ${counts.viewsEligible} deleted, ` +
        `sessions ${counts.sessionsDeleted} of ${counts.sessionsEligible}; daily totals before ${counts.dailyCutoffDay}: ${counts.dailyDeleted} of ${counts.dailyEligible}${counts.dryRun ? " (dry run: nothing deleted)" : ""}`,
    );
    if (counts.viewsDeleted >= MAX_PER_RUN || counts.sessionsDeleted >= MAX_PER_RUN) {
      Sentry.captureMessage("usagePurgeTimer reached its per-run cap: far more raw usage rows than usual were past retention", { level: "warning" });
    }
    return { ...counts };
  } catch (error: unknown) {
    context.error("usagePurgeTimer failed:", error instanceof Error ? error.message : String(error));
    Sentry.captureException(error, { extra: { context: "usagePurgeTimer" } });
    throw error;
  } finally {
    if (connection) closeConnection(connection);
    await Sentry.flush(2000);
  }
}

app.timer("usagePurgeTimer", {
  handler: runTimer("usagePurgeTimer", usagePurgeTimer),
  schedule: "0 30 16 * * *",
});
