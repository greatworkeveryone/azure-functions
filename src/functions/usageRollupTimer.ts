import { app, InvocationContext, Timer } from "@azure/functions";
import { closeConnection, createServiceRequestConnection } from "../db";
import { Sentry } from "../sentry";
import { runTimer, type TimerCounts } from "../timerRuns";
import { usageTrackingOn } from "../usage/config";
import { recentRollupRange, rollUpDays } from "../usage/rollup";

// ── Timer trigger: 15:30 UTC daily (01:00 in Darwin, just after the Darwin day ends) ────────────
// Usage analytics roll-up (PLAN §14; src/usage/rollup.ts): recomputes UsageDaily for the last three
// Darwin days from the raw usage rows, so a late heartbeat is caught and today's partial day is
// there for the screens. It writes only UsageDaily, from tables it reads, and a figure is only ever
// replaced by a larger one. Runs only while USAGE_TRACKING_ENABLED is "true"; an admin can also run
// it on demand (runUsageRollup). runTimer records the counts in dbo.TimerRuns.

export async function usageRollupTimer(_timer: Timer, context: InvocationContext): Promise<TimerCounts | void> {
  if (!usageTrackingOn()) {
    context.log("usageRollupTimer: skipped (set USAGE_TRACKING_ENABLED=true to record and roll up usage)");
    return;
  }
  let connection;
  try {
    connection = await createServiceRequestConnection();
    const { from, to } = recentRollupRange();
    const counts = await rollUpDays(connection, from, to);
    context.log(`usageRollupTimer: ${from} to ${to}: ${counts.inserted} new, ${counts.updated} refreshed`);
    return { days: counts.days, inserted: counts.inserted, updated: counts.updated };
  } catch (error: unknown) {
    context.error("usageRollupTimer failed:", error instanceof Error ? error.message : String(error));
    Sentry.captureException(error, { extra: { context: "usageRollupTimer" } });
    throw error;
  } finally {
    if (connection) closeConnection(connection);
    await Sentry.flush(2000);
  }
}

app.timer("usageRollupTimer", {
  handler: runTimer("usageRollupTimer", usageRollupTimer),
  schedule: "0 30 15 * * *",
});
