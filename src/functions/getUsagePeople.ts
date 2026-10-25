// GET /api/getUsagePeople?days=7|30|90 (or from=YYYY-MM-DD&to=YYYY-MM-DD)
//
// Usage analytics, People view (PLAN §14): per person, sessions, active time, last active day, device
// classes, top modules and a calendar of active seconds. Reads only. Admin and directors
// (ACTION_ROLES.viewUsageAnalytics): the CFO is refused here and sees Finance usage instead.
//
// 200 { people, period }   400 a malformed period   401 / 403 role gate

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ACTION_ROLES } from "../action-roles";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { refuseUnlessAllScope } from "../usage/access";
import { parsePeriod } from "../usage/period";
import { loadUsagePeople } from "../usage/queries/people";

export async function getUsagePeople(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.viewUsageAnalytics.gate);
  if (denied) return denied;
  const refused = await refuseUnlessAllScope(request);
  if (refused) return refused;
  const parsed = parsePeriod(request.query);
  if ("error" in parsed) return { jsonBody: { error: parsed.error }, status: 400 };

  let connection;
  try {
    connection = await createRequestConnection(token);
    const people = await loadUsagePeople(connection, parsed.period, { moduleKeys: null, roles: null, userId: null });
    const { days, from, to } = parsed.period;
    return { headers: { "Cache-Control": "no-store" }, jsonBody: { people, period: { days, from, to } }, status: 200 };
  } catch (error: unknown) {
    context.error("getUsagePeople failed:", error instanceof Error ? error.message : String(error));
    return errorResponse("Could not load usage", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getUsagePeople", { authLevel: "anonymous", handler: getUsagePeople, methods: ["GET"] });
