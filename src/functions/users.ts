import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  closeConnection,
  createConnection,
  createServiceConnection,
  executeQuery,
} from "../db";
import {
  AppRole,
  errorResponse,
  extractToken,
  oidFromToken,
  requireRole,
  rolesForRequest,
  unauthorizedResponse,
  userInfoFromToken,
} from "../auth";

// ── GET /api/getAppUsers ──────────────────────────────────────────────────────
// Returns all active users. Used to populate assignment dropdowns.
// Requires any authenticated caller.

const VIEW_USERS_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
] as const;

export async function getAppUsers(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, VIEW_USERS_ROLES);
  if (roleCheck) return roleCheck;

  const callerRoles = await rolesForRequest(request);
  const canManage =
    callerRoles.includes(AppRole.ADMIN) || callerRoles.includes(AppRole.DIRECTOR);

  let connection;
  try {
    connection = await createConnection(token);

    const rows = canManage
      ? await executeQuery(
          connection,
          `SELECT UserID, DisplayName, Email, Role, InvitedAt,
                  CASE WHEN EntraOid IS NULL THEN 'pending' ELSE 'active' END AS Status
           FROM dbo.AppUsers
           WHERE IsActive = 1
           ORDER BY Status DESC, DisplayName ASC`,
        )
      : await executeQuery(
          connection,
          `SELECT UserID, DisplayName, Email, Role
           FROM dbo.AppUsers
           WHERE IsActive = 1 AND EntraOid IS NOT NULL
           ORDER BY DisplayName ASC`,
        );

    return {
      status: 200,
      jsonBody: {
        users: rows.map((r) => ({
          id: r.UserID as number,
          displayName: r.DisplayName as string,
          email: r.Email as string,
          role: (r.Role as string | null) ?? null,
          status: canManage ? (r.Status as "active" | "pending") : "active",
          invitedAt: canManage ? ((r.InvitedAt as string | null) ?? null) : null,
        })),
      },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("getAppUsers failed:", message);
    return errorResponse("Failed to fetch users", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertAppUser ───────────────────────────────────────────────────
// Create or update an AppUser. Admin or Director.
// Body: { userId?, displayName?, email, entraOid?, role?, isActive? }

const MANAGE_USER_ROLES = [AppRole.ADMIN, AppRole.DIRECTOR] as const;
const VALID_ROLES = new Set(Object.values(AppRole));

interface UpsertAppUserBody {
  userId?: number;
  displayName?: string;
  email: string;
  entraOid?: string | null;
  role?: string | null;
  isActive?: boolean;
}

export async function upsertAppUser(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, MANAGE_USER_ROLES);
  if (roleCheck) return roleCheck;

  const callerRoles = await rolesForRequest(request);
  const callerOid   = oidFromToken(token);

  let connection;
  try {
    const body = (await request.json()) as UpsertAppUserBody;
    const { userId, email, entraOid, role, isActive } = body ?? {};
    const displayName = body.displayName?.trim() || email;

    if (!email?.trim()) {
      return { status: 400, jsonBody: { error: "email is required" } };
    }

    if (role !== undefined && role !== null) {
      if (!VALID_ROLES.has(role as AppRole)) {
        return { status: 400, jsonBody: { error: `Invalid role: ${role}` } };
      }
      if (role === AppRole.ADMIN && !callerRoles.includes(AppRole.ADMIN)) {
        return {
          status: 403,
          jsonBody: { error: "Only admins can assign the admin role" },
        };
      }
    }

    connection = await createServiceConnection();

    // Resolve caller display name for audit log.
    const callerRows = callerOid
      ? await executeQuery(
          connection,
          `SELECT DisplayName FROM dbo.AppUsers WHERE EntraOid = @Oid`,
          [{ name: "Oid", type: TYPES.NVarChar, value: callerOid }],
        )
      : [];
    const callerDisplayName =
      (callerRows[0]?.DisplayName as string | undefined) ?? "Unknown";

    if (userId) {
      // Fetch old role before overwriting (for audit log).
      const oldRows = await executeQuery(
        connection,
        `SELECT Role, Email FROM dbo.AppUsers WHERE UserID = @UserID`,
        [{ name: "UserID", type: TYPES.Int, value: userId }],
      );
      const oldRole     = (oldRows[0]?.Role  as string | null | undefined) ?? null;
      const targetEmail = (oldRows[0]?.Email as string | undefined) ?? email;

      await executeQuery(
        connection,
        `UPDATE dbo.AppUsers
         SET DisplayName = @DisplayName,
             Email       = @Email,
             EntraOid    = COALESCE(@EntraOid, EntraOid),
             Role        = @Role,
             IsActive    = @IsActive
         WHERE UserID = @UserID`,
        [
          { name: "UserID",      type: TYPES.Int,      value: userId },
          { name: "DisplayName", type: TYPES.NVarChar,  value: displayName },
          { name: "Email",       type: TYPES.NVarChar,  value: email },
          { name: "EntraOid",    type: TYPES.NVarChar,  value: entraOid ?? null },
          { name: "Role",        type: TYPES.NVarChar,  value: role ?? null },
          { name: "IsActive",    type: TYPES.Bit,       value: isActive ?? true },
        ],
      );

      // Write audit row only if role actually changed.
      if (role !== undefined && role !== oldRole) {
        await executeQuery(
          connection,
          `INSERT INTO dbo.UserRoleAudit
             (ChangedByOid, ChangedByDisplayName, TargetUserID, TargetEmail, OldRole, NewRole)
           VALUES
             (@ChangedByOid, @ChangedByDisplayName, @TargetUserID, @TargetEmail, @OldRole, @NewRole)`,
          [
            { name: "ChangedByOid",         type: TYPES.NVarChar, value: callerOid ?? "unknown" },
            { name: "ChangedByDisplayName",  type: TYPES.NVarChar, value: callerDisplayName },
            { name: "TargetUserID",          type: TYPES.Int,      value: userId },
            { name: "TargetEmail",           type: TYPES.NVarChar, value: targetEmail },
            { name: "OldRole",               type: TYPES.NVarChar, value: oldRole },
            { name: "NewRole",               type: TYPES.NVarChar, value: role ?? null },
          ],
        );
      }

      return { status: 200, jsonBody: { userId } };
    }

    // New user — pre-invite (no OID required).
    const inserted = await executeQuery(
      connection,
      `INSERT INTO dbo.AppUsers (DisplayName, Email, EntraOid, Role, InvitedByOid, InvitedAt)
       OUTPUT INSERTED.UserID
       VALUES (@DisplayName, @Email, @EntraOid, @Role, @InvitedByOid, SYSUTCDATETIME())`,
      [
        { name: "DisplayName",  type: TYPES.NVarChar, value: displayName },
        { name: "Email",        type: TYPES.NVarChar, value: email },
        { name: "EntraOid",     type: TYPES.NVarChar, value: entraOid ?? null },
        { name: "Role",         type: TYPES.NVarChar, value: role ?? null },
        { name: "InvitedByOid", type: TYPES.NVarChar, value: callerOid ?? null },
      ],
    );
    const newUserId = inserted[0].UserID as number;

    // Audit log for the initial role assignment.
    if (role) {
      await executeQuery(
        connection,
        `INSERT INTO dbo.UserRoleAudit
           (ChangedByOid, ChangedByDisplayName, TargetUserID, TargetEmail, OldRole, NewRole)
         VALUES
           (@ChangedByOid, @ChangedByDisplayName, @TargetUserID, @TargetEmail, NULL, @NewRole)`,
        [
          { name: "ChangedByOid",         type: TYPES.NVarChar, value: callerOid ?? "unknown" },
          { name: "ChangedByDisplayName",  type: TYPES.NVarChar, value: callerDisplayName },
          { name: "TargetUserID",          type: TYPES.Int,      value: newUserId },
          { name: "TargetEmail",           type: TYPES.NVarChar, value: email },
          { name: "NewRole",               type: TYPES.NVarChar, value: role },
        ],
      );
    }

    return { status: 201, jsonBody: { userId: newUserId } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("upsertAppUser failed:", message);
    return errorResponse("Failed to upsert user", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/registerSelf ────────────────────────────────────────────────────
// Registers / syncs the caller into AppUsers.
// No role required — any authenticated user can call this.
// Three-way lookup: OID match → email match (pre-invite) → new pending user.

export async function registerSelf(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const appToken = request.headers.get("x-app-token");
  if (!appToken) return unauthorizedResponse();

  const oid  = oidFromToken(token);
  const info = userInfoFromToken(appToken);

  if (!oid || !info) {
    return { status: 400, jsonBody: { error: "Could not extract identity from token" } };
  }

  let connection;
  try {
    connection = await createServiceConnection();

    // Step 1: existing user matched by OID (returning user).
    const byOid = await executeQuery(
      connection,
      `SELECT UserID, Role FROM dbo.AppUsers WHERE EntraOid = @Oid AND IsActive = 1`,
      [{ name: "Oid", type: TYPES.NVarChar, value: oid }],
    );
    if (byOid.length > 0) {
      const { UserID, Role } = byOid[0] as { UserID: number; Role: string | null };
      await executeQuery(
        connection,
        `UPDATE dbo.AppUsers SET DisplayName = @DisplayName, Email = @Email WHERE UserID = @UserID`,
        [
          { name: "DisplayName", type: TYPES.NVarChar, value: info.name },
          { name: "Email",       type: TYPES.NVarChar, value: info.email },
          { name: "UserID",      type: TYPES.Int,      value: UserID },
        ],
      );
      return { status: 200, jsonBody: { userId: UserID, role: Role ?? null } };
    }

    // Step 2: pre-invited user matched by email (first login after admin invite).
    const byEmail = await executeQuery(
      connection,
      `SELECT UserID, Role FROM dbo.AppUsers
       WHERE Email = @Email AND EntraOid IS NULL AND IsActive = 1`,
      [{ name: "Email", type: TYPES.NVarChar, value: info.email }],
    );
    if (byEmail.length > 0) {
      const { UserID, Role } = byEmail[0] as { UserID: number; Role: string | null };
      await executeQuery(
        connection,
        `UPDATE dbo.AppUsers
         SET EntraOid = @Oid, DisplayName = @DisplayName
         WHERE UserID = @UserID`,
        [
          { name: "Oid",         type: TYPES.NVarChar, value: oid },
          { name: "DisplayName", type: TYPES.NVarChar, value: info.name },
          { name: "UserID",      type: TYPES.Int,      value: UserID },
        ],
      );
      return { status: 200, jsonBody: { userId: UserID, role: Role ?? null } };
    }

    // Step 3: completely new user — create pending record (no role yet).
    const inserted = await executeQuery(
      connection,
      `INSERT INTO dbo.AppUsers (DisplayName, Email, EntraOid)
       OUTPUT INSERTED.UserID
       VALUES (@DisplayName, @Email, @Oid)`,
      [
        { name: "DisplayName", type: TYPES.NVarChar, value: info.name },
        { name: "Email",       type: TYPES.NVarChar, value: info.email },
        { name: "Oid",         type: TYPES.NVarChar, value: oid },
      ],
    );
    return {
      status: 200,
      jsonBody: { userId: inserted[0].UserID as number, role: null },
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("registerSelf failed:", message);
    return errorResponse("Failed to register user", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getAppUsers",   { methods: ["GET"],  authLevel: "anonymous", handler: getAppUsers });
app.http("upsertAppUser", { methods: ["POST"], authLevel: "anonymous", handler: upsertAppUser });
app.http("registerSelf",  { methods: ["POST"], authLevel: "anonymous", handler: registerSelf });
