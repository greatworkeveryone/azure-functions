import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { setTenancyPartArchived, TENANCY_PART_ARCHIVE_ROLES } from "../tenancy-parts-archive";

// ── POST /api/archiveOccupancy, unarchiveOccupancy, archiveCarpark, unarchiveCarpark
// Body { OccupancyId | CarparkId, Reason }. Replace the hard deleteOccupancy and
// deleteCarpark (D10): the area or bay leaves the register, figures and planner,
// stays on file, and can be restored. Each is ledgered with its reason.

export async function archiveOccupancy(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, TENANCY_PART_ARCHIVE_ROLES);
  if (denied) return denied;
  return setTenancyPartArchived(request, context, token, "occupancy", true);
}

export async function unarchiveOccupancy(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, TENANCY_PART_ARCHIVE_ROLES);
  if (denied) return denied;
  return setTenancyPartArchived(request, context, token, "occupancy", false);
}

export async function archiveCarpark(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, TENANCY_PART_ARCHIVE_ROLES);
  if (denied) return denied;
  return setTenancyPartArchived(request, context, token, "carpark", true);
}

export async function unarchiveCarpark(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const denied = await requireRole(request, TENANCY_PART_ARCHIVE_ROLES);
  if (denied) return denied;
  return setTenancyPartArchived(request, context, token, "carpark", false);
}

app.http("archiveOccupancy", { authLevel: "anonymous", handler: archiveOccupancy, methods: ["POST"] });
app.http("unarchiveOccupancy", { authLevel: "anonymous", handler: unarchiveOccupancy, methods: ["POST"] });
app.http("archiveCarpark", { authLevel: "anonymous", handler: archiveCarpark, methods: ["POST"] });
app.http("unarchiveCarpark", { authLevel: "anonymous", handler: unarchiveCarpark, methods: ["POST"] });
