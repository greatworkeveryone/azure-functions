// GET /api/getUsageStatus
//
// Tells the browser whether usage is being recorded. 200 { trackingEnabled }. Any signed-in role
// (the beacon runs for everyone the usageAnalytics flag is enabled for). When it says false the
// browser sends nothing at all.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { usageTrackingOn } from "../usage/config";

export async function getUsageStatus(request: HttpRequest, _context: InvocationContext): Promise<HttpResponseInit> {
  if (!extractToken(request)) return unauthorizedResponse();
  const denied = await requireRole(request, [AppRole.USER]);
  if (denied) return denied;
  return { headers: { "Cache-Control": "no-store" }, jsonBody: { trackingEnabled: usageTrackingOn() }, status: 200 };
}

app.http("getUsageStatus", { authLevel: "anonymous", handler: getUsageStatus, methods: ["GET"] });
