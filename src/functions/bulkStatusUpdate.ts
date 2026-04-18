import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { bulkStatusUpdate } from "../mybuildings-client";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";

async function handleBulkStatusUpdate(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

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
