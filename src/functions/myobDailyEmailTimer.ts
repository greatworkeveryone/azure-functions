import { app, InvocationContext, Timer } from "@azure/functions";
import { closeConnection, createServiceRequestConnection } from "../db";
import { DIGEST_CRON, digestRunDecision } from "../digest/schedule";
import { myobDailyMode, runMyobDaily, type MyobDailyReport } from "../myob/daily/run";
import { runTimer, type TimerCounts } from "../timerRuns";

// ── Timer trigger: 07:30 Darwin, business days ────────────────────────────────
// The daily "What Floorplan did in MYOB" email to the CFO (plan M4, decision
// 13c): every record created, every proposal state change, what changed in
// MYOB since, and every MYOB call, from the previous business morning to this
// one, with who acted. Same schedule and calendar as the morning digest
// (DIGEST_CRON, digestRunDecision): weekends, public holidays and a run hours
// late send nothing. Sent only when there is something; reads only.
//
// Off unless asked (both default off; dry run wins):
//   MYOB_DAILY_EMAIL_DRY_RUN=true   logs who it would email and the whole email, sends nothing
//   MYOB_DAILY_EMAIL_ENABLED=true   sends, through the digest's mail settings
// Set DEV_EMAIL_OVERRIDE on staging.

const ACTOR = "myobDailyEmailTimer";

function counts(report: MyobDailyReport): TimerCounts {
  const { configMissing, errors, ...rest } = report;
  return { ...rest, configMissing: configMissing.join(",") || null, errors: errors.length };
}

export async function myobDailyEmailTimer(_timer: Timer, context: InvocationContext): Promise<TimerCounts | void> {
  const mode = myobDailyMode();
  if (mode === "off") {
    context.log(`${ACTOR}: off. Set MYOB_DAILY_EMAIL_DRY_RUN=true to see what it would send, then MYOB_DAILY_EMAIL_ENABLED=true.`);
    return;
  }
  const now = new Date();
  const decision = digestRunDecision(now);
  if (!decision.run) {
    context.log(`${ACTOR}: skipped ${decision.darwinDate} (${decision.reason})`);
    return;
  }
  let connection;
  try {
    connection = await createServiceRequestConnection();
    const report = await runMyobDaily(connection, { dryRun: mode === "dry-run", log: (message) => context.log(message), now });
    context.log(`${ACTOR} ${decision.darwinDate}: ${JSON.stringify(counts(report))}`);
    if (report.errors.length > 0) context.error(`${ACTOR}:`, ...report.errors);
    // Nothing went out when something should have: runTimer records the failure and rethrows.
    if (report.configMissing.length > 0 || (report.errors.length > 0 && report.sent + report.wouldSend === 0)) {
      throw new Error(`MYOB daily email: ${report.errors[0]}`);
    }
    return counts(report);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.timer("myobDailyEmailTimer", {
  handler: runTimer("myobDailyEmailTimer", myobDailyEmailTimer),
  schedule: DIGEST_CRON,
});
