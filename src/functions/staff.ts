import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, errorResponse, extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { graphGetGroupUsers, type GraphUser } from "../graph";

const STAFF_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
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
 * deduping by email (case-insensitive), and sorting alphabetically by name.
 */
export function mapUsersToStaff(users: GraphUser[]): StaffMember[] {
  const seen = new Set<string>();
  const staff: StaffMember[] = [];
  for (const u of users) {
    if (!u.mail) continue;
    const key = u.mail.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    staff.push({ email: u.mail, name: u.displayName });
  }
  return staff.sort((a, b) => a.name.localeCompare(b.name));
}

// The Planner groups are the legacy directory. Where they are not configured
// (staging, and production once Planner is retired) the app's own user table
// is the staff list: active people who have signed in and hold a role.
async function staffFromAppUsers(token: string): Promise<StaffMember[]> {
  const connection = await createRequestConnection(token);
  try {
    const rows = await executeQuery(
      connection,
      `SELECT DisplayName, Email FROM dbo.AppUsers
       WHERE IsActive = 1 AND EntraOid IS NOT NULL AND Role IS NOT NULL`,
    );
    return mapUsersToStaff(
      rows.map((row) => ({ displayName: String(row.DisplayName), id: "", mail: String(row.Email), mobilePhone: null })),
    );
  } finally {
    closeConnection(connection);
  }
}

async function staffFromPlannerGroups(facilitiesGroupId: string, accountsGroupId: string): Promise<StaffMember[]> {
  const [facilities, accounts] = await Promise.all([
    graphGetGroupUsers(facilitiesGroupId),
    graphGetGroupUsers(accountsGroupId),
  ]);
  return mapUsersToStaff([...facilities, ...accounts]);
}

export async function getStaff(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, STAFF_ROLES);
  if (roleCheck) return roleCheck;

  const facilitiesGroupId = process.env.PLANNER_FACILITIES_GROUP_ID;
  const accountsGroupId = process.env.PLANNER_ACCOUNTS_GROUP_ID;

  try {
    const staff =
      facilitiesGroupId && accountsGroupId
        ? await staffFromPlannerGroups(facilitiesGroupId, accountsGroupId)
        : await staffFromAppUsers(token);
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
