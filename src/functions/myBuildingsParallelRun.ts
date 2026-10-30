// GET /api/getMyBuildingsParallelRun?since=YYYY-MM-DD — the TR6 side-by-side
// report (plan gate T3). Read-only. Admin and directors (the viewAdmin roles). Lists requests seen in
// myBuildings but not in Floorplan and the Floorplan-native ones myBuildings
// does not hold, with the current switch values.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { AppRole, extractToken, requireRole, unauthorizedResponse, errorResponse } from "../auth";
import { currentSwitches } from "../config/mybuildingsSwitches";
import { fetchWorkRequests } from "../mybuildings-client";
import { toMyBuildingsDate } from "../mybuildings-dates";

const LIST_CAP = 500;
const ID_BATCH = 500;
const DEFAULT_DAYS = 14;

export async function handleParallelRun(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, [AppRole.ADMIN, AppRole.DIRECTOR]);
  if (denied) return denied;

  const sinceRaw = request.query.get("since");
  if (sinceRaw && (!/^\d{4}-\d{2}-\d{2}$/.test(sinceRaw) || Number.isNaN(Date.parse(sinceRaw)))) {
    return { status: 400, jsonBody: { error: "since must be a date as YYYY-MM-DD" } };
  }
  const since = sinceRaw ? new Date(`${sinceRaw}T00:00:00Z`) : new Date(Date.now() - DEFAULT_DAYS * 86_400_000);
  const switches = currentSwitches();

  let connection;
  try {
    connection = await createRequestConnection(token);

    const nativeRows = await executeQuery(
      connection,
      `SELECT TOP ${LIST_CAP} WorkRequestID, BuildingName, TenantName, Status, LEFT(Details, 200) AS Details, CreatedAt
       FROM WorkRequests WHERE CreatedAt >= @Since AND (WorkRequestID < 0 OR SourceHost = N'floorplan')
       ORDER BY CreatedAt DESC`,
      [{ name: "Since", type: TYPES.DateTime2, value: since }],
    );

    let onlyInMyBuildings: Record<string, unknown>[] = [];
    let onlyInMyBuildingsCount = 0;
    let outOfDateCount = 0;
    let matchedCount = 0;
    let upstreamTotal: number | null = null;
    let upstreamNote: string | null = null;

    if (!switches.mayPull) {
      upstreamNote = "MYBUILDINGS_SYNC_MODE is off: myBuildings was not asked, so only Floorplan's side is shown.";
    } else {
      const upstream = await fetchWorkRequests(new URLSearchParams({ lastmodifieddate: toMyBuildingsDate(since) }).toString());
      upstreamTotal = upstream.length;
      const ids = upstream.map((wr) => wr.WorkRequestID).filter((id): id is number => typeof id === "number");
      const local = new Map<number, string | null>();
      for (let i = 0; i < ids.length; i += ID_BATCH) {
        const rows = await executeQuery(
          connection,
          "SELECT WorkRequestID, LastModifiedDate FROM WorkRequests WHERE WorkRequestID IN (SELECT CAST(value AS INT) FROM OPENJSON(@Ids))",
          [{ name: "Ids", type: TYPES.NVarChar, value: JSON.stringify(ids.slice(i, i + ID_BATCH).map((id) => Math.trunc(id))) }],
        );
        for (const row of rows) local.set(row.WorkRequestID as number, (row.LastModifiedDate as string | null) ?? null);
      }
      const missing = upstream.filter((wr) => typeof wr.WorkRequestID !== "number" || !local.has(wr.WorkRequestID));
      onlyInMyBuildingsCount = missing.length;
      onlyInMyBuildings = missing.slice(0, LIST_CAP).map((wr) => ({
        WorkRequestID: wr.WorkRequestID ?? null,
        BuildingName: wr.BuildingName ?? null,
        TenantName: wr.TenantName ?? null,
        Status: wr.Status ?? null,
        Details: wr.Details?.slice(0, 200) ?? null,
        LastModifiedDate: wr.LastModifiedDate ?? null,
      }));
      for (const wr of upstream) {
        if (typeof wr.WorkRequestID !== "number" || !local.has(wr.WorkRequestID)) continue;
        matchedCount += 1;
        if ((local.get(wr.WorkRequestID) ?? null) !== (wr.LastModifiedDate ?? null)) outOfDateCount += 1;
      }
    }

    return {
      status: 200,
      jsonBody: {
        since: since.toISOString().slice(0, 10),
        switches,
        upstreamNote,
        upstreamTotal,
        matchedCount,
        outOfDateCount,
        onlyInMyBuildings,
        onlyInMyBuildingsCount,
        onlyInFloorplan: nativeRows,
        onlyInFloorplanCount: nativeRows.length,
        listCap: LIST_CAP,
      },
    };
  } catch (error: any) {
    context.error("getMyBuildingsParallelRun failed:", error.message);
    return errorResponse("Report failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getMyBuildingsParallelRun", { methods: ["GET"], authLevel: "anonymous", handler: handleParallelRun });
