// POST /api/tenantUploadPhoto  (TR3, anonymous; headers X-Tenant-Link: <token>, X-Tenant-Request: <requestId>)
// Body: the raw bytes of ONE image (JPEG, PNG or WebP), Content-Type set to its type.
// Photo count, size and the window come from tenantPage/constants LIMITS (5 per request, 8 MB, 2 hours at the time of writing). The bytes
// are structure-checked and stored unchanged in a private quarantine container (photos.ts says why).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { LIMITS, RATE } from "../tenantPage/constants";
import { readCappedBody } from "../tenantPage/body";
import { runTenant, tenantJson } from "../tenantPage/gate";
import { parseRequestId, storePhoto } from "../tenantPage/photos";

export async function tenantUploadPhoto(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runTenant(request, context, "tenantUploadPhoto", { perLink: RATE.upload, recordUse: false, section: "requests" }, async ({ connection, identity }) => {
    const requestId = parseRequestId(request.headers.get("x-tenant-request"));
    if (requestId === null) return tenantJson(400, { error: "Missing request reference" });
    const bytes = await readCappedBody(request, LIMITS.photoBytes);
    if (bytes === "too_large") return tenantJson(413, { error: "That photo is too large" });
    const result = await storePhoto(connection, identity, requestId, bytes, request.headers.get("content-type") ?? "");
    if (!result.ok) return tenantJson(result.status, { error: result.error });
    return tenantJson(201, { photoCount: result.photoCount, reference: result.reference });
  });
}

app.http("tenantUploadPhoto", { authLevel: "anonymous", handler: tenantUploadPhoto, methods: ["POST"] });
