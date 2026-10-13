import { app, InvocationContext, Timer } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createServiceRequestConnection, executeQuery } from "../db";
import { Sentry } from "../sentry";

// ── Timer trigger: 03:30 ACST (Darwin) daily ─────────────────────────────────
// Verifies the database ledger (which makes dbo.MyobApiLog tamper-evident)
// against the digests Azure SQL uploads to immutable storage. A digest that no
// longer matches the database means someone changed ledger data.
//
// WEBSITE_TIME_ZONE is NOT set in production, so the schedule is evaluated in
// UTC. Darwin is UTC+9:30 with no DST → 03:30 ACST = 18:00 UTC the previous day.
//
// Needs automatic digest storage to be configured on the database (Azure
// portal → SQL database → Ledger). Until it is, sys.database_ledger_digest_locations
// is empty and this timer reports that it skipped, instead of failing.

// Locations as the JSON array the verify procedure expects (Microsoft's
// documented query); NULL when there are no rows. A fresh connection, not the
// shared singleton: verification can run for a while.
const SELECT_LOCATIONS_SQL = `SELECT (
  SELECT path, last_digest_block_id, is_current
    FROM sys.database_ledger_digest_locations
     FOR JSON AUTO, INCLUDE_NULL_VALUES
) AS Locations`;

async function ledgerVerifyTimer(
  _timer: Timer,
  context: InvocationContext,
): Promise<void> {
  let connection;
  try {
    connection = await createServiceRequestConnection();
    const rows = await executeQuery(connection, SELECT_LOCATIONS_SQL);
    const locations = (rows[0]?.Locations as string | null | undefined) ?? null;

    if (!locations) {
      context.warn("ledgerVerifyTimer: no ledger digest storage is configured — verification skipped");
      Sentry.captureMessage("Ledger digest storage not configured — verification skipped", "warning");
      return;
    }

    // Raises an error if any digest does not match the database.
    await executeQuery(
      connection,
      "EXEC sys.sp_verify_database_ledger_from_digest_storage @Locations",
      [{ name: "Locations", type: TYPES.NVarChar, value: locations }],
    );
    context.log("ledgerVerifyTimer: ledger verified against digest storage");
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("ledgerVerifyTimer: ledger verification failed:", message);
    Sentry.captureException(error, { extra: { context: "ledgerVerifyTimer ledger verification failed" } });
    throw error;
  } finally {
    if (connection) closeConnection(connection);
    await Sentry.flush(2000);
  }
}

app.timer("ledgerVerifyTimer", {
  schedule: "0 0 18 * * *",
  handler: ledgerVerifyTimer,
});
