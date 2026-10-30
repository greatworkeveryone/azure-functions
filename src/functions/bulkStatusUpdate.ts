import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { bulkStatusUpdate } from "../mybuildings-client";
import { mayPushWorkRequests } from "../config/mybuildingsSwitches";
import { AppRole, extractToken, requireRole, unauthorizedResponse, errorResponse } from "../auth";

async function handleBulkStatusUpdate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const denied = await requireRole(request, [AppRole.FACILITIES_APPROVAL]);
  if (denied) return denied;

  if (!mayPushWorkRequests()) {
    return { status: 409, jsonBody: { error: "Pushing to myBuildings is switched off; statuses are changed in Floorplan." } };
  }

  try {
    const body = await request.json() as any;
    context.log("Sending bulk status update to myBuildings API...");
    const result = await bulkStatusUpdate(body);
    return { status: 200, jsonBody: { message: "Bulk status update complete", result } };
  } catch (error: any) {
    context.error("Bulk status update failed:", error.message);
    return errorResponse("Bulk status update failed", error.message);
  }
}

app.http("bulkStatusUpdate", { methods: ["POST"], authLevel: "anonymous", handler: handleBulkStatusUpdate });
