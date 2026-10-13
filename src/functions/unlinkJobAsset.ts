// POST /api/unlinkJobAsset   Body: { jobId, assetId }
//
// Ends a job <-> asset link. The row is kept: UnlinkedAt / UnlinkedBy are stamped
// (the caller comes from the token, never the body) and every read ignores it;
// linking the same pair again later inserts a fresh row. Idempotent: unlinking
// something that is not linked answers 200 with unlinked: false and changes
// nothing. Allowed on archived assets (clean-up).
// Response: { jobId, assetId, unlinked }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { errorResponse } from "../auth";
import { EDIT_ASSETS_ROLES, parseJobAssetInput } from "../assetRegister";
import { authorizeWrite, badRequest, errorMessage, readJsonBody } from "../assetRegisterSupport";

export async function unlinkJobAsset(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, EDIT_ASSETS_ROLES);
  if (!auth.ok) return auth.response;

  const body = await readJsonBody(request);
  if (!body) return badRequest("Request body must be a JSON object");
  const parsed = parseJobAssetInput(body);
  if (!parsed.ok) return badRequest(parsed.error);
  const { assetId, jobId } = parsed.value;

  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const ended = await executeQuery(
      connection,
      `UPDATE dbo.JobAssets
          SET UnlinkedAt = SYSUTCDATETIME(), UnlinkedBy = @Caller
       OUTPUT INSERTED.JobId
        WHERE JobId = @JobId AND AssetId = @AssetId AND UnlinkedAt IS NULL`,
      [
        { name: "JobId", type: TYPES.Int, value: jobId },
        { name: "AssetId", type: TYPES.Int, value: assetId },
        { name: "Caller", type: TYPES.NVarChar, value: auth.caller.name },
      ],
    );
    return { jsonBody: { assetId, jobId, unlinked: ended.length > 0 }, status: 200 };
  } catch (error) {
    context.error("unlinkJobAsset failed:", errorMessage(error));
    return errorResponse("Failed to unlink job and asset", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("unlinkJobAsset", { authLevel: "anonymous", handler: unlinkJobAsset, methods: ["POST"] });
