import { app, InvocationContext, Timer } from "@azure/functions";
import { accessLoggingOn, coverMode, inactivityDays, maxActions } from "../absenceCover/config";
import { runAbsenceCover } from "../absenceCover/engine";
import { closeConnection, createServiceRequestConnection } from "../db";
import { Sentry } from "../sentry";
import { runTimer, type TimerCounts } from "../timerRuns";

// ── Timer trigger: every 30 minutes, Monday to Friday UTC ────────────────────
// Cover while away (PLAN §13; src/absenceCover/engine.ts): finds who is away today (approved
// leave, unplanned leave, or no sign-in for ABSENCE_INACTIVITY_DAYS business days), weighs
// what is waiting on them, and moves what falls due before they are back (or is urgent in an
// unplanned absence) to their cover: the delegate they nominated, else their manager, else
// their team's manager, else up the escalation ladder. The rest is listed for a manager.
// Nothing is approved: a move only changes who has the item. Every move is ledgered
// (dbo.CoverActions) and the cover is told. It works on the Darwin date and skips a day
// that is not a business day, so the UTC schedule only needs to cover Darwin's weekdays.
//
// Opt-in, because it moves work in bulk (database-safety rule 2):
//   ABSENCE_COVER_ENABLED=true     moves work, and lists the rest
//   ABSENCE_COVER_DRY_RUN=true     writes `suggested` rows only and moves nothing (wins over ENABLED)
//   neither                        does nothing and does not touch the database
//   ABSENCE_COVER_MAX_ACTIONS      ledger rows per run, most urgent first (default 50)
//   ABSENCE_INACTIVITY_DAYS        business days with no sign-in that count as away (default 3)
// Turn the dry run on first and read the counts: the first live run moves everything already
// overdue on a person who is away. runTimer records each run's counts in dbo.TimerRuns (migration 128);
// an item that fails fails the run.

export async function absenceCoverTimer(_timer: Timer, context: InvocationContext): Promise<TimerCounts | void> {
  const mode = coverMode();
  if (mode === "off") {
    context.log("absenceCoverTimer: off. Set ABSENCE_COVER_DRY_RUN=true to see what it would do, then ABSENCE_COVER_ENABLED=true.");
    return;
  }
  let connection;
  try {
    connection = await createServiceRequestConnection();
    const report = await runAbsenceCover({
      accessLoggingOn: accessLoggingOn(),
      connection,
      inactivityDays: inactivityDays(),
      log: (message) => context.log(message),
      maxActions: maxActions(),
      mode,
      onError: (error, entry) =>
        Sentry.captureException(error, { extra: { context: `absenceCoverTimer ${entry.item.type}:${entry.item.id}` } }),
    });
    if (report.aborted !== null) throw new Error(`Cover while away aborted: ${report.aborted}`);
    if (report.errors.length > 0) {
      throw new Error(`Cover while away: ${report.errors.length} item(s) failed; first: ${report.errors[0].item}: ${report.errors[0].message}`);
    }
    return {
      absent: report.absent,
      alreadyHandled: report.alreadyHandled,
      businessDay: report.businessDay,
      deferred: report.deferred,
      dryRun: report.dryRun,
      escalated: report.escalated,
      items: report.items,
      moved: report.moved,
      notStranded: report.notStranded,
      raced: report.raced,
      stayed: report.stayed,
      suggested: report.suggested,
      wouldMove: report.wouldMove,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("absenceCoverTimer failed:", message);
    Sentry.captureException(error, { extra: { context: "absenceCoverTimer fatal" } });
    throw error;
  } finally {
    if (connection) closeConnection(connection);
    await Sentry.flush(2000);
  }
}

app.timer("absenceCoverTimer", {
  schedule: "0 */30 * * * 1-5",
  handler: runTimer("absenceCoverTimer", absenceCoverTimer),
});
