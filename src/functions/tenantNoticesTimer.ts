import { app, InvocationContext, Timer } from "@azure/functions";
import { closeConnection, createServiceRequestConnection } from "../db";
import { Sentry } from "../sentry";
import { noticesMode } from "../tenantNotices/config";
import { runTenantNoticeSweep } from "../tenantNotices/sweep";
import { runTimer, type TimerCounts } from "../timerRuns";

// ── Timer trigger: every two minutes ─────────────────────────────────────────
// Sends the status notices owed to tenants (TR4, PLAN §15, src/tenantNotices): "a contractor is booked" and "the work
// is complete", once per job, to the tenancy's contacts. It sends email tenants will receive, so it is opt-in:
//   TENANT_NOTICES_ENABLED=true   notices are queued through the comms core (which has its own send switches)
//   TENANT_NOTICES_DRY_RUN=true   logs who would be told and marks the notice dry_run; queues nothing (wins)
//   neither                       does nothing and does not touch the database
// Apply migration 186 first. Staging: set DEV_EMAIL_OVERRIDE. Test tenancies never get mail.

export async function tenantNoticesTimer(_timer: Timer, context: InvocationContext): Promise<TimerCounts | void> {
  if (noticesMode() === "off") {
    context.log("tenantNoticesTimer: off. Set TENANT_NOTICES_DRY_RUN=true to see what it would send, then TENANT_NOTICES_ENABLED=true.");
    return;
  }
  let connection;
  try {
    connection = await createServiceRequestConnection();
    const report = await runTenantNoticeSweep(connection, (message) => context.log(message));
    context.log(`tenantNoticesTimer: ${JSON.stringify(report)}`);
    return { ...report, dryRun: report.mode === "dry-run" };
  } catch (error: unknown) {
    context.error("tenantNoticesTimer failed:", error instanceof Error ? error.message : String(error));
    Sentry.captureException(error, { extra: { context: "tenantNoticesTimer fatal" } });
    throw error;
  } finally {
    if (connection) closeConnection(connection);
    await Sentry.flush(2000);
  }
}

app.timer("tenantNoticesTimer", {
  schedule: "0 */2 * * * *",
  handler: runTimer("tenantNoticesTimer", tenantNoticesTimer),
});
