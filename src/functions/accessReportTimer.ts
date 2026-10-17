import { runTimer } from "../timerRuns";
import { app, InvocationContext, Timer } from "@azure/functions";
import { sendAnomalyReport } from "../access/report";
import { Sentry } from "../sentry";

// ── Timer trigger: 07:00 ACST (Darwin) daily ─────────────────────────────────
// The daily unusual-access email to admin and the CFO (S10, decision 15), sent
// only when the last 24 hours had an anomaly. Always registered (so the timer
// guard and TimerRuns see it); the body does nothing unless
// ACCESS_REPORT_ENABLED is exactly "true", so it stays off until Graph mail is
// set up on the environment (database-safety rule 2: opt-in timers).
//
// WEBSITE_TIME_ZONE is not set in production, so the schedule is UTC. Darwin is
// UTC+9:30 with no DST → 07:00 ACST = 21:30 UTC the previous day.

export async function accessReportTimer(_timer: Timer, context: InvocationContext): Promise<void> {
  if (process.env.ACCESS_REPORT_ENABLED !== "true") {
    context.log("accessReportTimer: skipped (set ACCESS_REPORT_ENABLED=true to send the daily anomaly report)");
    return;
  }
  try {
    const result = await sendAnomalyReport();
    context.log(
      `accessReportTimer: ${result.count} anomal${result.count === 1 ? "y" : "ies"}, ` +
        `${result.sent ? `sent to ${result.recipients}` : "nothing sent"}`,
    );
  } catch (error: unknown) {
    context.error("accessReportTimer failed:", error instanceof Error ? error.message : String(error));
    Sentry.captureException(error, { extra: { context: "accessReportTimer" } });
    throw error;
  } finally {
    await Sentry.flush(2000);
  }
}

app.timer("accessReportTimer", {
  handler: runTimer("accessReportTimer", accessReportTimer),
  schedule: "0 30 21 * * *",
});
