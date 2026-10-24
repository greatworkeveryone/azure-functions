import { app, InvocationContext, Timer } from "@azure/functions";
import { closeConnection, createServiceRequestConnection } from "../db";
import { generatorMode, maxActions, runLeaseEventsGenerator } from "../leaseEvents/generator";
import { Sentry } from "../sentry";
import { runTimer, type TimerCounts } from "../timerRuns";

// ── Timer trigger: daily, 02:30 UTC (12:00 in Darwin) ────────────────────────
// The lease events generator (PLAN §3.5, §3.6; WP32, WP33; src/leaseEvents/
// generator.ts): opens option events ahead of their notice window, opens the
// window on its day, warns before the deadline, lapses an option whose deadline
// passed with no notice (lease.option_lapsed to the directors), and refers a
// lease with no option left to the directors at 180 days to expiry
// (lease.renewal). It selects positively: live tenancies (current or
// holdover), not archived, not test data, with an expiry.
//
// Opt-in, because it writes in bulk (database-safety rule 2):
//   LEASE_EVENTS_GENERATOR_ENABLED=true      the generator writes
//   LEASE_EVENTS_GENERATOR_DRY_RUN=true      logs, with counts, what it would do and
//                                            writes nothing (wins over ENABLED)
//   neither                                  it does nothing and does not touch the database
//   LEASE_EVENTS_GENERATOR_MAX_ACTIONS       writes per run, soonest first (default 50)
// Turn the dry run on first and read the counts: the first live run refers
// every lease already inside 180 days of expiry (holdovers included).
//
// WEBSITE_TIME_ZONE is not set in production, so the schedule runs in UTC; the
// generator works on the Darwin date itself. runTimer records each run's counts
// in dbo.TimerRuns (migration 128); a tenancy that fails fails the run.

export async function leaseEventsGeneratorTimer(_timer: Timer, context: InvocationContext): Promise<TimerCounts | void> {
  const mode = generatorMode();
  if (mode === "off") {
    context.log(
      "leaseEventsGeneratorTimer: off. Set LEASE_EVENTS_GENERATOR_DRY_RUN=true to see what it would do, then LEASE_EVENTS_GENERATOR_ENABLED=true.",
    );
    return;
  }
  let connection;
  try {
    connection = await createServiceRequestConnection();
    const report = await runLeaseEventsGenerator({
      connection,
      dryRun: mode === "dry-run",
      log: (message) => context.log(message),
      maxActions: maxActions(),
      onError: (error, tenantId) =>
        Sentry.captureException(error, { extra: { context: `leaseEventsGeneratorTimer TenantId=${tenantId}` } }),
      warn: (message) => context.warn(message),
    });
    if (report.errors.length > 0) {
      throw new Error(`Lease events generator: ${report.errors.length} tenancy(ies) failed; first: ${report.errors[0].message}`);
    }
    return {
      deferred: report.deferred,
      dryRun: report.dryRun,
      escalationsRaised: report.escalationsRaised,
      lapsed: report.written.lapse,
      optionsOpened: report.written.open_option,
      raced: report.raced,
      renewalsReferred: report.written.refer_renewal,
      tenancies: report.tenancies,
      unrecordedLapses: report.unrecordedLapses,
      warnings: report.written.deadline_warning,
      windowsOpened: report.written.open_window,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("leaseEventsGeneratorTimer failed:", message);
    Sentry.captureException(error, { extra: { context: "leaseEventsGeneratorTimer fatal" } });
    throw error;
  } finally {
    if (connection) closeConnection(connection);
    await Sentry.flush(2000);
  }
}

app.timer("leaseEventsGeneratorTimer", {
  schedule: "0 30 2 * * *",
  handler: runTimer("leaseEventsGeneratorTimer", leaseEventsGeneratorTimer),
});
