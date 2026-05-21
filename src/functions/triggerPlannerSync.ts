import { app, type HttpRequest, type HttpResponseInit, type InvocationContext, type Timer } from "@azure/functions";
import { AppRole, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { plannerSyncTimer } from "./plannerSyncTimer";

const TRIGGER_ROLES = [AppRole.ADMIN, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS_APPROVAL] as const;

async function triggerPlannerSync(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, TRIGGER_ROLES);
  if (roleCheck) return roleCheck;

  await plannerSyncTimer({} as Timer, context);
  return { status: 200, jsonBody: { ranAt: new Date().toISOString() } };
}

app.http("triggerPlannerSync", { methods: ["POST"], authLevel: "anonymous", handler: triggerPlannerSync });
