// POST /api/issueTenantLink  (TR2)
// Body: { tenantId, contactId, reissue? (default false), expiryMonths? (1-36; default TENANT_LINK_EXPIRY_MONTHS or 12) }.
// Issues a personal link and emails it to the contact from notices@ (see tenantLinks/issue.ts). The link is
// never returned: it exists only in the email. reissue:true replaces a working link (the old one stops at
// once). Refused for an email-only tenancy, an archived contact or tenancy, and while sending is switched off.
// Response: { delivery: "sent" | "dry_run", expiresAt?, linkId? }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { checkRateLimit } from "../rateLimit";
import { positiveId } from "../tenantLinks/contacts";
import { refusal, runStaff } from "../tenantLinks/http";
import { issueLink } from "../tenantLinks/issue";
import { MANAGE_TENANT_LINKS_ROLES } from "../tenantLinks/roles";
import { expiryMonths } from "../tenantLinks/token";

export async function issueTenantLink(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return runStaff(request, context, "issueTenantLink", MANAGE_TENANT_LINKS_ROLES, true, async ({ actor, body, connection }) => {
    const tenantId = positiveId(body.tenantId);
    const contactId = positiveId(body.contactId);
    if (tenantId === null || contactId === null) return refusal(400, "tenantId and contactId are required");
    if (body.reissue !== undefined && typeof body.reissue !== "boolean") return refusal(400, "reissue must be true or false");
    const months = expiryMonths(body.expiryMonths);
    if (months === null) return refusal(400, "expiryMonths must be a whole number from 1 to 36");
    const limited = checkRateLimit(`issueTenantLink:${actor.name}`, { limit: 20 });
    if (!limited.allowed) return { headers: { "Retry-After": String(Math.ceil(limited.retryAfterMs / 1000)) }, jsonBody: { error: "Too many links issued, try again shortly" }, status: 429 };
    const result = await issueLink(connection, { actor, contactId, months, reissue: body.reissue === true, tenantId }, { log: (m) => context.log(m) });
    if (!result.ok) return refusal(result.status, result.error);
    const { ok: _ok, ...rest } = result;
    return { jsonBody: rest, status: 200 };
  });
}

app.http("issueTenantLink", { authLevel: "anonymous", handler: issueTenantLink, methods: ["POST"] });
