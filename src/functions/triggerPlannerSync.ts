import { app, type HttpRequest, type HttpResponseInit, type InvocationContext, type Timer } from "@azure/functions";
import { AppRole, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { PLANNER_SYNC_DISABLED_MESSAGE, plannerSyncEnabled } from "../plannerFlag";
import { plannerSyncTimer } from "./plannerSyncTimer";

const TRIGGER_ROLES = [AppRole.ADMIN, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS_APPROVAL] as const;

async function triggerPlannerSync(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, TRIGGER_ROLES);
  if (roleCheck) return roleCheck;

  // Checked after the role check so only an authorised caller can learn the
  // switch is off. `ranAt` is when the request was handled, kept so callers that
  // read it still work; `skipped` says the sync itself did not run.
  if (!plannerSyncEnabled()) {
    return {
      status: 200,
      jsonBody: { ranAt: new Date().toISOString(), skipped: true, message: PLANNER_SYNC_DISABLED_MESSAGE },
    };
  }

  await plannerSyncTimer({} as Timer, context);
  return { status: 200, jsonBody: { ranAt: new Date().toISOString() } };
}

app.http("triggerPlannerSync", { methods: ["POST"], authLevel: "anonymous", handler: triggerPlannerSync });
