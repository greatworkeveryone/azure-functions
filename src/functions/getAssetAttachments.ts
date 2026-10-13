// GET /api/getAssetAttachments?assetId=N
//
// Files attached to an asset, newest first, each with a short-lived sasUrl.
// Response: { attachments, count } (AssetAttachmentApi[]).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { closeConnection, createRequestConnection } from "../db";
import { errorResponse } from "../auth";
import { VIEW_ASSETS_ROLES, parseQueryInt } from "../assetRegister";
import { fetchAssetAttachments } from "../assetAttachments";
import { authorize, badRequest, errorMessage } from "../assetRegisterSupport";

export async function getAssetAttachments(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const auth = await authorize(request, VIEW_ASSETS_ROLES);
  if (!auth.ok) return auth.response;

  const assetId = parseQueryInt(request.query.get("assetId"), "assetId");
  if (!assetId.ok) return badRequest(assetId.error);
  if (assetId.value === undefined || assetId.value < 1) return badRequest("assetId query param required");

  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const attachments = await fetchAssetAttachments(connection, assetId.value);
    return { jsonBody: { attachments, count: attachments.length }, status: 200 };
  } catch (error) {
    context.error("getAssetAttachments failed:", errorMessage(error));
    return errorResponse("Failed to fetch asset attachments", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getAssetAttachments", {
  authLevel: "anonymous",
  handler: getAssetAttachments,
  methods: ["GET"],
});
