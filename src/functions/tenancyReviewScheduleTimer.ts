// tenancyReviewScheduleTimer — daily housekeeping for the rent-review machinery.
//
// Three things per run:
//   1. For tenants with `ReviewIntervalMonths` set but no `NextReviewDate`,
//      derive it from `LastReviewDate` (or `Commencement`) + interval.
//   2. For tenants whose `NextReviewDate` has passed and there's no upcoming
//      `RentReviews` row for that date, insert one with status `due`.
//   3. Flip `RentReviews.Status`: `upcoming` → `due` once `ScheduledFor` is
//      within 30 days, `due` → `overdue` once `ScheduledFor` is in the past.
//
// Idempotent — safe to re-run on the same day.

import { app, InvocationContext, Timer } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createServiceConnection, executeQuery } from "../db";

function randomUuid(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

async function tenancyReviewScheduleTimer(
  _timer: Timer,
  context: InvocationContext,
): Promise<void> {
  context.log("tenancyReviewScheduleTimer: starting");
  let connection;
  try {
    connection = await createServiceConnection();

    // 1. Backfill NextReviewDate where it can be derived.
    const backfill = await executeQuery(
      connection,
      `UPDATE dbo.Tenants SET
         NextReviewDate = DATEADD(month, ReviewIntervalMonths, COALESCE(LastReviewDate, Commencement))
       OUTPUT INSERTED.TenantId
       WHERE NextReviewDate IS NULL
         AND ReviewIntervalMonths IS NOT NULL
         AND COALESCE(LastReviewDate, Commencement) IS NOT NULL
         AND Status <> 'vacated'`,
    );
    context.log(`backfilled NextReviewDate for ${backfill.length} tenants`);

    // 2. Insert RentReviews rows for tenants with NextReviewDate but no
    //    matching upcoming/due row.
    const candidates = await executeQuery(
      connection,
      `SELECT t.TenantId, t.NextReviewDate, t.ReviewType
       FROM dbo.Tenants t
       WHERE t.NextReviewDate IS NOT NULL
         AND t.Status <> 'vacated'
         AND t.ReviewType <> 'none'
         AND NOT EXISTS (
           SELECT 1 FROM dbo.RentReviews r
           WHERE r.TenantId = t.TenantId
             AND r.ScheduledFor = t.NextReviewDate
             AND r.Status IN ('upcoming','due','overdue')
         )`,
    );
    let inserted = 0;
    for (const row of candidates) {
      try {
        await executeQuery(
          connection,
          `INSERT INTO dbo.RentReviews
             (ReviewId, TenantId, ScheduledFor, Status, ReviewType)
           VALUES (@ReviewId, @TenantId, @ScheduledFor, 'upcoming', @ReviewType)`,
          [
            { name: "ReviewId", type: TYPES.NVarChar, value: randomUuid() },
            { name: "TenantId", type: TYPES.Int, value: row.TenantId as number },
            { name: "ScheduledFor", type: TYPES.Date, value: row.NextReviewDate },
            { name: "ReviewType", type: TYPES.NVarChar, value: row.ReviewType as string },
          ],
        );
        inserted++;
      } catch (err: any) {
        context.error(
          `failed to insert RentReviews row for TenantId ${row.TenantId}:`,
          err.message,
        );
      }
    }
    context.log(`inserted ${inserted} new RentReviews rows`);

    // 3. Flip statuses based on the calendar.
    const flipped = await executeQuery(
      connection,
      `UPDATE dbo.RentReviews SET Status = CASE
         WHEN ScheduledFor < CAST(SYSUTCDATETIME() AS DATE) THEN 'overdue'
         ELSE 'due'
       END
       OUTPUT INSERTED.ReviewId
       WHERE Status IN ('upcoming','due')
         AND ScheduledFor <= DATEADD(day, 30, CAST(SYSUTCDATETIME() AS DATE))`,
    );
    context.log(`flipped status on ${flipped.length} RentReviews rows`);

    context.log("tenancyReviewScheduleTimer: complete");
  } catch (error: any) {
    context.error("tenancyReviewScheduleTimer: fatal:", error.message);
    throw error;
  } finally {
    if (connection) closeConnection(connection);
  }
}

// Runs daily at 02:00 UTC (~11:30 ACST)
app.timer("tenancyReviewScheduleTimer", {
  schedule: "0 0 2 * * *",
  handler: tenancyReviewScheduleTimer,
});
