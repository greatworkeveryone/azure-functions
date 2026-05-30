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
  requireRole,
  rolesForRequest,
  unauthorizedResponse,
  verifiedIdentityFromRequest,
} from "../auth";
import { checkRateLimit } from "../rateLimit";
import { Sentry } from "../sentry";

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

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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
// INSERT body: { email, displayName?, role?, isActive? }
// UPDATE body: { userId, role?, isActive? } — Email/DisplayName/EntraOid are
// immutable after the row exists; only Role and IsActive can change.

const MANAGE_USER_ROLES = [AppRole.ADMIN, AppRole.DIRECTOR] as const;
const VALID_ROLES = new Set(Object.values(AppRole));

interface UpsertAppUserBody {
  userId?: number;
  displayName?: string;
  email?: string;
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

  // Identity must come from the verified token — audit rows and self-edit
  // checks rely on a trusted OID, not an unverified body/header value.
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const callerOid = identity.oid;

  const rl = checkRateLimit(`upsertAppUser:${callerOid}`, { limit: 30, windowMs: 60_000 });
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  const callerRoles = await rolesForRequest(request);
  const callerIsAdmin = callerRoles.includes(AppRole.ADMIN);

  let connection;
  try {
    const body = (await request.json()) as UpsertAppUserBody;
    const { userId, role, isActive } = body ?? {};

    if (role !== undefined && role !== null) {
      if (!VALID_ROLES.has(role as AppRole)) {
        return { status: 400, jsonBody: { error: `Invalid role: ${role}` } };
      }
      if (role === AppRole.ADMIN && !callerIsAdmin) {
        return {
          status: 403,
          jsonBody: { error: "Only admins can assign the admin role" },
        };
      }
    }

    connection = await createServiceConnection();

    // Resolve caller display name for audit log.
    const callerRows = await executeQuery(
      connection,
      `SELECT DisplayName FROM dbo.AppUsers WHERE EntraOid = @Oid`,
      [{ name: "Oid", type: TYPES.NVarChar, value: callerOid }],
    );
    const callerDisplayName =
      (callerRows[0]?.DisplayName as string | undefined) ?? "Unknown";

    if (userId) {
      // UPDATE path — only Role and IsActive are mutable. Reject any request
      // that tries to rewrite Email/DisplayName/EntraOid post-creation.
      if (body.email !== undefined || body.displayName !== undefined) {
        return {
          status: 400,
          jsonBody: { error: "Email and displayName are immutable after creation" },
        };
      }

      const oldRows = await executeQuery(
        connection,
        `SELECT Role, Email, EntraOid FROM dbo.AppUsers WHERE UserID = @UserID`,
        [{ name: "UserID", type: TYPES.Int, value: userId }],
      );
      if (oldRows.length === 0) {
        return { status: 404, jsonBody: { error: "User not found" } };
      }
      const oldRole       = (oldRows[0].Role     as string | null | undefined) ?? null;
      const targetEmail   = (oldRows[0].Email    as string | undefined) ?? "";
      const targetOid     = (oldRows[0].EntraOid as string | null | undefined) ?? null;

      if (oldRole === AppRole.ADMIN && !callerIsAdmin) {
        return {
          status: 403,
          jsonBody: { error: "Only admins can edit admin users" },
        };
      }

      if (targetOid && targetOid === callerOid) {
        return { status: 403, jsonBody: { error: "Cannot edit your own account" } };
      }

      await executeQuery(
        connection,
        `UPDATE dbo.AppUsers
         SET Role     = @Role,
             IsActive = @IsActive
         WHERE UserID = @UserID`,
        [
          { name: "UserID",   type: TYPES.Int,      value: userId },
          { name: "Role",     type: TYPES.NVarChar, value: role ?? null },
          { name: "IsActive", type: TYPES.Bit,      value: isActive ?? true },
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
            { name: "ChangedByOid",         type: TYPES.NVarChar, value: callerOid },
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

    // INSERT path — pre-invite (no OID until the user logs in via registerSelf).
    const rawEmail = body.email;
    if (!rawEmail || !rawEmail.trim()) {
      return { status: 400, jsonBody: { error: "email is required" } };
    }
    const email = rawEmail.trim().toLowerCase();
    if (!EMAIL_REGEX.test(email)) {
      return { status: 400, jsonBody: { error: "invalid email" } };
    }

    const dupRows = await executeQuery(
      connection,
      `SELECT 1 AS Hit FROM dbo.AppUsers WHERE LOWER(Email) = @Email AND IsActive = 1`,
      [{ name: "Email", type: TYPES.NVarChar, value: email }],
    );
    if (dupRows.length > 0) {
      return { status: 409, jsonBody: { error: "email already in use" } };
    }

    const displayName = body.displayName?.trim() || email;

    const inserted = await executeQuery(
      connection,
      `INSERT INTO dbo.AppUsers (DisplayName, Email, EntraOid, Role, InvitedByOid, InvitedAt)
       OUTPUT INSERTED.UserID
       VALUES (@DisplayName, @Email, NULL, @Role, @InvitedByOid, SYSUTCDATETIME())`,
      [
        { name: "DisplayName",  type: TYPES.NVarChar, value: displayName },
        { name: "Email",        type: TYPES.NVarChar, value: email },
        { name: "Role",         type: TYPES.NVarChar, value: role ?? null },
        { name: "InvitedByOid", type: TYPES.NVarChar, value: callerOid },
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
          { name: "ChangedByOid",         type: TYPES.NVarChar, value: callerOid },
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
  // Pre-verification IP-based fallback so an attacker without a valid token
  // can't burn through user creates from a single host.
  const callerIp =
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-azure-clientip") ??
    "unknown";
  const ipRl = checkRateLimit(`registerSelf:ip:${callerIp}`, { limit: 5, windowMs: 60_000 });
  if (!ipRl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(ipRl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  // Verify the token signature before trusting any identity claim. This path
  // writes the EntraOid→role mapping via a service connection, so Azure SQL
  // never validates the caller's token for us — an unverified decode would let
  // a forged token claim a pre-invited row (privilege escalation).
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const { oid, name, email: rawEmail } = identity;

  // Per-OID limit prevents a single authenticated user from grinding the
  // endpoint past the IP gate (e.g. behind a shared egress).
  const oidRl = checkRateLimit(`registerSelf:oid:${oid}`, { limit: 5, windowMs: 60_000 });
  if (!oidRl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(oidRl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_REGEX.test(email)) {
    return { status: 400, jsonBody: { error: "invalid email" } };
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
        `UPDATE dbo.AppUsers SET Email = @Email WHERE UserID = @UserID`,
        [
          { name: "Email",  type: TYPES.NVarChar, value: email },
          { name: "UserID", type: TYPES.Int,      value: UserID },
        ],
      );
      return { status: 200, jsonBody: { userId: UserID, role: Role ?? null } };
    }

    // Step 2: pre-invited user matched by email (first login after admin invite).
    const byEmail = await executeQuery(
      connection,
      `SELECT UserID, Role, DisplayName FROM dbo.AppUsers
       WHERE LOWER(Email) = @Email AND EntraOid IS NULL AND IsActive = 1`,
      [{ name: "Email", type: TYPES.NVarChar, value: email }],
    );
    if (byEmail.length > 1) {
      Sentry.captureMessage("ambiguous pre-invite", {
        level: "error",
        extra: { email, count: byEmail.length },
      });
      return {
        status: 409,
        jsonBody: { error: "ambiguous pre-invite — contact admin" },
      };
    }
    if (byEmail.length === 1) {
      const { UserID, Role, DisplayName } = byEmail[0] as {
        UserID: number;
        Role: string | null;
        DisplayName: string | null;
      };
      const existingName = (DisplayName ?? "").trim();
      // Only adopt the token's display name when the pre-invite row didn't
      // carry one — never stomp an admin-typed name.
      if (existingName.length === 0) {
        await executeQuery(
          connection,
          `UPDATE dbo.AppUsers
           SET EntraOid = @Oid, DisplayName = @DisplayName
           WHERE UserID = @UserID`,
          [
            { name: "Oid",         type: TYPES.NVarChar, value: oid },
            { name: "DisplayName", type: TYPES.NVarChar, value: name },
            { name: "UserID",      type: TYPES.Int,      value: UserID },
          ],
        );
      } else {
        await executeQuery(
          connection,
          `UPDATE dbo.AppUsers SET EntraOid = @Oid WHERE UserID = @UserID`,
          [
            { name: "Oid",    type: TYPES.NVarChar, value: oid },
            { name: "UserID", type: TYPES.Int,      value: UserID },
          ],
        );
      }
      return { status: 200, jsonBody: { userId: UserID, role: Role ?? null } };
    }

    // Step 3: completely new user — create pending record (no role yet).
    const inserted = await executeQuery(
      connection,
      `INSERT INTO dbo.AppUsers (DisplayName, Email, EntraOid)
       OUTPUT INSERTED.UserID
       VALUES (@DisplayName, @Email, @Oid)`,
      [
        { name: "DisplayName", type: TYPES.NVarChar, value: name },
        { name: "Email",       type: TYPES.NVarChar, value: email },
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
