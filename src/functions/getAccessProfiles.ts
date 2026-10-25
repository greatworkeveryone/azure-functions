// GET /api/getAccessProfiles   (Admin → Users → "Access profile", S10)
//
// 200 { profiles: AccessProfileDto[] } for every active user: the stored
// profile, or the role's default with isDefault = true.
// Gate: ACCESS_MANAGE_ROLES (admin).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { listAccessProfiles, ACCESS_MANAGE_ROLES } from "../access/store";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";

export async function getAccessProfiles(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACCESS_MANAGE_ROLES);
  if (denied) return denied;

  let connection;
  try {
    connection = await createRequestConnection(token);
    return { status: 200, jsonBody: { profiles: await listAccessProfiles(connection) } };
  } catch (error: unknown) {
    context.error("getAccessProfiles failed:", error instanceof Error ? error.message : String(error));
    return errorResponse("Could not load access profiles", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getAccessProfiles", { methods: ["GET"], authLevel: "anonymous", handler: getAccessProfiles });
