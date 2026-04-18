import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { createConnection, closeConnection } from "../db";
import { fetchWorkRequests } from "../mybuildings-client";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";
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
    for (const wr of workRequests) {
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
