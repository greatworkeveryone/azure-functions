// GET /api/getUsageFinance?days=7|30|90 (or from&to)[&userId][&role]
//
// Usage analytics, Finance usage view (PLAN §14): the CFO's view. Her team's use of Floorplan
// (accounts, accounts_manager, cfo and admin people, time in finance pages only), money decisions
// and MYOB calls by operation, outcome and person. The scope is decided here, on the server: the CFO
// gets this view and no other, and a userId or role that names someone outside it is refused (403),
// not quietly widened. Admin and directors may read it too (gate viewFinanceUsageAnalytics).
//
// 200 the view   400 malformed filters   401 / 403 role gate or out of scope

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ACTION_ROLES } from "../action-roles";
import { AppRole, errorResponse, extractToken, forbiddenResponse, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { usageScopeOf } from "../usage/access";
import { parsePeriod } from "../usage/period";
import { loadUsageFinance, roleOfUser } from "../usage/queries/finance";
import { isFinanceUserRole } from "../usage/scope";

const ROLE_NAMES: readonly string[] = Object.values(AppRole);

export async function getUsageFinance(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.viewFinanceUsageAnalytics.gate);
  if (denied) return denied;
  const access = await usageScopeOf(request);
  if ("response" in access) return access.response;
  const parsed = parsePeriod(request.query);
  if ("error" in parsed) return { jsonBody: { error: parsed.error }, status: 400 };

  const role = request.query.get("role")?.trim().toLowerCase() || null;
  if (role !== null && !ROLE_NAMES.includes(role)) return { jsonBody: { error: "role is not a role" }, status: 400 };
  const userText = request.query.get("userId")?.trim();
  const userId = userText ? Number(userText) : null;
  if (userId !== null && (!Number.isInteger(userId) || userId < 1)) return { jsonBody: { error: "userId must be a positive whole number" }, status: 400 };
  const outOfScope = forbiddenResponse("The finance view covers accounts, accounts manager, CFO and admin people only.");
  if (access.scope === "finance" && role !== null && !isFinanceUserRole(role)) return outOfScope;

  let connection;
  try {
    connection = await createRequestConnection(token);
    if (access.scope === "finance" && userId !== null && !isFinanceUserRole(await roleOfUser(connection, userId))) return outOfScope;
    const view = await loadUsageFinance(connection, parsed.period, { role, scope: access.scope, userId });
    return { headers: { "Cache-Control": "no-store" }, jsonBody: view, status: 200 };
  } catch (error: unknown) {
    context.error("getUsageFinance failed:", error instanceof Error ? error.message : String(error));
    return errorResponse("Could not load usage", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getUsageFinance", { authLevel: "anonymous", handler: getUsageFinance, methods: ["GET"] });
