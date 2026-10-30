// POST /api/setTenancyEmailOnly  (TR2)
// Body: { tenantId, emailOnly, rowVersion } (the tenancyRowVersion from getTenancyContacts). Marks a tenancy
// email only (agencies whose IT blocks links): it is never issued a link, and any working ones are revoked.
// A stale rowVersion is a 409. Response: the tenancy's contacts, as getTenancyContacts.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { positiveId } from "../tenantLinks/contacts";
import { authorizeWrite } from "../assetRegisterSupport";
import { refusal, runStaff } from "../tenantLinks/http";
import { loadTenancyContacts } from "../tenantLinks/read";
import { setEmailOnly } from "../tenantLinks/revoke";
import { MANAGE_TENANT_LINKS_ROLES } from "../tenantLinks/roles";

export async function setTenancyEmailOnly(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, MANAGE_TENANT_LINKS_ROLES);
  if (!auth.ok) return auth.response;
  return runStaff(request, context, "setTenancyEmailOnly", auth.token, true, async ({ actor, body, connection }) => {
    const tenantId = positiveId(body.tenantId);
    if (tenantId === null) return refusal(400, "tenantId is required");
    if (typeof body.emailOnly !== "boolean") return refusal(400, "emailOnly must be true or false");
    const result = await setEmailOnly(connection, { actor, emailOnly: body.emailOnly, rowVersion: body.rowVersion, tenantId });
    if (!result.ok) return refusal(result.status, result.error);
    return { jsonBody: await loadTenancyContacts(connection, tenantId, actor.name), status: 200 };
  });
}

app.http("setTenancyEmailOnly", { authLevel: "anonymous", handler: setTenancyEmailOnly, methods: ["POST"] });
