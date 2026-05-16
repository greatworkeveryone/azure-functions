import { app, InvocationContext, Timer } from "@azure/functions";
import { closeConnection, createServiceConnection, executeQuery } from "../db";

// ── Timer trigger: 07:30 ACST (Darwin) weekdays ──────────────────────────────
// The free-tier Azure SQL DB auto-pauses after ~1h idle and takes 30–60s to
// resume on the first query of the day. This timer fires a trivial SELECT 1
// just before business hours so users don't eat the cold-start latency.
// Darwin is UTC+9:30 with no DST → 07:30 ACST = 22:00 UTC previous day.
// Mon–Fri local = Sun–Thu UTC, hence day-of-week 0-4.

async function sqlKeepWarmTimer(
  _timer: Timer,
  context: InvocationContext,
): Promise<void> {
  const started = Date.now();
  let connection;
  try {
    connection = await createServiceConnection();
    await executeQuery(connection, "SELECT 1");
    context.log(`sqlKeepWarmTimer: DB warm in ${Date.now() - started}ms`);
  } catch (error: any) {
    context.error("sqlKeepWarmTimer: failed to wake DB:", error.message);
    throw error;
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.timer("sqlKeepWarmTimer", {
  schedule: "0 0 22 * * 0-4",
  handler: sqlKeepWarmTimer,
});
