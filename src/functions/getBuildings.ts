import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createConnection, executeQuery, closeConnection, SqlRow } from "../db";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";
import { TYPES } from "tedious";

// In-memory cache for the unfiltered Buildings list. Buildings change rarely;
// 5 minutes is short enough that edits show up quickly and long enough to skip
// the connect+query on rapid repeat hits from the frontend. Sync endpoints
// call clearBuildingsCache() after writing so a stale empty result doesn't
// linger after a fresh sync.
const BUILDINGS_CACHE_TTL_MS = 5 * 60 * 1000;
let buildingsCache: { rows: SqlRow[]; expiresAt: number } | null = null;

export function clearBuildingsCache(): void {
  buildingsCache = null;
}

async function getBuildings(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const buildingId = request.query.get("buildingId");
  const region = request.query.get("region");

  if (!buildingId && !region && buildingsCache && buildingsCache.expiresAt > Date.now()) {
    return {
      status: 200,
      jsonBody: { buildings: buildingsCache.rows, count: buildingsCache.rows.length },
    };
  }

  let connection;
  try {
    connection = await createConnection(token);

    let sql = "SELECT * FROM Buildings WHERE 1=1";
    const params: { name: string; type: any; value: any }[] = [];

    if (buildingId) {
      sql += " AND BuildingID = @BuildingID";
      params.push({ name: "BuildingID", type: TYPES.Int, value: parseInt(buildingId) });
    }
    if (region) {
      sql += " AND Region = @Region";
      params.push({ name: "Region", type: TYPES.NVarChar, value: region });
    }

    sql += " ORDER BY BuildingName";
    const rows = await executeQuery(connection, sql, params);

    if (!buildingId && !region) {
      buildingsCache = { rows, expiresAt: Date.now() + BUILDINGS_CACHE_TTL_MS };
    }

    return { status: 200, jsonBody: { buildings: rows, count: rows.length } };
  } catch (error: any) {
    context.error("Query failed:", error.message);
    return errorResponse("Query failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getBuildings", { methods: ["GET"], authLevel: "anonymous", handler: getBuildings });
