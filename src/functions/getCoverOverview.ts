// GET /api/getCoverOverview
//
// The manager's "Covering" screen: who is away (reason, return date), what is waiting
// on them and what the engine would do with each item, and what has already moved and
// to whom. A manager sees their own team; the CFO and directors see more. Read-only,
// built from the live picture, so it is right while the engine is off or in dry run.
//
// 200 { away, suggested, moved, mode, inactivity, calendar, today }
// 401 / 403 role gate (viewAbsenceCover)

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { requireCoverCaller, coverErrorResponse } from "../absenceCover/access";
import { coverMode } from "../absenceCover/config";
import { buildOverview } from "../absenceCover/overview";
import { VIEW_COVER_ROLES } from "../absenceCover/roles";
import { loadLiveView } from "../absenceCover/view";
import { closeConnection, createRequestConnection } from "../db";

export async function getCoverOverview(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, VIEW_COVER_ROLES);
  if (denied) return denied;

  let connection;
  try {
    connection = await createRequestConnection(token);
    const caller = await requireCoverCaller(request, connection);
    const view = await loadLiveView(connection);
    return { headers: { "Cache-Control": "no-store" }, jsonBody: await buildOverview(connection, caller, view, coverMode()), status: 200 };
  } catch (error: unknown) {
    return coverErrorResponse(error, context, "getCoverOverview");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getCoverOverview", { methods: ["GET"], authLevel: "anonymous", handler: getCoverOverview });
