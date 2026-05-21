import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { graphGetGroupUsers, type GraphUser } from "../graph";

const STAFF_ROLES = [
  AppRole.ADMIN,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
] as const;

export interface StaffMember {
  email: string;
  name: string;
}

/**
 * Maps GraphUser records to StaffMember, filtering out users without email,
 * sorted alphabetically by name.
 */
export function mapUsersToStaff(users: GraphUser[]): StaffMember[] {
  return users
    .filter((u) => u.mail)
    .map((u) => ({ email: u.mail!, name: u.displayName }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function getStaff(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = requireRole(request, STAFF_ROLES);
  if (roleCheck) return roleCheck;

  const groupId = process.env.PLANNER_GROUP_ID;
  if (!groupId) {
    context.error("getStaff: PLANNER_GROUP_ID not configured");
    return errorResponse("Staff directory not configured");
  }

  try {
    const users = await graphGetGroupUsers(groupId);
    const staff = mapUsersToStaff(users);

    return { status: 200, jsonBody: { staff } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("getStaff failed:", message);
    return errorResponse("Failed to fetch staff directory", message);
  }
}

app.http("getStaff", {
  authLevel: "anonymous",
  handler: getStaff,
  methods: ["GET"],
});
