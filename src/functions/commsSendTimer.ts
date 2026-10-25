import { app, InvocationContext, Timer } from "@azure/functions";
import { commsMode, fromAddress, maxPerMinute } from "../comms/config";
import { createGraphSender } from "../comms/graphSend";
import { sqlQueueStore } from "../comms/queueStore";
import { runCommsQueue } from "../comms/worker";
import { closeConnection, createServiceRequestConnection } from "../db";
import { Sentry } from "../sentry";
import { runTimer, type TimerCounts } from "../timerRuns";

// ── Timer trigger: every minute ──────────────────────────────────────────────
// The email send queue (EB1, src/comms/worker.ts): takes queued recipients oldest first, at most
// COMMS_MAX_PER_MINUTE a minute, and sends each as its own message from the one sender, with the
// reply-to and signature the job was queued with. It sends email people will receive, so it is
// opt-in (database-safety rule 2):
//   COMMS_SEND_ENABLED=true   the queue sends
//   COMMS_SEND_DRY_RUN=true   composes every email, logs and marks each recipient would-send, calls
//                             nothing (wins over ENABLED); turning it off and ENABLED on sends them
//   neither                   it does nothing and does not touch the database
// Apply migration 108 first. Set DEV_EMAIL_OVERRIDE on staging: every recipient then goes to that one
// address. A recipient tied to a test record never leaves. runTimer records each run in dbo.TimerRuns.

export async function commsSendTimer(_timer: Timer, context: InvocationContext): Promise<TimerCounts | void> {
  const mode = commsMode();
  if (mode === "off") {
    context.log("commsSendTimer: off. Set COMMS_SEND_DRY_RUN=true to see what it would send, then COMMS_SEND_ENABLED=true.");
    return;
  }
  let connection;
  try {
    connection = await createServiceRequestConnection();
    const report = await runCommsQueue({
      fromAddress: fromAddress(),
      log: (message) => context.log(message),
      maxPerMinute: maxPerMinute(),
      mode,
      sender: createGraphSender(),
      store: sqlQueueStore(connection),
    });
    context.log(`commsSendTimer: ${mode}, ${JSON.stringify(report)}`);
    return { ...report, dryRun: mode === "dry-run" };
  } catch (error: unknown) {
    context.error("commsSendTimer failed:", error instanceof Error ? error.message : String(error));
    Sentry.captureException(error, { extra: { context: "commsSendTimer fatal" } });
    throw error;
  } finally {
    if (connection) closeConnection(connection);
    await Sentry.flush(2000);
  }
}

app.timer("commsSendTimer", {
  schedule: "0 * * * * *",
  handler: runTimer("commsSendTimer", commsSendTimer),
});
