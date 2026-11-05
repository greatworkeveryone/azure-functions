// GET /api/getAiCost?days=7|30|90 (or from=YYYY-MM-DD&to=YYYY-MM-DD)
//
// What the AI server cost in Azure over the period, by day and by meter category, asked of toddler (which reads
// Azure Cost Management in the GWE subscription). Admin and directors (ACTION_ROLES.viewUsageAnalytics), as the
// AI usage view it sits beside; the CFO is refused here too.
//
// 200 { available: true, … } or { available: false, reason }   400 a malformed period   401 / 403 role gate

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ACTION_ROLES } from "../action-roles";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { refuseUnlessAllScope } from "../usage/access";
import { fetchAiCost } from "../usage/aiCost";
import { parsePeriod } from "../usage/period";

export async function getAiCost(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.viewUsageAnalytics.gate);
  if (denied) return denied;
  const refused = await refuseUnlessAllScope(request);
  if (refused) return refused;
  const parsed = parsePeriod(request.query);
  if ("error" in parsed) return { jsonBody: { error: parsed.error }, status: 400 };

  try {
    return { headers: { "Cache-Control": "no-store" }, jsonBody: await fetchAiCost(parsed.period), status: 200 };
  } catch (error: unknown) {
    // Only a misconfigured TODDLER_URL (not https) gets here.
    context.error("getAiCost failed:", error instanceof Error ? error.message : String(error));
    return errorResponse("Could not load the AI cost", error);
  }
}

app.http("getAiCost", { authLevel: "anonymous", handler: getAiCost, methods: ["GET"] });
