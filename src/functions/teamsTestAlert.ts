import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { workflowsChannel, type AlertResult } from "../alerts/channel";
import { claimWorkflowsSlot } from "../alerts/rateCap";
import { isFeatureEnabledForRoles } from "../features/flags";
import { NOT_A_RECORD } from "../test-data";
import { sendActivityNotification } from "../teams/activity";
import { teamsAlertsRoute, teamsAppId, teamsMode, workflowConfig } from "../teams/config";
import { isSafeAppRoute } from "../teams/deepLink";

// ── POST /api/teamsTestAlert ─────────────────────────────────────────────────
// Body { userId, route? = "/dashboard" }. Admin only. Sends one alert to that user through
// the configured route (TEAMS_ALERTS_ROUTE): the Workflows flow (needs the user's email and
// counts against the rate cap) or the Teams activity feed (WP63 Test 1, needs their Entra id).
// Returns the typed result. Respects TEAMS_ALERTS_ENABLED / _DRY_RUN; the response names the
// mode, so "off" reads as off. `alertsRoute` and `flagEnabled` (teamsAlerts for the user's
// role) are reported, not enforced: an admin test works with the flag off.

export const TEAMS_TEST_USER_SQL = `SELECT UserID, EntraOid, Email, Role FROM dbo.AppUsers WHERE UserID = @UserID`;
const DEFAULT_ROUTE = "/dashboard";

interface TeamsTestAlertBody {
  route?: unknown;
  userId?: unknown;
}

export async function teamsTestAlert(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, [AppRole.ADMIN]);
  if (denied) return denied;

  const body = (await request.json().catch(() => null)) as TeamsTestAlertBody | null;
  const userId = body?.userId;
  const route = body?.route ?? DEFAULT_ROUTE;
  if (typeof userId !== "number" || !Number.isSafeInteger(userId) || userId <= 0) {
    return { status: 400, jsonBody: { error: "userId (positive integer) required" } };
  }
  if (!isSafeAppRoute(route)) return { status: 400, jsonBody: { error: "route must be an in-app path on the Teams allow-list" } };

  const mode = teamsMode();
  const alertsRoute = teamsAlertsRoute();
  if (mode !== "off" && alertsRoute === "app" && teamsAppId() === null) {
    return { status: 503, jsonBody: { error: "TEAMS_APP_ID is not set", mode } };
  }
  if (mode === "live" && alertsRoute === "workflows" && workflowConfig() === null) {
    return { status: 503, jsonBody: { error: "TEAMS_WORKFLOW_WEBHOOK_URL / TEAMS_WORKFLOW_KEY is not set", mode } };
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
    const [row] = await executeQuery(connection, TEAMS_TEST_USER_SQL, [{ name: "UserID", type: TYPES.Int, value: userId }]);
    if (!row) return { status: 404, jsonBody: { error: "User not found" } };
    const flagEnabled = await isFeatureEnabledForRoles("teamsAlerts", [String(row.Role ?? "")], { connection });
    const log = (message: string): void => context.log(message);
    const text = { previewText: "Floorplan test alert", text: "Test alert from Floorplan. Tap to open." };

    if (alertsRoute === "workflows") {
      const email = typeof row.Email === "string" ? row.Email.trim() : "";
      if (!email) return { status: 400, jsonBody: { error: "This user has no email address" } };
      const conn = connection;
      const result: AlertResult = await workflowsChannel({ claimSlot: () => claimWorkflowsSlot(conn), log }).send(
        { email, entraOid: null },
        { egress: NOT_A_RECORD, kind: "escalation", route, ...text },
      );
      return { status: 200, jsonBody: { alertsRoute, flagEnabled, mode, result, route, userId } };
    }

    const oid = typeof row.EntraOid === "string" ? row.EntraOid.trim() : "";
    if (!oid) return { status: 400, jsonBody: { error: "This user has no Entra object id yet (never signed in)" } };

    const result = await sendActivityNotification(oid, { egress: NOT_A_RECORD, route, ...text }, { log });
    return { status: 200, jsonBody: { alertsRoute, flagEnabled, mode, result, route, userId } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("teamsTestAlert failed:", message);
    return errorResponse("Sending the Teams test alert failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("teamsTestAlert", { authLevel: "anonymous", handler: teamsTestAlert, methods: ["POST"] });
