// GET /api/tenantPhotoOrphans  (staff: Settings and rollout, viewAdmin)
// Read-only list of tenant photo uploads that never finished (tenantPage/orphans.ts). Deletes nothing.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { ACTION_ROLES } from "../action-roles";
import { errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { orphanPhotoReport } from "../tenantPage/orphans";

export async function tenantPhotoOrphans(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, ACTION_ROLES.viewAdmin.gate);
  if (denied) return denied;
  let connection;
  try {
    connection = await createRequestConnection(token);
    return { jsonBody: { photos: await orphanPhotoReport(connection) }, status: 200 };
  } catch (error: any) {
    context.error("tenantPhotoOrphans failed:", error.message);
    return errorResponse("Photo report failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("tenantPhotoOrphans", { authLevel: "anonymous", handler: tenantPhotoOrphans, methods: ["GET"] });
