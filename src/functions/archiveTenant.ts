import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { setTenancyArchived } from "../tenancy-records";

// ── POST /api/archiveTenant ──────────────────────────────────────────────────
// Body: { TenantId, Reason }. Takes a tenancy out of the register, counts and
// exports without destroying anything (D4, DL-04): stamps ArchivedAt/By and
// ledgers tenancy.archive with the reason. unarchiveTenant reverses it.

export async function archiveTenant(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return setTenancyArchived(request, context, true);
}

app.http("archiveTenant", { authLevel: "anonymous", handler: archiveTenant, methods: ["POST"] });
