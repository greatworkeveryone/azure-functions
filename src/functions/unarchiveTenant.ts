import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { setTenancyArchived } from "../tenancy-records";

// ── POST /api/unarchiveTenant ────────────────────────────────────────────────
// Body: { TenantId, Reason }. Puts an archived tenancy back in the register;
// clears ArchivedAt/By and ledgers tenancy.unarchive with the reason (D4).

export async function unarchiveTenant(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  return setTenancyArchived(request, context, false);
}

app.http("unarchiveTenant", { authLevel: "anonymous", handler: unarchiveTenant, methods: ["POST"] });
