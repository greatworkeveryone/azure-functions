// POST /api/importMyBuildings — staff-triggered import of work requests,
// their history fields and attachments from myBuildings into Floorplan (TR6).
// Admin only. Dry run unless ?dryRun=false. Idempotent; inserts and updates
// only, never deletes. Query: since=YYYY-MM-DD (default two years back),
// buildingId, attachmentLimit (1-100, default 25), recheckAttachments=true.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ACTION_ROLES } from "../action-roles";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { extractToken, requireRole, unauthorizedResponse, errorResponse, verifiedIdentityFromRequest } from "../auth";
import { uploadBlob } from "../blob-storage";
import { mayPullWorkRequests } from "../config/mybuildingsSwitches";
import { downloadAttachmentBytes, fetchWorkRequestAttachments, fetchWorkRequests } from "../mybuildings-client";
import { toMyBuildingsDate, TWO_YEARS_MS } from "../mybuildings-dates";
import { runMyBuildingsImport } from "../mybuildingsImport";
import { parseIntegerParam, upsertWorkRequest } from "./workRequests";

export async function handleImportMyBuildings(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.importMyBuildings.gate);
  if (denied) return denied;
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  if (!mayPullWorkRequests()) {
    return { status: 409, jsonBody: { error: "MYBUILDINGS_SYNC_MODE is off: the import reads from myBuildings, so it cannot run." } };
  }

  const dryRun = request.query.get("dryRun") !== "false";
  const sinceRaw = request.query.get("since");
  let since: Date;
  if (sinceRaw) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceRaw) || Number.isNaN(Date.parse(sinceRaw))) {
      return { status: 400, jsonBody: { error: "since must be a date as YYYY-MM-DD" } };
    }
    since = new Date(`${sinceRaw}T00:00:00Z`);
  } else {
    since = new Date(Date.now() - TWO_YEARS_MS);
  }
  const buildingRaw = request.query.get("buildingId");
  const buildingId = buildingRaw ? parseIntegerParam(buildingRaw) : null;
  if (buildingRaw && buildingId === null) return { status: 400, jsonBody: { error: "buildingId must be a whole number" } };
  const limitRaw = request.query.get("attachmentLimit");
  const attachmentLimit = limitRaw ? parseIntegerParam(limitRaw) : 25;
  if (attachmentLimit === null || attachmentLimit < 1 || attachmentLimit > 100) {
    return { status: 400, jsonBody: { error: "attachmentLimit must be a whole number from 1 to 100" } };
  }

  let connection;
  try {
    const upstream = new URLSearchParams({ lastmodifieddate: toMyBuildingsDate(since) });
    if (buildingId !== null) upstream.set("buildingID", String(buildingId));
    context.log(`importMyBuildings: ${dryRun ? "dry run" : "real run"} by ${identity.email}, since ${toMyBuildingsDate(since)}`);
    const workRequests = await fetchWorkRequests(upstream.toString());

    connection = await createRequestConnection(token);
    const buildingRows = await executeQuery(connection, "SELECT BuildingID, BuildingName FROM Buildings WHERE BuildingName IS NOT NULL");
    const nameToId = new Map<string, number>(buildingRows.map((b) => [b.BuildingName as string, b.BuildingID as number]));

    const result = await runMyBuildingsImport(
      connection,
      workRequests,
      nameToId,
      {
        downloadAttachment: downloadAttachmentBytes,
        fetchAttachments: fetchWorkRequestAttachments,
        storeBlob: async (bytes, name, contentType, keyPrefix) => (await uploadBlob(bytes, name, contentType, keyPrefix)).blobName,
        upsertWorkRequest,
      },
      {
        attachmentLimit,
        buildingId,
        dryRun,
        recheckAttachments: request.query.get("recheckAttachments") === "true",
        since: toMyBuildingsDate(since),
        startedBy: identity.email,
      },
      (message) => context.log(message),
    );
    return { status: 200, jsonBody: { ...result, fetched: workRequests.length } };
  } catch (error: any) {
    context.error("importMyBuildings failed:", error.message);
    return errorResponse("Import failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("importMyBuildings", { methods: ["POST"], authLevel: "anonymous", handler: handleImportMyBuildings });
