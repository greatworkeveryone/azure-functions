// POST /api/unlinkJobAsset   Body: { jobId, assetId }
//
// Removes a job <-> asset link. Idempotent: unlinking something that is not
// linked answers 200 with unlinked: false. Allowed on archived assets (clean-up).
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
    const removed = await executeQuery(
      connection,
      `DELETE FROM dbo.JobAssets
       OUTPUT DELETED.JobId
       WHERE JobId = @JobId AND AssetId = @AssetId`,
      [
        { name: "JobId", type: TYPES.Int, value: jobId },
        { name: "AssetId", type: TYPES.Int, value: assetId },
      ],
    );
    return { jsonBody: { assetId, jobId, unlinked: removed.length > 0 }, status: 200 };
  } catch (error) {
    context.error("unlinkJobAsset failed:", errorMessage(error));
    return errorResponse("Failed to unlink job and asset", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("unlinkJobAsset", { authLevel: "anonymous", handler: unlinkJobAsset, methods: ["POST"] });
