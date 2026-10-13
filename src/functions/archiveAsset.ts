// POST /api/archiveAsset   Body: { assetId }
//
// Soft-archive (managers only). Archived assets drop out of getAssets, become
// read-only, and release their AssetTag for reuse; job links stay as history.
// An asset that still has live components cannot be archived - archive or move
// them first, so no component is left under an archived parent.
// Idempotent: archiving an archived asset returns it unchanged.
// Response: { asset }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { closeConnection, createRequestConnection, executeQuery, type SqlRow } from "../db";
import { errorResponse } from "../auth";
import { ARCHIVE_ASSETS_ROLES, assetRowToApi, parseAssetIdInput } from "../assetRegister";
import {
  authorizeWrite,
  badRequest,
  conflict,
  errorMessage,
  fetchAsset,
  inTransaction,
  notFound,
  readJsonBody,
  txFail,
  txOk,
} from "../assetRegisterSupport";

export async function archiveAsset(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ARCHIVE_ASSETS_ROLES);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body) return badRequest("Request body must be a JSON object");
  const parsed = parseAssetIdInput(body);
  if (!parsed.ok) return badRequest(parsed.error);
  const { assetId } = parsed.value;

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const outcome = await inTransaction(conn, async () => {
      const row = await fetchAsset(conn, assetId, { forUpdate: true });
      if (!row) return txFail(notFound("Asset not found"));
      if (row.ArchivedAt) return txOk(assetRowToApi(row));

      const components = await executeQuery(
        conn,
        `SELECT COUNT(*) AS Total FROM dbo.Assets WHERE ParentAssetId = @AssetId AND ArchivedAt IS NULL`,
        [{ name: "AssetId", type: TYPES.Int, value: assetId }],
      );
      const live = Number(components[0]?.Total ?? 0);
      if (live > 0) {
        return txFail(
          conflict(`This asset has ${live} active component(s). Archive or move them first.`),
        );
      }

      await executeQuery(
        conn,
        `UPDATE dbo.Assets
            SET ArchivedAt = SYSUTCDATETIME(), ArchivedBy = @Caller,
                UpdatedAt = SYSUTCDATETIME(), UpdatedBy = @Caller
          WHERE AssetId = @AssetId`,
        [
          { name: "AssetId", type: TYPES.Int, value: assetId },
          { name: "Caller", type: TYPES.NVarChar, value: auth.caller.name },
        ],
      );
      const saved = await fetchAsset(conn, assetId);
      return txOk(assetRowToApi(saved as SqlRow));
    });
    if (!outcome.ok) return outcome.response;
    return { jsonBody: { asset: outcome.value }, status: 200 };
  } catch (error) {
    context.error("archiveAsset failed:", errorMessage(error));
    return errorResponse("Failed to archive asset", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("archiveAsset", { authLevel: "anonymous", handler: archiveAsset, methods: ["POST"] });
