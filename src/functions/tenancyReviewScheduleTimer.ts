import { app, InvocationContext, Timer } from "@azure/functions";
import { closeConnection, createServiceRequestConnection } from "../db";
import { generatorMode, reviewWindowDays, runReviewGenerator } from "../rentReview/generator";
import { Sentry } from "../sentry";

// ── Timer trigger: daily, 02:00 UTC (11:30 in Darwin) ────────────────────────
// The rent review generator (PLAN WP25, src/rentReview/generator.ts): keeps one
// open review per tenancy that hasn't been vacated, for its next review date
// (scheduled, then due once inside REVIEW_WINDOW_DAYS, default 60). It replaces
// the old housekeeping timer, whose inserts always failed the RentReviews
// ReviewType check and which has been off in production.
//
// Opt-in, because it writes in bulk:
//   RENT_REVIEW_GENERATOR_ENABLED=true   the generator writes
//   RENT_REVIEW_GENERATOR_DRY_RUN=true   logs, with counts, what it would schedule or
//                                        move to due, and writes nothing (wins over ENABLED)
//   neither                              it does nothing and does not touch the database
//   REVIEW_WINDOW_DAYS                   days before a review's date it becomes due (default 60)
// Turn the dry run on first and read the counts in the log: the first live run
// schedules one review for every tenancy, and those already past their date
// start out due and overdue.
//
// WEBSITE_TIME_ZONE is not set in production, so the schedule runs in UTC; the
// generator works on the Darwin date (todayInDarwin) itself.

export async function tenancyReviewScheduleTimer(_timer: Timer, context: InvocationContext): Promise<void> {
  const mode = generatorMode();
  if (mode === "off") {
    context.log(
      "tenancyReviewScheduleTimer: off. Set RENT_REVIEW_GENERATOR_DRY_RUN=true to see what it would do, then RENT_REVIEW_GENERATOR_ENABLED=true.",
    );
    return;
  }

  let connection;
  try {
    // A fresh connection, not the shared singleton: the generator runs transactions.
    connection = await createServiceRequestConnection();
    const report = await runReviewGenerator({
      connection,
      dryRun: mode === "dry-run",
      log: (message) => context.log(message),
      onError: (error, tenantId) =>
        Sentry.captureException(error, { extra: { context: `tenancyReviewScheduleTimer TenantId=${tenantId}` } }),
      warn: (message) => context.warn(message),
      windowDays: reviewWindowDays(),
    });
    if (report.errors.length > 0) {
      Sentry.captureMessage(
        `Rent review generator finished with ${report.errors.length} failure(s); first: ${report.errors[0].message}`,
        "error",
      );
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("tenancyReviewScheduleTimer failed:", message);
    Sentry.captureException(error, { extra: { context: "tenancyReviewScheduleTimer fatal" } });
    throw error;
  } finally {
    if (connection) closeConnection(connection);
    await Sentry.flush(2000);
  }
}

app.timer("tenancyReviewScheduleTimer", {
  schedule: "0 0 2 * * *",
  handler: tenancyReviewScheduleTimer,
});
