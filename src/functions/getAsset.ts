// GET /api/getAsset?id=N
//
// One asset with everything the detail drawer needs. Response: { asset } where
// asset is AssetDetailApi: the AssetApi fields (incl. specs) plus
//   location     the location and its ancestors (path, pathLabel), or null
//   parent       the parent asset, or null
//   children     live (non-archived) component assets
//   linkedJobs   jobs currently linked to the asset (unlinked rows are history and
//                stay out) - jobId, jobCode, title, status, kind, isArchived
//   attachments  files with a short-lived sasUrl

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { errorResponse } from "../auth";
import {
  AssetDetailApi,
  VIEW_ASSETS_ROLES,
  assetRefRowToApi,
  assetRowToApi,
  linkedJobRowToApi,
  locationChainToApi,
  parseQueryInt,
} from "../assetRegister";
import { fetchAssetAttachments } from "../assetAttachments";
import {
  authorize,
  badRequest,
  errorMessage,
  fetchAsset,
  notFound,
} from "../assetRegisterSupport";

export async function getAsset(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorize(request, VIEW_ASSETS_ROLES);
  if (!auth.ok) return auth.response;

  const id = parseQueryInt(request.query.get("id"), "id");
  if (!id.ok) return badRequest(id.error);
  const assetId = id.value;
  if (assetId === undefined || assetId < 1) return badRequest("id query param required");

  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const row = await fetchAsset(connection, assetId);
    if (!row) return notFound("Asset not found");
    const base = assetRowToApi(row);

    // The location's ancestry, root first. Depth is capped so a corrupt cycle
    // cannot recurse forever.
    const chain = row.LocationId
      ? await executeQuery(
          connection,
          `WITH Chain AS (
             SELECT l.LocationId, l.ParentLocationId, l.Kind, l.Name, l.SpaceType, l.Active, 0 AS Depth
               FROM dbo.Locations l WHERE l.LocationId = @LocationId
             UNION ALL
             SELECT p.LocationId, p.ParentLocationId, p.Kind, p.Name, p.SpaceType, p.Active, c.Depth + 1
               FROM dbo.Locations p JOIN Chain c ON p.LocationId = c.ParentLocationId
              WHERE c.Depth < 20
           )
           SELECT LocationId, Kind, Name, SpaceType, Active FROM Chain ORDER BY Depth DESC`,
          [{ name: "LocationId", type: TYPES.Int, value: row.LocationId }],
        )
      : [];

    const parentRows = row.ParentAssetId
      ? await executeQuery(
          connection,
          `SELECT AssetId, AssetTag, Name, Category, Status, ArchivedAt
             FROM dbo.Assets WHERE AssetId = @ParentAssetId`,
          [{ name: "ParentAssetId", type: TYPES.Int, value: row.ParentAssetId }],
        )
      : [];

    const childRows = await executeQuery(
      connection,
      `SELECT AssetId, AssetTag, Name, Category, Status, ArchivedAt
         FROM dbo.Assets
        WHERE ParentAssetId = @AssetId AND ArchivedAt IS NULL
        ORDER BY Name, AssetId`,
      [{ name: "AssetId", type: TYPES.Int, value: assetId }],
    );

    const jobRows = await executeQuery(
      connection,
      `SELECT j.JobID, j.JobCode, j.Title, j.Status, j.Kind, j.IsArchived, ja.LinkedAt, ja.LinkedBy
         FROM dbo.JobAssets ja
         JOIN dbo.Jobs j ON j.JobID = ja.JobId
        WHERE ja.AssetId = @AssetId AND ja.UnlinkedAt IS NULL
        ORDER BY ja.LinkedAt DESC, j.JobID DESC`,
      [{ name: "AssetId", type: TYPES.Int, value: assetId }],
    );

    const attachments = await fetchAssetAttachments(connection, assetId);

    const asset: AssetDetailApi = {
      ...base,
      attachments,
      children: childRows.map(assetRefRowToApi),
      linkedJobs: jobRows.map(linkedJobRowToApi),
      location: locationChainToApi(chain),
      parent: parentRows[0] ? assetRefRowToApi(parentRows[0]) : null,
      specs: base.specs ?? null,
    };
    return { jsonBody: { asset }, status: 200 };
  } catch (error) {
    context.error("getAsset failed:", errorMessage(error));
    return errorResponse("Failed to fetch asset", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getAsset", { authLevel: "anonymous", handler: getAsset, methods: ["GET"] });
