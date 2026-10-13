// POST /api/archiveAsset   Body: { assetId, archived? }
//
// Soft-archive and restore (managers only). `archived` defaults to true;
// `archived: false` brings the asset back.
//
// Archive: the asset drops out of getAssets, becomes read-only, and releases its
// AssetTag for reuse; job links stay as history. An asset that still has live
// components cannot be archived - archive or move them first, so no component is
// left under an archived parent.
//
// Restore: clears ArchivedAt/ArchivedBy (UpdatedBy records who restored it, and
// the previous archiver and date go to the log). Refused with 409 while the
// parent asset is still archived, while its location has been deactivated, or
// when another live asset has taken the tag in the meantime - the same rules
// every other write enforces for a live asset. Nothing else on the row changes.
//
// Both directions are idempotent: archiving an archived asset, or restoring a
// live one, returns it unchanged.
// Response: { asset }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { closeConnection, createRequestConnection, executeQuery, type SqlRow } from "../db";
import { errorResponse } from "../auth";
import {
  ARCHIVE_ASSETS_ROLES,
  AssetApi,
  UNIQUE_INDEXES,
  assetRowToApi,
  parseArchiveInput,
  uniqueViolationName,
} from "../assetRegister";
import {
  Caller,
  TxResult,
  authorizeWrite,
  badRequest,
  conflict,
  errorMessage,
  fetchAsset,
  fetchLocation,
  inTransaction,
  notFound,
  readJsonBody,
  txFail,
  txOk,
} from "../assetRegisterSupport";

async function archiveRow(
  connection: Connection,
  row: SqlRow,
  caller: Caller,
): Promise<TxResult<AssetApi>> {
  if (row.ArchivedAt) return txOk(assetRowToApi(row));

  const assetId = Number(row.AssetId);
  const components = await executeQuery(
    connection,
    `SELECT COUNT(*) AS Total FROM dbo.Assets WHERE ParentAssetId = @AssetId AND ArchivedAt IS NULL`,
    [{ name: "AssetId", type: TYPES.Int, value: assetId }],
  );
  const live = Number(components[0]?.Total ?? 0);
  if (live > 0) {
    return txFail(conflict(`This asset has ${live} active component(s). Archive or move them first.`));
  }

  await executeQuery(
    connection,
    `UPDATE dbo.Assets
        SET ArchivedAt = SYSUTCDATETIME(), ArchivedBy = @Caller,
            UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @Caller
      WHERE AssetId = @AssetId`,
    [
      { name: "AssetId", type: TYPES.Int, value: assetId },
      { name: "Caller", type: TYPES.NVarChar, value: caller.name },
    ],
  );
  const saved = await fetchAsset(connection, assetId);
  return txOk(assetRowToApi(saved as SqlRow));
}

/** What an archived row can no longer vouch for: its parent is live, its location is active, its tag is free. */
async function restoreBlocker(connection: Connection, row: SqlRow): Promise<HttpResponseInit | null> {
  const assetId = Number(row.AssetId);

  if (row.ParentAssetId != null) {
    const parents = await executeQuery(
      connection,
      `SELECT Name, ArchivedAt FROM dbo.Assets WHERE AssetId = @ParentAssetId`,
      [{ name: "ParentAssetId", type: TYPES.Int, value: Number(row.ParentAssetId) }],
    );
    if (parents[0]?.ArchivedAt) {
      return conflict(`This asset's parent "${String(parents[0].Name)}" is archived. Restore the parent first.`);
    }
  }

  if (row.LocationId != null) {
    const location = await fetchLocation(connection, Number(row.LocationId));
    if (location && !location.Active) {
      return conflict(`This asset's location "${String(location.Name)}" is inactive. Reactivate the location first.`);
    }
  }

  if (row.AssetTag != null) {
    const clash = await executeQuery(
      connection,
      `SELECT TOP 1 AssetId, Name FROM dbo.Assets
        WHERE BuildingId = @BuildingId AND AssetTag = @AssetTag
          AND ArchivedAt IS NULL AND AssetId <> @AssetId`,
      [
        { name: "BuildingId", type: TYPES.Int, value: Number(row.BuildingId) },
        { name: "AssetTag", type: TYPES.NVarChar, value: String(row.AssetTag) },
        { name: "AssetId", type: TYPES.Int, value: assetId },
      ],
    );
    if (clash.length > 0) {
      return conflict(
        `Asset tag "${String(row.AssetTag)}" is now used by "${String(clash[0].Name)}" (asset ${Number(clash[0].AssetId)}) in this building. Rename or archive that asset first.`,
      );
    }
  }

  return null;
}

async function restoreRow(
  connection: Connection,
  row: SqlRow,
  caller: Caller,
  context: InvocationContext,
): Promise<TxResult<AssetApi>> {
  if (!row.ArchivedAt) return txOk(assetRowToApi(row));

  const blocked = await restoreBlocker(connection, row);
  if (blocked) return txFail(blocked);

  const assetId = Number(row.AssetId);
  await executeQuery(
    connection,
    `UPDATE dbo.Assets
        SET ArchivedAt = NULL, ArchivedBy = NULL,
            UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @Caller
      WHERE AssetId = @AssetId`,
    [
      { name: "AssetId", type: TYPES.Int, value: assetId },
      { name: "Caller", type: TYPES.NVarChar, value: caller.name },
    ],
  );
  // The columns that said who archived it and when are cleared; keep the trail.
  context.log(
    `archiveAsset: asset ${assetId} restored by ${caller.name} (archived ${new Date(row.ArchivedAt as Date).toISOString()} by ${String(row.ArchivedBy ?? "unknown")})`,
  );
  const saved = await fetchAsset(connection, assetId);
  return txOk(assetRowToApi(saved as SqlRow));
}

export async function archiveAsset(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ARCHIVE_ASSETS_ROLES);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body) return badRequest("Request body must be a JSON object");
  const parsed = parseArchiveInput(body);
  if (!parsed.ok) return badRequest(parsed.error);
  const { archived, assetId } = parsed.value;

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const outcome = await inTransaction(conn, async () => {
      const row = await fetchAsset(conn, assetId, { forUpdate: true });
      if (!row) return txFail(notFound("Asset not found"));
      return archived
        ? archiveRow(conn, row, auth.caller)
        : restoreRow(conn, row, auth.caller, context);
    });
    if (!outcome.ok) return outcome.response;
    return { jsonBody: { asset: outcome.value }, status: 200 };
  } catch (error) {
    // Two requests racing for the same tag: the loser's unique-index violation is still a 409.
    if (uniqueViolationName(error) === UNIQUE_INDEXES.assetTag) {
      return conflict("That asset tag is now used by another asset in this building. Rename or archive that asset first.");
    }
    context.error(`archiveAsset (${archived ? "archive" : "restore"}) failed:`, errorMessage(error));
    return errorResponse(archived ? "Failed to archive asset" : "Failed to restore asset", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("archiveAsset", { authLevel: "anonymous", handler: archiveAsset, methods: ["POST"] });
