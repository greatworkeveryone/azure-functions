// POST /api/saveOfficeClosure  (PLAN §15, Connor 31 Oct 2026)
// Body: { startsOn, endsOn, label, kind: "public_holiday" | "shutdown" } to add; add closureId and rowVersion to edit.
// Whole Darwin days, inclusive. A stale rowVersion is a 409. Ledgered. Response: { closure, created }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authorizeWrite } from "../assetRegisterSupport";
import { EDIT_OFFICE_CLOSURES_ROLES, parseClosureInput, saveClosure } from "../officeClosures/closures";
import { refusal, runStaff } from "../tenantLinks/http";

export async function saveOfficeClosure(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, EDIT_OFFICE_CLOSURES_ROLES);
  if (!auth.ok) return auth.response;
  return runStaff(
    request,
    context,
    "saveOfficeClosure",
    auth.token,
    true,
    async ({ actor, body, connection }) => {
      const parsed = parseClosureInput(body);
      if (!parsed.ok) return refusal(parsed.status, parsed.error);
      const result = await saveClosure(connection, { actor, caller: auth.caller.name, closure: parsed.value });
      return result.ok ? { jsonBody: result.value, status: 200 } : refusal(result.status, result.error);
    },
    null,
  );
}

app.http("saveOfficeClosure", { authLevel: "anonymous", handler: saveOfficeClosure, methods: ["POST"] });
