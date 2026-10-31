// GET /api/getAfterHours  (PLAN §15, Connor 31 Oct 2026)
// The after-hours phone number tenants are told to ring: the company number and each building's optional
// override. Response: { companyPhone, updatedAt, updatedBy, buildings: [{ buildingId, buildingName, phone }] }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authorize } from "../assetRegisterSupport";
import { EDIT_AFTER_HOURS_ROLES, readAfterHours } from "../orgSettings/afterHours";
import { runStaff } from "../tenantLinks/http";

export async function getAfterHours(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorize(request, EDIT_AFTER_HOURS_ROLES);
  if (!auth.ok) return auth.response;
  return runStaff(request, context, "getAfterHours", auth.token, false, async ({ connection }) => ({ jsonBody: await readAfterHours(connection), status: 200 }), null);
}

app.http("getAfterHours", { authLevel: "anonymous", handler: getAfterHours, methods: ["GET"] });
