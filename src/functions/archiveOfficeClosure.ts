// POST /api/archiveOfficeClosure  (PLAN §15, Connor 31 Oct 2026)
// Body: { closureId, rowVersion }. Archives the closure (it stops counting); never deletes. Idempotent. Ledgered.
// Response: { closure }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authorizeWrite } from "../assetRegisterSupport";
import { archiveClosure, EDIT_OFFICE_CLOSURES_ROLES } from "../officeClosures/closures";
import { refusal, runStaff } from "../tenantLinks/http";

export async function archiveOfficeClosure(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, EDIT_OFFICE_CLOSURES_ROLES);
  if (!auth.ok) return auth.response;
  return runStaff(
    request,
    context,
    "archiveOfficeClosure",
    auth.token,
    true,
    async ({ actor, body, connection }) => {
      if (!Number.isInteger(body.closureId) || typeof body.rowVersion !== "string" || body.rowVersion === "") return refusal(400, "closureId and rowVersion are required");
      const result = await archiveClosure(connection, { actor, caller: auth.caller.name, closureId: body.closureId as number, rowVersion: body.rowVersion });
      return result.ok ? { jsonBody: { closure: result.value }, status: 200 } : refusal(result.status, result.error);
    },
    null,
  );
}

app.http("archiveOfficeClosure", { authLevel: "anonymous", handler: archiveOfficeClosure, methods: ["POST"] });
