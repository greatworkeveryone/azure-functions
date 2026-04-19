// ─────────────────────────────────────────────────────────────────────────────
// syncAllWorkRequests
// Fetches all WRs modified in the last 2 years from myBuildings (no per-building
// filter) and upserts them into SQL. Stamps WRsLastSyncedAt on every building
// row so the per-building cache in getWorkRequests knows the data is fresh.
//
// Runs:
//   - Daily at 02:00 UTC via timer trigger
//   - On demand via POST /api/syncAllWorkRequests (admin screen / manual trigger)
//     Pass ?force=true to reset to the full 2-year window regardless of last sync.
// ─────────────────────────────────────────────────────────────────────────────

import { app, HttpRequest, HttpResponseInit, InvocationContext, Timer } from "@azure/functions";
import { createConnection, executeQuery, closeConnection } from "../db";
import { fetchWorkRequests } from "../mybuildings-client";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";
import { toMyBuildingsDate, TWO_YEARS_MS } from "../mybuildings-dates";
import { upsertWorkRequest } from "./workRequests";
import { assertResolvedWithinThreshold, resolveAll } from "../sync-helpers";

// ── Core sync logic ───────────────────────────────────────────────────────────

async function runSync(token: string, force: boolean, context: InvocationContext): Promise<{ total: number; syncFrom: string }> {
  const connection = await createConnection(token);
  try {
    // Use the oldest WRsLastSyncedAt across all buildings as the incremental
    // from-date so no building is missed. Force resets to the 2-year window.
    let syncFrom: Date;
    if (force) {
      syncFrom = new Date(Date.now() - TWO_YEARS_MS);
    } else {
      const rows = await executeQuery(
        connection,
        "SELECT MIN(WRsLastSyncedAt) AS OldestSync FROM Buildings WHERE WRsLastSyncedAt IS NOT NULL"
      );
      const oldest: Date | null = rows[0]?.OldestSync ?? null;
      syncFrom = oldest ? new Date(oldest) : new Date(Date.now() - TWO_YEARS_MS);
    }

    const dateStr = toMyBuildingsDate(syncFrom);
    context.log(`syncAllWorkRequests: fetching WRs since ${dateStr} (force=${force})`);

    const workRequests = await fetchWorkRequests(`lastmodifieddate=${dateStr}`);
    context.log(`syncAllWorkRequests: fetched ${workRequests.length} work requests`);

    // myBuildings' list endpoint does not include BuildingID on each WR (only
    // BuildingName). Build a name→id lookup so we can backfill it on upsert.
    const buildingRows = await executeQuery(
      connection,
      "SELECT BuildingID, BuildingName FROM Buildings WHERE BuildingName IS NOT NULL"
    );
    const nameToId = new Map<string, number>(
      buildingRows.map((b: any) => [b.BuildingName, b.BuildingID])
    );

    const { resolved, unresolvedCount } = resolveAll(workRequests, { nameToId });
    if (unresolvedCount > 0) {
      context.log(`syncAllWorkRequests: ${unresolvedCount}/${workRequests.length} WRs could not be resolved to a BuildingID`);
    }
    assertResolvedWithinThreshold(unresolvedCount, workRequests.length);

    for (const wr of resolved) {
      await upsertWorkRequest(connection, wr);
    }

    // Only stamp buildings that were already stamped. Never-synced buildings
    // (WRsLastSyncedAt IS NULL) must remain NULL so their first per-building
    // visit triggers a full 2-year pull.
    await executeQuery(
      connection,
      "UPDATE Buildings SET WRsLastSyncedAt=GETUTCDATE() WHERE WRsLastSyncedAt IS NOT NULL"
    );

    return { total: workRequests.length, syncFrom: dateStr };
  } finally {
    closeConnection(connection);
  }
}

// ── Timer trigger — daily at 02:00 UTC ───────────────────────────────────────

async function syncAllWorkRequestsTimer(timer: Timer, context: InvocationContext): Promise<void> {
  if (timer.isPastDue) {
    context.warn("syncAllWorkRequests timer is past due — running now");
  }
  try {
    const token = process.env.MYBUILDINGS_BEARER_TOKEN!;
    const { total, syncFrom } = await runSync(token, false, context);
    context.log(`syncAllWorkRequests timer complete: ${total} WRs upserted since ${syncFrom}`);
  } catch (error: any) {
    context.error("syncAllWorkRequests timer failed:", error.message);
  }
}

// ── HTTP trigger — admin / manual ─────────────────────────────────────────────

async function syncAllWorkRequestsHttp(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const force = request.query.get("force") === "true";

  try {
    const { total, syncFrom } = await runSync(token, force, context);
    return {
      status: 200,
      jsonBody: { message: "Sync complete", total, syncFrom, force },
    };
  } catch (error: any) {
    context.error("syncAllWorkRequests failed:", error.message);
    return errorResponse("Sync failed", error.message);
  }
}

app.timer("syncAllWorkRequestsTimer", {
  schedule: "0 0 2 * * *", // daily at 02:00 UTC
  handler: syncAllWorkRequestsTimer,
});

app.http("syncAllWorkRequests", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: syncAllWorkRequestsHttp,
});
