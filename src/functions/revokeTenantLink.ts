// POST /api/revokeTenantLink  (TR2)
// Body: { tenantId, contactId }. Revokes the contact's working link(s); it stops working at once. Ledgered.
// Response: { revoked: <count> }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { positiveId } from "../tenantLinks/contacts";
import { authorizeWrite } from "../assetRegisterSupport";
import { refusal, runStaff } from "../tenantLinks/http";
import { revokeContactLink } from "../tenantLinks/revoke";
import { MANAGE_TENANT_LINKS_ROLES } from "../tenantLinks/roles";

export async function revokeTenantLink(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, MANAGE_TENANT_LINKS_ROLES);
  if (!auth.ok) return auth.response;
  return runStaff(request, context, "revokeTenantLink", auth.token, true, async ({ actor, body, connection }) => {
    const tenantId = positiveId(body.tenantId);
    const contactId = positiveId(body.contactId);
    if (tenantId === null || contactId === null) return refusal(400, "tenantId and contactId are required");
    const result = await revokeContactLink(connection, { actor, contactId, tenantId });
    return result.ok ? { jsonBody: { revoked: result.revoked }, status: 200 } : refusal(result.status, result.error);
  });
}

app.http("revokeTenantLink", { authLevel: "anonymous", handler: revokeTenantLink, methods: ["POST"] });
