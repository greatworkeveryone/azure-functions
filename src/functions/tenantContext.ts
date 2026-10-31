// GET /api/tenantContext  (TR3, anonymous; header X-Tenant-Link: <token>)
// What the tenant page shows for the tenancy behind the link: company, building, suite, the
// categories, the after-hours phone, and whether this contact may report problems.
// Opening the page counts as a link use (tenancy.link_use on the ledger). See tenantPage/gate.ts.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { RATE } from "../tenantPage/constants";
import { readTenantContext } from "../tenantPage/context";
import { linkNotValid, runTenant, tenantJson } from "../tenantPage/gate";

export async function tenantContext(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runTenant(request, context, "tenantContext", { perLink: RATE.context, recordUse: true, section: "requests" }, async ({ afterHoursPhone, connection, identity }) => {
    const page = await readTenantContext(connection, identity, afterHoursPhone);
    return page ? tenantJson(200, page) : linkNotValid();
  });
}

app.http("tenantContext", { authLevel: "anonymous", handler: tenantContext, methods: ["GET"] });
