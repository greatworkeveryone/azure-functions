import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createConnection, executeQuery, closeConnection } from "../db";
import { fetchWorkRequests, fetchWorkRequestById, createWorkRequest, bulkStatusUpdate, MyWorkRequest } from "../mybuildings-client";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";
import { toMyBuildingsDate, TWO_YEARS_MS } from "../mybuildings-dates";
import { TYPES } from "tedious";

// Tweak this to control how long cached work requests are considered fresh
export const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

// ── Param helper ──────────────────────────────────────────────────────────────

function wrToParams(wr: MyWorkRequest) {
  return [
    { name: "WorkRequestID", type: TYPES.Int, value: wr.WorkRequestID ?? null },
    { name: "JobCode", type: TYPES.NVarChar, value: wr.JobCode ?? null },
    { name: "BuildingID", type: TYPES.Int, value: wr.BuildingID ?? null },
    { name: "BuildingName", type: TYPES.NVarChar, value: wr.BuildingName ?? null },
    { name: "LevelName", type: TYPES.NVarChar, value: wr.LevelName ?? null },
    { name: "TenantName", type: TYPES.NVarChar, value: wr.TenantName ?? null },
    { name: "Category", type: TYPES.NVarChar, value: wr.Category ?? null },
    { name: "Type", type: TYPES.NVarChar, value: wr.Type ?? null },
    { name: "SubType", type: TYPES.NVarChar, value: wr.SubType ?? null },
    { name: "StatusID", type: TYPES.Int, value: wr.StatusID ?? null },
    { name: "Status", type: TYPES.NVarChar, value: wr.Status ?? null },
    { name: "Priority", type: TYPES.NVarChar, value: wr.Priority ?? null },
    { name: "Details", type: TYPES.NVarChar, value: wr.Details ?? null },
    { name: "ExactLocation", type: TYPES.NVarChar, value: wr.ExactLocation ?? null },
    { name: "ContactName", type: TYPES.NVarChar, value: wr.ContactName ?? null },
    { name: "ContactPhone", type: TYPES.NVarChar, value: wr.ContactPhone ?? null },
    { name: "ContactEmail", type: TYPES.NVarChar, value: wr.ContactEmail ?? null },
    { name: "AssignedTo", type: TYPES.NVarChar, value: wr.AssignedTo ?? null },
    { name: "TotalCost", type: TYPES.Decimal, value: wr.TotalCost ?? null },
    { name: "CostNotToExceed", type: TYPES.Decimal, value: wr.CostNotToExceed ?? null },
    { name: "WorkBeganDate", type: TYPES.NVarChar, value: wr.WorkBeganDate ?? null },
    { name: "ExpectedCompletionDate", type: TYPES.NVarChar, value: wr.ExpectedCompletionDate ?? null },
    { name: "ActualCompletionDate", type: TYPES.NVarChar, value: wr.ActualCompletionDate ?? null },
    { name: "LastModifiedDate", type: TYPES.NVarChar, value: wr.LastModifiedDate ?? null },
    { name: "WorkNotes", type: TYPES.NVarChar, value: wr.WorkNotes ?? null },
    { name: "PersonAffected", type: TYPES.NVarChar, value: wr.PersonAffected ?? null },
  ];
}

// ── DB upsert helper ──────────────────────────────────────────────────────────
// Uses MERGE so each WR is one round-trip instead of SELECT + UPDATE/INSERT.

export async function upsertWorkRequest(connection: any, wr: MyWorkRequest): Promise<void> {
  await executeQuery(connection,
    `MERGE INTO WorkRequests WITH (HOLDLOCK) AS target
     USING (SELECT @WorkRequestID AS WorkRequestID) AS source
       ON target.WorkRequestID = source.WorkRequestID
     WHEN MATCHED THEN
       UPDATE SET
         JobCode=@JobCode, BuildingID=@BuildingID, BuildingName=@BuildingName,
         LevelName=@LevelName, TenantName=@TenantName, Category=@Category,
         Type=@Type, SubType=@SubType, StatusID=@StatusID, Status=@Status,
         Priority=@Priority, Details=@Details, ExactLocation=@ExactLocation,
         ContactName=@ContactName, ContactPhone=@ContactPhone, ContactEmail=@ContactEmail,
         AssignedTo=@AssignedTo, TotalCost=@TotalCost, CostNotToExceed=@CostNotToExceed,
         WorkBeganDate=@WorkBeganDate, ExpectedCompletionDate=@ExpectedCompletionDate,
         ActualCompletionDate=@ActualCompletionDate, LastModifiedDate=@LastModifiedDate,
         WorkNotes=@WorkNotes, PersonAffected=@PersonAffected,
         LastSyncedAt=GETUTCDATE(), UpdatedAt=GETUTCDATE()
     WHEN NOT MATCHED THEN
       INSERT (WorkRequestID, JobCode, BuildingID, BuildingName,
               LevelName, TenantName, Category, Type, SubType, StatusID, Status,
               Priority, Details, ExactLocation, ContactName, ContactPhone, ContactEmail,
               AssignedTo, TotalCost, CostNotToExceed, WorkBeganDate, ExpectedCompletionDate,
               ActualCompletionDate, LastModifiedDate, WorkNotes, PersonAffected,
               LastSyncedAt, CreatedAt, UpdatedAt)
       VALUES (@WorkRequestID, @JobCode, @BuildingID, @BuildingName,
               @LevelName, @TenantName, @Category, @Type, @SubType, @StatusID, @Status,
               @Priority, @Details, @ExactLocation, @ContactName, @ContactPhone, @ContactEmail,
               @AssignedTo, @TotalCost, @CostNotToExceed, @WorkBeganDate, @ExpectedCompletionDate,
               @ActualCompletionDate, @LastModifiedDate, @WorkNotes, @PersonAffected,
               GETUTCDATE(), GETUTCDATE(), GETUTCDATE());`,
    wrToParams(wr)
  );
}

// ── GET /api/getWorkRequests?buildingId=xxx[&statusId=x][&category=x][&force=true] ──

async function getWorkRequests(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const buildingId = request.query.get("buildingId");
  const statusId = request.query.get("statusId");
  const category = request.query.get("category");
  const force = request.query.get("force") === "true";

  let connection;
  try {
    connection = await createConnection(token);

    // No buildingId — return all WRs from DB. On force=true also sync all
    // buildings using lastmodifieddate so the dashboard data stays current.
    if (!buildingId) {
      if (force) {
        // Use the oldest WRsLastSyncedAt across all buildings as the sync-from
        // date, so any building that has fallen behind gets caught up.
        const globalSyncRows = await executeQuery(
          connection,
          "SELECT MIN(WRsLastSyncedAt) AS OldestSync FROM Buildings WHERE WRsLastSyncedAt IS NOT NULL"
        );
        const oldest: Date | null = globalSyncRows[0]?.OldestSync ?? null;
        const syncFrom = oldest ? new Date(oldest) : new Date(Date.now() - TWO_YEARS_MS);
        const dateStr = toMyBuildingsDate(syncFrom);
        context.log(`Force-syncing all WRs from myBuildings since ${dateStr}`);
        const workRequests = await fetchWorkRequests(`lastmodifieddate=${dateStr}`);
        context.log(`Fetched ${workRequests.length} work requests from myBuildings`);
        for (const wr of workRequests) {
          await upsertWorkRequest(connection, wr);
        }
        await executeQuery(connection, "UPDATE Buildings SET WRsLastSyncedAt=GETUTCDATE()");
      }

      let sql = "SELECT * FROM WorkRequests WHERE 1=1";
      const params: any[] = [];
      if (statusId) {
        sql += " AND StatusID = @StatusID";
        params.push({ name: "StatusID", type: TYPES.Int, value: parseInt(statusId) });
      }
      if (category) {
        sql += " AND Category = @Category";
        params.push({ name: "Category", type: TYPES.NVarChar, value: category });
      }
      sql += " ORDER BY WorkRequestID DESC";
      const rows = await executeQuery(connection, sql, params);
      return { status: 200, jsonBody: { workRequests: rows, count: rows.length, fromCache: !force } };
    }

    // Per-building sync — check staleness
    const buildingRows = await executeQuery(
      connection,
      "SELECT WRsLastSyncedAt FROM Buildings WHERE BuildingID = @BuildingID",
      [{ name: "BuildingID", type: TYPES.Int, value: parseInt(buildingId) }]
    );

    const lastSynced: Date | null = buildingRows[0]?.WRsLastSyncedAt ?? null;
    const isStale = !lastSynced || (Date.now() - new Date(lastSynced).getTime() > CACHE_TTL_MS);

    if (force || isStale) {
      // Both force and incremental syncs use lastmodifieddate to avoid pulling
      // the entire WR history. Force sync resets to the 2-year default window;
      // incremental sync uses the last-synced timestamp for minimal fetching.
      const syncFrom = (force || !lastSynced)
        ? new Date(Date.now() - TWO_YEARS_MS)
        : new Date(lastSynced);
      const syncParams = `buildingID=${buildingId}&lastmodifieddate=${toMyBuildingsDate(syncFrom)}`;
      context.log(`Syncing WRs from myBuildings: building=${buildingId}, params=${syncParams}`);
      const workRequests = await fetchWorkRequests(syncParams);
      context.log(`Fetched ${workRequests.length} work requests from myBuildings`);

      for (const wr of workRequests) {
        await upsertWorkRequest(connection, wr);
      }

      // Stamp the sync time on the building row
      await executeQuery(
        connection,
        "UPDATE Buildings SET WRsLastSyncedAt=GETUTCDATE() WHERE BuildingID=@BuildingID",
        [{ name: "BuildingID", type: TYPES.Int, value: parseInt(buildingId) }]
      );
    } else {
      context.log(`Returning cached WRs for building ${buildingId} (last synced: ${lastSynced})`);
    }

    // Return from DB with optional filters
    let sql = "SELECT * FROM WorkRequests WHERE BuildingID = @BuildingID";
    const params: any[] = [{ name: "BuildingID", type: TYPES.Int, value: parseInt(buildingId) }];

    if (statusId) {
      sql += " AND StatusID = @StatusID";
      params.push({ name: "StatusID", type: TYPES.Int, value: parseInt(statusId) });
    }
    if (category) {
      sql += " AND Category = @Category";
      params.push({ name: "Category", type: TYPES.NVarChar, value: category });
    }

    sql += " ORDER BY WorkRequestID DESC";
    const rows = await executeQuery(connection, sql, params);

    return {
      status: 200,
      jsonBody: { workRequests: rows, count: rows.length, fromCache: !force && !isStale },
    };
  } catch (error: any) {
    context.error("getWorkRequests failed:", error.message);
    return errorResponse("Query failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getWorkRequest?workRequestId=xxx ─────────────────────────────────
// Live-checks a single WR from myBuildings and upserts if changed.
// Returns { workRequest, changed } so the client knows whether to show an alert.

async function getWorkRequest(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const workRequestId = request.query.get("workRequestId");
  if (!workRequestId) {
    return { status: 400, jsonBody: { error: "workRequestId is required" } };
  }

  let connection;
  try {
    connection = await createConnection(token);

    // Get the DB snapshot for comparison
    const existing = await executeQuery(
      connection,
      "SELECT * FROM WorkRequests WHERE WorkRequestID = @WorkRequestID",
      [{ name: "WorkRequestID", type: TYPES.Int, value: parseInt(workRequestId) }]
    );

    const dbLastModified = existing[0]?.LastModifiedDate ?? null;

    // Live fetch from myBuildings
    const liveWr = await fetchWorkRequestById(parseInt(workRequestId));
    if (!liveWr) {
      return { status: 404, jsonBody: { error: "Work request not found in myBuildings" } };
    }

    const changed = liveWr.LastModifiedDate !== dbLastModified;

    if (changed) {
      context.log(`WR ${workRequestId} changed (db: ${dbLastModified}, live: ${liveWr.LastModifiedDate}), upserting`);
      await upsertWorkRequest(connection, liveWr);
    }

    return {
      status: 200,
      jsonBody: {
        workRequest: changed ? liveWr : (existing[0] ?? liveWr),
        changed,
      },
    };
  } catch (error: any) {
    context.error("getWorkRequest failed:", error.message);
    return errorResponse("Fetch failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/updateWorkRequest ───────────────────────────────────────────────
// Writes via myBuildings bulkStatusUpdate. Checks LastModifiedDate first —
// returns 409 with currentState if another user has saved since the client loaded.

async function updateWorkRequest(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = await request.json() as any;
    const { WorkRequestID, LastModifiedDate: clientLastModified } = body;

    if (!WorkRequestID) {
      return { status: 400, jsonBody: { error: "WorkRequestID is required" } };
    }

    connection = await createConnection(token);

    // Read current DB state for conflict check
    const existing = await executeQuery(
      connection,
      "SELECT * FROM WorkRequests WHERE WorkRequestID = @WorkRequestID",
      [{ name: "WorkRequestID", type: TYPES.Int, value: WorkRequestID }]
    );

    if (existing.length === 0) {
      return { status: 404, jsonBody: { error: "Work request not found" } };
    }

    const dbLastModified = existing[0].LastModifiedDate;

    // 409 Conflict — another user has saved since this client loaded
    if (dbLastModified && clientLastModified && dbLastModified !== clientLastModified) {
      context.log(`WR ${WorkRequestID} conflict: client=${clientLastModified}, db=${dbLastModified}`);
      return {
        status: 409,
        jsonBody: {
          error: "This work request was modified by another user since you opened it.",
          currentState: existing[0],
        },
      };
    }

    // Write to myBuildings via bulkStatusUpdate (the only supported write endpoint)
    const bulkPayload = [{
      WorkRequestID,
      NewStatusID: body.StatusID ?? existing[0].StatusID,
      Comment: body.WorkNotes ?? "",
      TotalCost: body.TotalCost ?? existing[0].TotalCost,
    }];

    context.log(`Updating WR ${WorkRequestID} via myBuildings bulkStatusUpdate`);
    await bulkStatusUpdate(bulkPayload);

    // Re-fetch from myBuildings so our DB and response have the new LastModifiedDate
    const updated = await fetchWorkRequestById(WorkRequestID);
    if (updated) {
      await upsertWorkRequest(connection, updated);
    }

    return {
      status: 200,
      jsonBody: { message: "Work request updated", workRequest: updated ?? existing[0] },
    };
  } catch (error: any) {
    context.error("updateWorkRequest failed:", error.message);
    return errorResponse("Update failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/createWorkRequest ───────────────────────────────────────────────

async function handleCreateWorkRequest(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  try {
    const body = await request.json() as any;
    context.log("Creating work request via myBuildings API...");
    const result = await createWorkRequest(body);
    return { status: 200, jsonBody: { message: "Work request created", result } };
  } catch (error: any) {
    context.error("Create failed:", error.message);
    return errorResponse("Create failed", error.message);
  }
}

app.http("getWorkRequests", { methods: ["GET"], authLevel: "anonymous", handler: getWorkRequests });
app.http("getWorkRequest", { methods: ["GET"], authLevel: "anonymous", handler: getWorkRequest });
app.http("updateWorkRequest", { methods: ["POST"], authLevel: "anonymous", handler: updateWorkRequest });
app.http("createWorkRequest", { methods: ["POST"], authLevel: "anonymous", handler: handleCreateWorkRequest });
