// GET /api/getUsageDevices?days=7|30|90 (or from=YYYY-MM-DD&to=YYYY-MM-DD)
//
// Usage analytics, Devices view (PLAN §14). Reads only; counts and times, never what a person typed or
// the content of a page. Admin and directors (ACTION_ROLES.viewUsageAnalytics): the CFO is refused
// here whatever the gate says and sees Finance usage instead.
//
// 200 the view   400 a malformed period   401 / 403 role gate

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ACTION_ROLES } from "../action-roles";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { refuseUnlessAllScope } from "../usage/access";
import { parsePeriod } from "../usage/period";
import { loadUsageDevices } from "../usage/queries/devices";

export async function getUsageDevices(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    return { headers: { "Cache-Control": "no-store" }, jsonBody: await loadUsageDevices(connection, parsed.period), status: 200 };
  } catch (error: unknown) {
    context.error("getUsageDevices failed:", error instanceof Error ? error.message : String(error));
    return errorResponse("Could not load usage", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getUsageDevices", { authLevel: "anonymous", handler: getUsageDevices, methods: ["GET"] });
