// tenancyCpiSyncTimer — daily sync of Australian CPI from the ABS Data API into
// dbo.CpiIndex: All groups, Original, Quarterly, for AUS (weighted average of
// the eight capitals) and Darwin, full history from 2000-Q1.
//
// Replaces the earlier monthly timer, which used a 4-value key (HTTP 422), read
// the SDMX-JSON 1 shape the API no longer serves, asked for the seasonally
// adjusted series, and bound its decimals at scale 0. The API facts this relies
// on are in docs/lease-ops/wp22-step0-abs-structure.md; fetch/parse/validate is
// src/cpiAbs.ts and the database side is src/cpiIndexSync.ts.
//
// Off by default. A rebase rewrites every stored row, so this timer overwrites
// data and is opt-in (database-safety rule 2): it does nothing unless
// CPI_SYNC_ENABLED is exactly "true". CPI_SYNC_DRY_RUN exactly "true" fetches,
// reads the table and logs each region's plan, writing nothing, whether or not
// the sync is enabled; use it to preview a first run or a rebase.
//
// Fetch and validate first, write second: if ABS is down or sends something
// unexpected, CpiIndex is never written and the existing rows stand. The
// failure goes to Sentry and the invocation fails visibly, after the reviews
// waiting for an index have been checked against the rows already stored (L7):
// a quarter keyed by hand, or synced by an earlier run, still brings them back.
//
// Daily rather than monthly because the daily run is a no-op unless ABS has
// published a new quarter or rebased, and a new quarter then lands within a day.
//
// After a sync has committed (or the fetch failed), every CPI rent review
// waiting for its index whose quarters are now in CpiIndex goes back to in
// progress and is calculated straight away (INDEX_AVAILABLE, WP26,
// rentReview/indexResume.ts), ledgered as this timer. The dry run says which
// would. A failure moving one fails the invocation under its own stage; the CPI
// rows are already committed and the next run tries the reviews again.

import { app, InvocationContext, Timer } from "@azure/functions";
import { AbsCpiError, CpiSeries, fetchAllCpiSeries } from "../cpiAbs";
import { planCpiSync, syncCpiIndex } from "../cpiIndexSync";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createServiceRequestConnection } from "../db";
import { resumeAwaitingIndex } from "../rentReview/indexResume";
import { Sentry } from "../sentry";
import { runTimer } from "../timerRuns";

// Exactly "true": "TRUE", "1" and "yes" do not switch anything on.
function flagOn(name: string): boolean {
  return process.env[name] === "true";
}

function fail(context: InvocationContext, stage: string, error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  context.error(`tenancyCpiSyncTimer: ${stage} failed: ${message}`);
  Sentry.captureException(error, {
    extra: {
      context: `tenancyCpiSyncTimer ${stage}`,
      kind: error instanceof AbsCpiError ? error.kind : undefined,
      status: error instanceof AbsCpiError ? error.status : undefined,
    },
  });
  throw error;
}

export async function tenancyCpiSyncTimer(
  timer: Timer,
  context: InvocationContext,
): Promise<void> {
  const dryRun = flagOn("CPI_SYNC_DRY_RUN");
  if (!dryRun && !flagOn("CPI_SYNC_ENABLED")) {
    context.log('tenancyCpiSyncTimer disabled (CPI_SYNC_ENABLED is not "true")');
    return;
  }

  if (timer.isPastDue) {
    context.warn("tenancyCpiSyncTimer: running past due");
  }
  context.log(
    dryRun
      ? "tenancyCpiSyncTimer: starting ABS CPI dry run (nothing will be written)"
      : "tenancyCpiSyncTimer: starting ABS CPI sync",
  );

  let connection;
  try {
    let series: CpiSeries[] | null = null;
    let fetchError: unknown = null;
    try {
      series = await fetchAllCpiSeries({ onRetry: (message) => context.warn(message) });
    } catch (error) {
      fetchError = error;
      context.warn("tenancyCpiSyncTimer: the ABS fetch failed; CpiIndex is left as it is, and waiting rent reviews are checked against it");
    }

    try {
      // A fresh connection, not the createServiceConnection() singleton: the
      // sync holds a transaction open across ~100 statements and auth.ts role
      // lookups share that singleton.
      connection = await createServiceRequestConnection();
      if (series) {
        if (dryRun) await planCpiSync(connection, series, context);
        else await syncCpiIndex(connection, series, context);
      }
    } catch (error) {
      return fail(context, fetchError ? "ABS fetch" : dryRun ? "database dry run" : "database sync", fetchError ?? error);
    }

    let resumed;
    try {
      resumed = await resumeAwaitingIndex(connection, {
        dryRun,
        log: (message) => context.log(message),
        today: todayInDarwin(),
        warn: (message) => context.warn(message),
      });
    } catch (error) {
      return fail(context, fetchError ? "ABS fetch" : "index resume", fetchError ?? error);
    }
    if (fetchError) return fail(context, "ABS fetch", fetchError);
    if (resumed.errors.length > 0) {
      return fail(
        context,
        "index resume",
        new Error(`${resumed.errors.length} rent review(s) couldn't go back to in progress; first: ${resumed.errors[0].message}`),
      );
    }
  } finally {
    if (connection) closeConnection(connection);
    await Sentry.flush(2000);
  }
}

// 03:00 UTC every day.
app.timer("tenancyCpiSyncTimer", {
  schedule: "0 0 3 * * *",
  handler: runTimer("tenancyCpiSyncTimer", tenancyCpiSyncTimer),
});
