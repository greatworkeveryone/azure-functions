import { app, InvocationContext, Timer } from "@azure/functions";
import { createServiceConnection, closeConnection, executeQuery } from "../db";
import { Sentry } from "../sentry";
import { runTimer } from "../timerRuns";

// ── Timer trigger: Sunday midnight (UTC) ─────────────────────────────────────
// Reports approved timesheets not yet in MYOB. Sending them is not built.

export async function timesheetSyncTimer(
  _timer: Timer,
  context: InvocationContext,
): Promise<void> {
  context.log("timesheetSyncTimer: starting Sunday midnight MYOB sync");

  let connection;
  try {
    connection = await createServiceConnection();

    const pending = await executeQuery(
      connection,
      `SELECT TimesheetID, UserDisplayName, WeekStartDate, Role, Data
       FROM dbo.Timesheets
       WHERE Approved = 1 AND SentToMyobDate IS NULL`,
    );

    // Nothing is sent to MYOB yet, so nothing is stamped: SentToMyobDate on a
    // row that never reached MYOB would be a false record in the CFO's audit
    // trail and would stop the row ever being sent once sending is built. When
    // it is, send through myob-client (logged, behind MYOB_WRITES_ENABLED) and
    // stamp only after MYOB confirms.
    context.log(
      `timesheetSyncTimer: ${pending.length} approved timesheets awaiting MYOB sync; sending is not built yet, nothing stamped`,
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("timesheetSyncTimer: fatal error:", message);
    Sentry.captureException(error, { extra: { context: "timesheetSyncTimer fatal" } });
    throw error;
  } finally {
    if (connection) closeConnection(connection);
    await Sentry.flush(2000);
  }
}

// Runs at 00:00 UTC every Sunday
app.timer("timesheetSyncTimer", {
  schedule: "0 0 0 * * 0",
  handler: runTimer("timesheetSyncTimer", timesheetSyncTimer),
});
