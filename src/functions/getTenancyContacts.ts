// GET /api/getTenancyContacts?tenantId=N  (TR2, PLAN §15)
// The tenancy's contacts with roles and the status of each personal link, plus the email-only flag.
// Seeds the primary contact on first read. Response: { contacts, emailOnly, tenancyRowVersion, tenantId }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { loadTenancyContacts } from "../tenantLinks/read";
import { refusal, runStaff } from "../tenantLinks/http";
import { VIEW_TENANT_LINKS_ROLES } from "../tenantLinks/roles";

export async function getTenancyContacts(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runStaff(request, context, "getTenancyContacts", VIEW_TENANT_LINKS_ROLES, false, async ({ actor, connection }) => {
    const tenantId = Number(request.query.get("tenantId"));
    if (!Number.isInteger(tenantId) || tenantId <= 0) return refusal(400, "tenantId must be a whole number");
    const result = await loadTenancyContacts(connection, tenantId, actor.name);
    return result ? { jsonBody: result, status: 200 } : refusal(404, "Tenancy not found");
  });
}

app.http("getTenancyContacts", { authLevel: "anonymous", handler: getTenancyContacts, methods: ["GET"] });
