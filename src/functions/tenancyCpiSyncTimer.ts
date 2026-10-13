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
// Fetch and validate first, open the database second: if ABS is down or sends
// something unexpected, the database is never touched and the existing rows
// stand. The failure goes to Sentry and the invocation fails visibly.
//
// Daily rather than monthly because the daily run is a no-op unless ABS has
// published a new quarter or rebased, and a new quarter then lands within a day.

import { app, InvocationContext, Timer } from "@azure/functions";
import { AbsCpiError, CpiSeries, fetchAllCpiSeries } from "../cpiAbs";
import { planCpiSync, syncCpiIndex } from "../cpiIndexSync";
import { closeConnection, createServiceRequestConnection } from "../db";
import { Sentry } from "../sentry";

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
    let series: CpiSeries[];
    try {
      series = await fetchAllCpiSeries({ onRetry: (message) => context.warn(message) });
    } catch (error) {
      return fail(context, "ABS fetch", error);
    }

    try {
      // A fresh connection, not the createServiceConnection() singleton: the
      // sync holds a transaction open across ~100 statements and auth.ts role
      // lookups share that singleton.
      connection = await createServiceRequestConnection();
      if (dryRun) await planCpiSync(connection, series, context);
      else await syncCpiIndex(connection, series, context);
    } catch (error) {
      return fail(context, dryRun ? "database dry run" : "database sync", error);
    }
  } finally {
    if (connection) closeConnection(connection);
    await Sentry.flush(2000);
  }
}

// 03:00 UTC every day.
app.timer("tenancyCpiSyncTimer", {
  schedule: "0 0 3 * * *",
  handler: tenancyCpiSyncTimer,
});
