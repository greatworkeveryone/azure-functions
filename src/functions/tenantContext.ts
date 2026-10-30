// GET /api/tenantContext  (TR3, anonymous; header X-Tenant-Link: <token>)
// What the tenant page shows for the tenancy behind the link: company, building, suite, the
// categories, the emergency phone when one is set, and whether this contact may report problems.
// Opening the page counts as a link use (tenancy.link_use on the ledger). See tenantPage/gate.ts.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { readTenantContext } from "../tenantPage/context";
import { linkNotValid, runTenant, tenantJson } from "../tenantPage/gate";

export async function tenantContext(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runTenant(request, context, "tenantContext", { perLink: { limit: 30, windowMs: 60_000 }, recordUse: true }, async ({ connection, identity }) => {
    const page = await readTenantContext(connection, identity);
    return page ? tenantJson(200, page) : linkNotValid();
  });
}

app.http("tenantContext", { authLevel: "anonymous", handler: tenantContext, methods: ["GET"] });
