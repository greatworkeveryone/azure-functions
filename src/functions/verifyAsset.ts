// POST /api/verifyAsset   Body: { assetId }
//
// "A person has confirmed what and where this asset is." Stamps VerifiedAt /
// VerifiedBy from the caller's token (never the body); verifying again moves the
// stamp to the new verifier and date. Archived assets cannot be verified.
// upsertAsset clears the stamp when identity fields change unless it re-verifies.
// Response: { asset }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import type { Connection } from "tedious";
import { closeConnection, createRequestConnection, executeQuery, type SqlRow } from "../db";
import { errorResponse } from "../auth";
import { VERIFY_ASSETS_ROLES, assetRowToApi, parseAssetIdInput } from "../assetRegister";
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

export async function verifyAsset(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, VERIFY_ASSETS_ROLES);
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
      if (row.ArchivedAt) return txFail(conflict("Archived assets cannot be verified"));

      await executeQuery(
        conn,
        `UPDATE dbo.Assets
            SET VerifiedAt = SYSUTCDATETIME(), VerifiedBy = @Caller
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
    context.error("verifyAsset failed:", errorMessage(error));
    return errorResponse("Failed to verify asset", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("verifyAsset", { authLevel: "anonymous", handler: verifyAsset, methods: ["POST"] });
