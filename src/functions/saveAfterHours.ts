// POST /api/saveAfterHours  (PLAN §15, Connor 31 Oct 2026)
// Body: { phone: string | null, buildingId?: number }. Without buildingId it sets the company number; with it,
// that building's override ("After-hours line for this building"). null or "" clears. An Australian phone number
// only (spaces allowed). Ledgered with the old and new value (settings.after_hours_set).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authorizeWrite } from "../assetRegisterSupport";
import { EDIT_AFTER_HOURS_ROLES, saveAfterHours as save } from "../orgSettings/afterHours";
import { positiveId } from "../tenantLinks/contacts";
import { refusal, runStaff } from "../tenantLinks/http";

export async function saveAfterHours(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, EDIT_AFTER_HOURS_ROLES);
  if (!auth.ok) return auth.response;
  return runStaff(
    request,
    context,
    "saveAfterHours",
    auth.token,
    true,
    async ({ actor, body, connection }) => {
      let buildingId: number | null = null;
      if (body.buildingId !== undefined && body.buildingId !== null) {
        buildingId = positiveId(body.buildingId);
        if (buildingId === null) return refusal(400, "buildingId must be a whole number");
      }
      if (!("phone" in body)) return refusal(400, "phone is required (use null to clear it)");
      const result = await save(connection, { actor, buildingId, phone: body.phone });
      return result.ok ? { jsonBody: { saved: true }, status: 200 } : refusal(result.status, result.error);
    },
    null,
  );
}

app.http("saveAfterHours", { authLevel: "anonymous", handler: saveAfterHours, methods: ["POST"] });
