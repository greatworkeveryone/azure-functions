import { app, InvocationContext, Timer } from "@azure/functions";
import { createServiceConnection, closeConnection, executeQuery } from "../db";
import { TYPES } from "tedious";

// ── Timer trigger: Sunday midnight (UTC) ─────────────────────────────────────
// Syncs all newly approved timesheets (both facilities and accounts) to MYOB.
// Uses service credentials (client_credentials flow) since there is no user
// token in a timer context.

async function timesheetSyncTimer(
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

    context.log(`timesheetSyncTimer: ${pending.length} timesheets pending sync`);

    let synced = 0;
    const errors: string[] = [];

    for (const row of pending) {
      try {
        // TODO: call MYOB API here when credentials are available
        // await sendToMyob(row);

        await executeQuery(
          connection,
          "UPDATE dbo.Timesheets SET SentToMyobDate = GETUTCDATE() WHERE TimesheetID = @Id",
          [{ name: "Id", type: TYPES.Int, value: row.TimesheetID }],
        );
        synced++;
        context.log(`timesheetSyncTimer: synced TimesheetID ${row.TimesheetID} (${row.UserDisplayName})`);
      } catch (err: any) {
        errors.push(`TimesheetID ${row.TimesheetID}: ${err.message}`);
        context.error(`timesheetSyncTimer error for TimesheetID ${row.TimesheetID}:`, err.message);
      }
    }

    context.log(`timesheetSyncTimer: complete — synced=${synced}, errors=${errors.length}`);
  } catch (error: any) {
    context.error("timesheetSyncTimer: fatal error:", error.message);
    throw error;
  } finally {
    if (connection) closeConnection(connection);
  }
}

// Runs at 00:00 UTC every Sunday
app.timer("timesheetSyncTimer", {
  schedule: "0 0 0 * * 0",
  handler: timesheetSyncTimer,
});
