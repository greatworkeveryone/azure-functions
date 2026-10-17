import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { setTenancyArchived, TENANCY_ARCHIVE_ROLES } from "../tenancy-records";

// ── POST /api/unarchiveTenant ────────────────────────────────────────────────
// Body: { TenantId, Reason }. Puts an archived tenancy back in the register;
// clears ArchivedAt/By and ledgers tenancy.unarchive with the reason (D4).

export async function unarchiveTenant(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, TENANCY_ARCHIVE_ROLES);
  if (denied) return denied;
  return setTenancyArchived(request, context, token, false);
}

app.http("unarchiveTenant", { authLevel: "anonymous", handler: unarchiveTenant, methods: ["POST"] });
