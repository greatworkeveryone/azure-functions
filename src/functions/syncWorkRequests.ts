import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createConnection, closeConnection, executeQuery } from "../db";
import { fetchWorkRequests } from "../mybuildings-client";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";
import { assertResolvedWithinThreshold, resolveAll } from "../sync-helpers";
import { upsertWorkRequest } from "./workRequests";

async function syncWorkRequests(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const buildingId = request.query.get("buildingId") || "";
    const statusId = request.query.get("statusId") || "";
    const lastModified = request.query.get("lastModifiedDate") || "";

    let params = "";
    if (buildingId) params += `buildingID=${buildingId}&`;
    if (statusId) params += `statusID=${statusId}&`;
    if (lastModified) params += `lastmodifieddate=${lastModified}&`;
    params = params.replace(/&$/, "");

    context.log("Fetching work requests from myBuildings API...");
    const workRequests = await fetchWorkRequests(params);
    context.log(`Fetched ${workRequests.length} work requests`);

    connection = await createConnection(token);

    // Resolve the BuildingID myBuildings omits — using the query param when
    // it's a per-building sync, otherwise a name→id lookup from Buildings.
    const fallbackId = buildingId ? parseInt(buildingId) : undefined;
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
