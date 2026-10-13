// GET /api/getAssetTypes?category=&includeInactive=
//
// The controlled asset-type taxonomy, ordered by category, sortOrder, name.
// Active types only unless includeInactive=true (for the manager screen).
// Response: { assetTypes, count } (AssetTypeApi[]).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createRequestConnection, executeQuery, SqlParam } from "../db";
import { errorResponse } from "../auth";
import {
  VIEW_ASSETS_ROLES,
  assetTypeRowToApi,
  normaliseAssetCategory,
  parseQueryBool,
} from "../assetRegister";
import { ASSET_TYPE_COLUMNS, authorize, badRequest, errorMessage } from "../assetRegisterSupport";

export async function getAssetTypes(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorize(request, VIEW_ASSETS_ROLES);
  if (!auth.ok) return auth.response;

  const includeInactive = parseQueryBool(request.query.get("includeInactive"), "includeInactive");
  if (!includeInactive.ok) return badRequest(includeInactive.error);
  const rawCategory = request.query.get("category");
  const category = rawCategory ? normaliseAssetCategory(rawCategory) : null;
  if (rawCategory && !category) return badRequest(`Unknown category: ${rawCategory}`);

  const whereParts: string[] = [];
  const params: SqlParam[] = [];
  if (!includeInactive.value) whereParts.push("t.Active = 1");
  if (category) {
    whereParts.push("t.Category = @Category");
    params.push({ name: "Category", type: TYPES.NVarChar, value: category });
  }
  const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const rows = await executeQuery(
      connection,
      `SELECT ${ASSET_TYPE_COLUMNS}
       FROM dbo.AssetTypes t
       ${whereSql}
       ORDER BY t.Category, t.SortOrder, t.Name, t.AssetTypeId`,
      params,
    );
    const assetTypes = rows.map(assetTypeRowToApi);
    return { jsonBody: { assetTypes, count: assetTypes.length }, status: 200 };
  } catch (error) {
    context.error("getAssetTypes failed:", errorMessage(error));
    return errorResponse("Failed to fetch asset types", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getAssetTypes", { authLevel: "anonymous", handler: getAssetTypes, methods: ["GET"] });
