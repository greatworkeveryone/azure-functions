import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createRequestConnection, closeConnection, executeQuery } from "../db";
import { fetchWorkRequests } from "../mybuildings-client";
import { AppRole, extractToken, requireRole, unauthorizedResponse, errorResponse } from "../auth";
import { assertResolvedWithinThreshold, resolveAll } from "../sync-helpers";
import { parseIntegerParam, upsertWorkRequest } from "./workRequests";

async function syncWorkRequests(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  let connection;
  try {
    const buildingId = request.query.get("buildingId") || "";
    const statusId = request.query.get("statusId") || "";
    const lastModified = request.query.get("lastModifiedDate") || "";

    // Whole numbers only, and every value encoded, so a query value cannot add upstream parameters.
    const buildingNumber = buildingId ? parseIntegerParam(buildingId) : null;
    if (buildingId && buildingNumber === null) return { status: 400, jsonBody: { error: "buildingId must be a whole number" } };
    const statusNumber = statusId ? parseIntegerParam(statusId) : null;
    if (statusId && statusNumber === null) return { status: 400, jsonBody: { error: "statusId must be a whole number" } };
    const upstream = new URLSearchParams();
    if (buildingNumber !== null) upstream.set("buildingID", String(buildingNumber));
    if (statusNumber !== null) upstream.set("statusID", String(statusNumber));
    if (lastModified) upstream.set("lastmodifieddate", lastModified);
    const params = upstream.toString();

    context.log("Fetching work requests from myBuildings API...");
    const workRequests = await fetchWorkRequests(params);
    context.log(`Fetched ${workRequests.length} work requests`);

    connection = await createRequestConnection(token);

    // Resolve the BuildingID myBuildings omits — using the query param when
    // it's a per-building sync, otherwise a name→id lookup from Buildings.
    const fallbackId = buildingNumber ?? undefined;
    let nameToId: Map<string, number> | undefined;
    if (!fallbackId) {
      const buildingRows = await executeQuery(
        connection,
        "SELECT BuildingID, BuildingName FROM Buildings WHERE BuildingName IS NOT NULL"
      );
      nameToId = new Map(buildingRows.map((b: any) => [b.BuildingName, b.BuildingID]));
    }

    const { resolved, unresolvedCount } = resolveAll(workRequests, { fallbackId, nameToId });
    if (unresolvedCount > 0) {
      context.log(`syncWorkRequests: ${unresolvedCount}/${workRequests.length} WRs could not be resolved to a BuildingID`);
    }
    assertResolvedWithinThreshold(unresolvedCount, workRequests.length);

    for (const wr of resolved) {
      await upsertWorkRequest(connection, wr);
    }

    return { status: 200, jsonBody: { message: "Sync complete", total: workRequests.length } };
  } catch (error: any) {
    context.error("Sync failed:", error.message);
    return errorResponse("Sync failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("syncWorkRequests", { methods: ["POST"], authLevel: "anonymous", handler: syncWorkRequests });
