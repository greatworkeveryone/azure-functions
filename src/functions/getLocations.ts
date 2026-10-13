// GET /api/getLocations?buildingId=N
//
// Active locations as a flat list (build the tree via parentLocationId), levels
// first by SortOrder, then spaces. buildingId is optional; the list is capped
// at MAX_LIST_ROWS and flags `truncated` if it ever reaches the cap.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createRequestConnection, executeQuery, SqlParam } from "../db";
import { errorResponse } from "../auth";
import { MAX_LIST_ROWS } from "../pagination";
import { VIEW_ASSETS_ROLES, locationRowToApi, parseQueryInt } from "../assetRegister";
import { LOCATION_COLUMNS, authorize, badRequest, errorMessage } from "../assetRegisterSupport";

export async function getLocations(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorize(request, VIEW_ASSETS_ROLES);
  if (!auth.ok) return auth.response;

  const buildingId = parseQueryInt(request.query.get("buildingId"), "buildingId");
  if (!buildingId.ok) return badRequest(buildingId.error);

  const whereParts = ["l.Active = 1"];
  const params: SqlParam[] = [];
  if (buildingId.value !== undefined) {
    whereParts.push("l.BuildingId = @BuildingId");
    params.push({ name: "BuildingId", type: TYPES.Int, value: buildingId.value });
  }
  const whereSql = whereParts.join(" AND ");
  const topClause = `TOP ${MAX_LIST_ROWS} `;

  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const rows = await executeQuery(
      connection,
      `SELECT ${topClause}${LOCATION_COLUMNS}
       FROM dbo.Locations l
       WHERE ${whereSql}
       ORDER BY l.BuildingId, CASE l.Kind WHEN 'level' THEN 0 ELSE 1 END, l.SortOrder, l.Name, l.LocationId`,
      params,
    );
    const locations = rows.map(locationRowToApi);
    return {
      jsonBody: {
        count: locations.length,
        locations,
        truncated: locations.length >= MAX_LIST_ROWS,
      },
      status: 200,
    };
  } catch (error) {
    context.error("getLocations failed:", errorMessage(error));
    return errorResponse("Failed to fetch locations", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getLocations", { authLevel: "anonymous", handler: getLocations, methods: ["GET"] });
