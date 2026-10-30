// POST /api/tenantSubmitRequest  (TR3, anonymous; header X-Tenant-Link: <token>)
// Body: { requestKey? (client-generated id, a retry returns the original), category, urgency: "emergency"|"urgent"|"routine", location?, description, accessNotes? }.
// Creates a native work request for the tenancy and contact behind the link. Any id in the body is
// ignored. Response: { reference, requestId } (photos are added with tenantUploadPhoto).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { readCappedBody } from "../tenantPage/body";
import { runTenant, tenantJson } from "../tenantPage/gate";
import { parseSubmit, submitRequest } from "../tenantPage/submit";

const MAX_BODY_BYTES = 16 * 1024;

export async function readSmallJson(request: HttpRequest): Promise<Record<string, unknown> | "too_large" | null> {
  const bytes = await readCappedBody(request, MAX_BODY_BYTES);
  if (bytes === "too_large") return "too_large";
  try {
    const parsed: unknown = JSON.parse(bytes.toString("utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export async function tenantSubmitRequest(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runTenant(request, context, "tenantSubmitRequest", { perLink: { limit: 8, windowMs: 10 * 60_000 }, recordUse: false }, async ({ connection, identity }) => {
    const body = await readSmallJson(request);
    if (body === "too_large") return tenantJson(413, { error: "That is too much text" });
    if (body === null) return tenantJson(400, { error: "Request body must be a JSON object" });
    const parsed = parseSubmit(body);
    if (!parsed.ok) return tenantJson(400, { error: parsed.error });
    const result = await submitRequest(connection, identity, parsed.value);
    if (!result.ok) return tenantJson(result.status, { error: result.error });
    return tenantJson(result.repeat ? 200 : 201, { reference: result.reference, requestId: result.requestId });
  });
}

app.http("tenantSubmitRequest", { authLevel: "anonymous", handler: tenantSubmitRequest, methods: ["POST"] });
