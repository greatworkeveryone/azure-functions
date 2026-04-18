import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { uploadAttachment } from "../mybuildings-client";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";

async function handleUploadAttachment(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  try {
    const body = await request.json() as any;
    context.log("Uploading attachment via myBuildings API...");
    const result = await uploadAttachment(body);
    return { status: 200, jsonBody: { message: "Attachment uploaded", result } };
  } catch (error: any) {
    context.error("Upload failed:", error.message);
    return errorResponse("Upload failed", error.message);
  }
}

app.http("uploadAttachment", { methods: ["POST"], authLevel: "anonymous", handler: handleUploadAttachment });
