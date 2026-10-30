// POST /api/tenantUploadPhoto  (TR3, anonymous; headers X-Tenant-Link: <token>, X-Tenant-Request: <requestId>)
// Body: the raw bytes of ONE image (JPEG, PNG or WebP, up to 8 MB), Content-Type set to its type.
// At most five per request, only onto a request this tenancy submitted in the last two hours. The bytes
// are structure-checked and stored unchanged in a private quarantine container (photos.ts says why).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { LIMITS } from "../tenantPage/constants";
import { readCappedBody } from "../tenantPage/body";
import { runTenant, tenantJson } from "../tenantPage/gate";
import { parseRequestId, storePhoto } from "../tenantPage/photos";

export async function tenantUploadPhoto(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runTenant(request, context, "tenantUploadPhoto", { perLink: { limit: 20, windowMs: 10 * 60_000 }, recordUse: false }, async ({ connection, identity }) => {
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
