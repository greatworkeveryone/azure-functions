// GET /api/tenantListRequests  (TR3, anonymous; header X-Tenant-Link: <token>)
// The requests this tenancy submitted through its links, newest first, each with a status timeline.
// Scope is the resolved tenancy; nothing in the request can change it.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { runTenant, tenantJson } from "../tenantPage/gate";
import { listTenantRequests } from "../tenantPage/list";

export async function tenantListRequests(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runTenant(request, context, "tenantListRequests", { perLink: { limit: 30, windowMs: 60_000 }, recordUse: false }, async ({ connection, identity }) =>
    tenantJson(200, { requests: await listTenantRequests(connection, identity.tenantId) }),
  );
}

app.http("tenantListRequests", { authLevel: "anonymous", handler: tenantListRequests, methods: ["GET"] });
