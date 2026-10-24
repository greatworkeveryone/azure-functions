// GET /api/getMyHandback
//
// The handback for the signed-in person: what was moved to a cover while they were away
// (the last 30 days, not already taken back), which of it is still with the cover and
// which is finished, and whether they are back (`returned`). Their own rows only.
//
// 200 { returned, items }
//
// Gate: OWN_COVER_ROLES (the viewLeave capability): any signed-in staff member.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { coverErrorResponse, requireCoverCaller } from "../absenceCover/access";
import { buildHandback } from "../absenceCover/handback";
import { OWN_COVER_ROLES } from "../absenceCover/roles";
import { closeConnection, createRequestConnection } from "../db";

export async function getMyHandback(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, OWN_COVER_ROLES);
  if (denied) return denied;

  let connection;
  try {
    connection = await createRequestConnection(token);
    const caller = await requireCoverCaller(request, connection);
    return { headers: { "Cache-Control": "no-store" }, jsonBody: await buildHandback(connection, caller), status: 200 };
  } catch (error: unknown) {
    return coverErrorResponse(error, context, "getMyHandback");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getMyHandback", { methods: ["GET"], authLevel: "anonymous", handler: getMyHandback });
