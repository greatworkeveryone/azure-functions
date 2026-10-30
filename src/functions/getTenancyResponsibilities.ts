// GET /api/getTenancyResponsibilities?tenantId=N  (TR7, PLAN §15)
// A tenancy's "who maintains what" list, archived items last. Response: { items, tenantId }.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { authorize } from "../assetRegisterSupport";
import { refusal, runStaff } from "../tenantLinks/http";
import { readTenancy } from "../tenantLinks/store";
import { VIEW_RESPONSIBILITIES_ROLES, RESPONSIBILITIES_FLAG } from "../tenancyResponsibilities/roles";
import { listResponsibilities } from "../tenancyResponsibilities/store";

export async function getTenancyResponsibilities(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorize(request, VIEW_RESPONSIBILITIES_ROLES);
  if (!auth.ok) return auth.response;
  return runStaff(request, context, "getTenancyResponsibilities", auth.token, false, async ({ connection }) => {
    const tenantId = Number(request.query.get("tenantId"));
    if (!Number.isInteger(tenantId) || tenantId <= 0) return refusal(400, "tenantId must be a whole number");
    if (!(await readTenancy(connection, tenantId))) return refusal(404, "Tenancy not found");
    return { jsonBody: { items: await listResponsibilities(connection, tenantId), tenantId }, status: 200 };
  }, RESPONSIBILITIES_FLAG);
}

app.http("getTenancyResponsibilities", { authLevel: "anonymous", handler: getTenancyResponsibilities, methods: ["GET"] });
