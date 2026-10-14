// GET /api/getAccessEvents   (Admin → "Recent sign-ins and anomalies", S10)
//
//   days           1–30, default 7
//   userId         one person (AppUsers.UserID)
//   anomaliesOnly  true | false (default false)
//
// 200 { events: AccessEventDto[], limit } newest first, at most `limit` rows.
// Gate: ACCESS_VIEW_ROLES (CFO; directors and admin through the hierarchy).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { listAccessEvents, ACCESS_VIEW_ROLES, MAX_DAYS, MAX_EVENT_ROWS } from "../access/store";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";

function readFilter(request: HttpRequest): { anomaliesOnly: boolean; days: number; userId: number | null } | string {
  const q = request.query;
  const daysText = q.get("days")?.trim();
  const days = daysText ? Number(daysText) : 7;
  if (!Number.isInteger(days) || days < 1 || days > MAX_DAYS) return `days must be a whole number from 1 to ${MAX_DAYS}`;
  const userText = q.get("userId")?.trim();
  const userId = userText ? Number(userText) : null;
  if (userId !== null && (!Number.isInteger(userId) || userId < 1)) return "userId must be a positive whole number";
  const anomaliesText = q.get("anomaliesOnly")?.trim();
  if (anomaliesText && anomaliesText !== "true" && anomaliesText !== "false") return "anomaliesOnly must be true or false";
  return { anomaliesOnly: anomaliesText === "true", days, userId };
}

export async function getAccessEvents(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACCESS_VIEW_ROLES);
  if (denied) return denied;

  const filter = readFilter(request);
  if (typeof filter === "string") return { status: 400, jsonBody: { error: filter } };

  let connection;
  try {
    connection = await createRequestConnection(token);
    const events = await listAccessEvents(connection, filter);
    return { status: 200, jsonBody: { events, limit: MAX_EVENT_ROWS } };
  } catch (error: unknown) {
    context.error("getAccessEvents failed:", error instanceof Error ? error.message : String(error));
    return errorResponse("Could not load access events", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getAccessEvents", { methods: ["GET"], authLevel: "anonymous", handler: getAccessEvents });
