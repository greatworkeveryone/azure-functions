import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { NOT_A_RECORD } from "../test-data";
import { sendActivityNotification } from "../teams/activity";
import { teamsAppId, teamsMode } from "../teams/config";
import { isSafeAppRoute } from "../teams/deepLink";

// ── POST /api/teamsTestAlert ─────────────────────────────────────────────────
// Body { userId, route? = "/dashboard" }. Admin only. Sends one Teams activity
// alert to that user through the real sender (WP63 Test 1) and returns its typed
// result. Respects TEAMS_ALERTS_ENABLED / _DRY_RUN; the response names the mode,
// so "off" reads as off rather than as a silent success.

export const TEAMS_TEST_USER_SQL = `SELECT UserID, EntraOid FROM dbo.AppUsers WHERE UserID = @UserID`;
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
  if (mode !== "off" && teamsAppId() === null) {
    return { status: 503, jsonBody: { error: "TEAMS_APP_ID is not set", mode } };
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
    const [row] = await executeQuery(connection, TEAMS_TEST_USER_SQL, [{ name: "UserID", type: TYPES.Int, value: userId }]);
    if (!row) return { status: 404, jsonBody: { error: "User not found" } };
    const oid = typeof row.EntraOid === "string" ? row.EntraOid.trim() : "";
    if (!oid) return { status: 400, jsonBody: { error: "This user has no Entra object id yet (never signed in)" } };

    const result = await sendActivityNotification(
      oid,
      { egress: NOT_A_RECORD, previewText: "Floorplan test alert", route, text: "Test alert from Floorplan. Tap to open." },
      { log: (message: string) => context.log(message) },
    );
    return { status: 200, jsonBody: { mode, result, route, userId } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("teamsTestAlert failed:", message);
    return errorResponse("Sending the Teams test alert failed", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("teamsTestAlert", { authLevel: "anonymous", handler: teamsTestAlert, methods: ["POST"] });
