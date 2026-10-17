import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { setTenancyArchived, TENANCY_ARCHIVE_ROLES } from "../tenancy-records";

// ── POST /api/archiveTenant ──────────────────────────────────────────────────
// Body: { TenantId, Reason }. Takes a tenancy out of the register, counts and
// exports without destroying anything (D4, DL-04): stamps ArchivedAt/By and
// ledgers tenancy.archive with the reason. unarchiveTenant reverses it.

export async function archiveTenant(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, TENANCY_ARCHIVE_ROLES);
  if (denied) return denied;
  return setTenancyArchived(request, context, token, true);
}

app.http("archiveTenant", { authLevel: "anonymous", handler: archiveTenant, methods: ["POST"] });
