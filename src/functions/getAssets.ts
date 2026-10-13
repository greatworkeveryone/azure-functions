// GET /api/getAssets
//
// Query (all optional, combined with AND):
//   buildingId      BuildingID (the upstream key; negative for manual buildings)
//   category        one of the maintenance categories (case-insensitive)
//   locationId      assets whose locationId is exactly this (no sub-locations)
//   status          active | out_of_service | decommissioned
//   verified        true -> verified assets only, false -> unverified only
//   unclassified    true -> assets with no asset type, false -> typed assets only
//   includeArchived true to include archived assets (default: excluded)
//   page, pageSize  opt-in pagination; without them the list is capped at MAX_LIST_ROWS
// Response: { count, assets, total, truncated, page?, pageSize? } - list items
// omit `specs`; fetch getAsset for the full record.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createRequestConnection, executeQuery, SqlParam } from "../db";
import { errorResponse } from "../auth";
import { MAX_LIST_ROWS, paginationSqlSuffix, parsePagination } from "../pagination";
import {
  ASSET_STATUSES,
  AssetStatus,
  VIEW_ASSETS_ROLES,
  assetRowToApi,
  normaliseAssetCategory,
  parseQueryBool,
  parseQueryInt,
} from "../assetRegister";
import {
  ASSET_FROM,
  ASSET_LIST_COLUMNS,
  authorize,
  badRequest,
  errorMessage,
} from "../assetRegisterSupport";

export async function getAssets(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorize(request, VIEW_ASSETS_ROLES);
  if (!auth.ok) return auth.response;

  const query = request.query;
  const buildingId = parseQueryInt(query.get("buildingId"), "buildingId");
  if (!buildingId.ok) return badRequest(buildingId.error);
  const locationId = parseQueryInt(query.get("locationId"), "locationId");
  if (!locationId.ok) return badRequest(locationId.error);
  const verified = parseQueryBool(query.get("verified"), "verified");
  if (!verified.ok) return badRequest(verified.error);
  const unclassified = parseQueryBool(query.get("unclassified"), "unclassified");
  if (!unclassified.ok) return badRequest(unclassified.error);
  const includeArchived = parseQueryBool(query.get("includeArchived"), "includeArchived");
  if (!includeArchived.ok) return badRequest(includeArchived.error);

  const rawCategory = query.get("category");
  const category = rawCategory ? normaliseAssetCategory(rawCategory) : null;
  if (rawCategory && !category) return badRequest(`Unknown category: ${rawCategory}`);

  const rawStatus = query.get("status");
  if (rawStatus && !ASSET_STATUSES.includes(rawStatus as AssetStatus)) {
    return badRequest(`status must be one of: ${ASSET_STATUSES.join(", ")}`);
  }

  const whereParts: string[] = [];
  const params: SqlParam[] = [];
  if (!includeArchived.value) whereParts.push("a.ArchivedAt IS NULL");
  if (buildingId.value !== undefined) {
    whereParts.push("a.BuildingId = @BuildingId");
    params.push({ name: "BuildingId", type: TYPES.Int, value: buildingId.value });
  }
  if (category) {
    whereParts.push("a.Category = @Category");
    params.push({ name: "Category", type: TYPES.NVarChar, value: category });
  }
  if (locationId.value !== undefined) {
    whereParts.push("a.LocationId = @LocationId");
    params.push({ name: "LocationId", type: TYPES.Int, value: locationId.value });
  }
  if (rawStatus) {
    whereParts.push("a.Status = @Status");
    params.push({ name: "Status", type: TYPES.NVarChar, value: rawStatus });
  }
  if (verified.value !== undefined) {
    whereParts.push(verified.value ? "a.VerifiedAt IS NOT NULL" : "a.VerifiedAt IS NULL");
  }
  if (unclassified.value !== undefined) {
    whereParts.push(unclassified.value ? "a.AssetTypeId IS NULL" : "a.AssetTypeId IS NOT NULL");
  }
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

  const pagination = parsePagination(query);
  const topClause = pagination.active ? "" : `TOP ${MAX_LIST_ROWS} `;

  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const rows = await executeQuery(
      connection,
      `SELECT ${topClause}${ASSET_LIST_COLUMNS}
       ${ASSET_FROM}
       ${whereSql}
       ORDER BY a.BuildingId, a.Category, a.Name, a.AssetId${paginationSqlSuffix(pagination)}`,
      params,
    );
    const assets = rows.map(assetRowToApi);

    let total = assets.length;
    if (pagination.active) {
      const totals = await executeQuery(
        connection,
        `SELECT COUNT(*) AS Total FROM dbo.Assets a ${whereSql}`,
        params,
      );
      total = Number(totals[0]?.Total ?? assets.length);
    }

    const truncated = !pagination.active && assets.length >= MAX_LIST_ROWS;
    if (truncated) {
      context.warn(`getAssets: hit MAX_LIST_ROWS ceiling (${MAX_LIST_ROWS}) - caller should paginate`);
    }
    return {
      jsonBody: {
        assets,
        count: assets.length,
        total,
        truncated,
        ...(pagination.active ? { page: pagination.page, pageSize: pagination.pageSize } : {}),
      },
      status: 200,
    };
  } catch (error) {
    context.error("getAssets failed:", errorMessage(error));
    return errorResponse("Failed to fetch assets", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getAssets", { authLevel: "anonymous", handler: getAssets, methods: ["GET"] });
