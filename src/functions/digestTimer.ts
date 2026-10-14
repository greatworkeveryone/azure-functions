import { app, InvocationContext, Timer } from "@azure/functions";
import { closeConnection, createServiceRequestConnection } from "../db";
import { digestMode } from "../digest/config";
import { formatDigestSummary, runDigest, type DigestReport } from "../digest/run";
import { DIGEST_CRON, digestRunDecision } from "../digest/schedule";
import { Sentry } from "../sentry";

// ── Timer trigger: 07:30 Darwin, business days ────────────────────────────────
// The morning digest (N1, src/digest/): one email per active user, only when
// something needs them. Reads only; the one write path is Graph sendMail.
//
// The host runs UTC and WEBSITE_TIME_ZONE stays unset, so the schedule is
// 22:00 UTC Sunday to Thursday, which is 07:30 Monday to Friday in Darwin
// (UTC+9:30, no daylight saving). The handler then checks the Darwin calendar
// itself: a weekend, a public holiday (ESCALATION_HOLIDAYS) or a run that is
// hours late (a missed run catching up) sends nothing.
//
// Opt-in, because it sends email nobody has ever received from Floorplan:
//   DIGEST_ENABLED=true   the timer sends
//   DIGEST_DRY_RUN=true   reads and logs, with counts, who it would email and the
//                         lines it would show, and sends nothing (wins over ENABLED)
//   neither               it does nothing and does not touch the database
// Apply migration 132 (AppUsers.DigestOptOut) before turning either on. Turn the
// dry run on first and read the log. Set DEV_EMAIL_OVERRIDE on staging.
//
// digestTimer is a plain exported function so a wrapper (lane D's runTimer /
// TimerRuns) can take it as its handler unchanged.

/** A problem the run reports itself; already sent to Sentry, so not captured again. */
class DigestProblem extends Error {}

async function collect(context: InvocationContext, dryRun: boolean, now: Date): Promise<DigestReport> {
  let connection;
  try {
    // A fresh connection, not the shared singleton: the run issues several queries in turn.
    connection = await createServiceRequestConnection();
    return await runDigest(connection, { dryRun, log: (message) => context.log(message), now });
  } finally {
    if (connection) closeConnection(connection);
  }
}

/** Reports what went wrong in a finished run. Throws when nothing went out. */
function settle(report: DigestReport, context: InvocationContext): void {
  if (report.configMissing.length > 0) {
    const message = `Morning digest cannot send: ${report.errors[0]}`;
    context.error(message);
    Sentry.captureMessage(message, "error");
    throw new DigestProblem(message);
  }
  if (report.errors.length === 0) return;
  const attempted = report.sent + report.errors.length;
  context.error(`digestTimer: ${report.errors.length} of ${attempted} sends failed:`, ...report.errors);
  if (report.sent === 0) {
    const message = `Morning digest: every send failed (${attempted}). First: ${report.errors[0]}`;
    Sentry.captureMessage(message, "error");
    throw new DigestProblem(message);
  }
  Sentry.captureMessage(`Morning digest: ${report.errors.length} of ${attempted} sends failed. First: ${report.errors[0]}`, "error");
}

export async function digestTimer(_timer: Timer, context: InvocationContext): Promise<void> {
  const mode = digestMode();
  if (mode === "off") {
    context.log("digestTimer: off. Set DIGEST_DRY_RUN=true to see who it would email, then DIGEST_ENABLED=true.");
    return;
  }

  const now = new Date();
  const decision = digestRunDecision(now);
  if (!decision.run) {
    context.log(`digestTimer: skipped ${decision.darwinDate} (${decision.reason})`);
    return;
  }

  try {
    const report = await collect(context, mode === "dry-run", now);
    context.log(formatDigestSummary(report, decision.darwinDate));
    settle(report, context);
  } catch (error: unknown) {
    if (!(error instanceof DigestProblem)) {
      const message = error instanceof Error ? error.message : String(error);
      context.error("digestTimer failed:", message);
      Sentry.captureException(error, { tags: { source: "digest_timer" } });
    }
    throw error;
  } finally {
    await Sentry.flush(2000);
  }
}

app.timer("digestTimer", {
  handler: digestTimer,
  schedule: DIGEST_CRON,
});
