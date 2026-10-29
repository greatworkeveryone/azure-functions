import { app, type HttpRequest, type HttpResponseInit, type InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  beginTransaction,
  closeConnection,
  commitTransaction,
  createRequestConnection,
  createServiceRequestConnection,
  executeQuery,
  rollbackTransaction,
} from "../db";
import {
  AppRole,
  errorResponse,
  extractToken,
  requireRole,
  rolesForRequest,
  unauthorizedResponse,
  verifiedIdentityFromRequest,
  verifiedRequestClaims,
} from "../auth";
import { noteSignIn } from "../access/accessEvents";
import { clientAddress } from "../access/clientIp";
import { record } from "../ledger";
import { ledgerUserActor } from "../ledger/actor";
import { checkRateLimit, checkSignInRateLimit } from "../rateLimit";
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
    connection = await createRequestConnection(token);

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

// Separation of duties: a director could otherwise mint a second director or
// cfo identity and approve their own proposals. Only admin assigns, changes or
// deactivates these roles. Mirrored in the frontend capability map (roles.ts).
const ADMIN_ONLY_ROLES: ReadonlySet<string> = new Set([AppRole.ADMIN, AppRole.DIRECTOR, AppRole.CFO]);
const ADMIN_ONLY_ROLES_MESSAGE = "Only admins can assign or edit the admin, director and cfo roles";

/** Whether a member account (not a B2B guest or an app) presents these claims. */
export function isMemberUserClaims(claims: Record<string, unknown>): boolean {
  // acct: "0" member, "1" guest. idtyp: "user" | "app". Both optional claims.
  if (claims.acct === "1" || claims.acct === 1) return false;
  if (claims.idtyp !== undefined && claims.idtyp !== "user") return false;
  return true;
}

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

    // The activation ledger row compares this value, so a string like "false" must not reach it.
    if (isActive !== undefined && isActive !== null && typeof isActive !== "boolean") {
      return { status: 400, jsonBody: { error: "isActive must be true or false" } };
    }

    if (role !== undefined && role !== null) {
      if (!VALID_ROLES.has(role as AppRole)) {
        return { status: 400, jsonBody: { error: `Invalid role: ${role}` } };
      }
      if (ADMIN_ONLY_ROLES.has(role) && !callerIsAdmin) {
        return { status: 403, jsonBody: { error: ADMIN_ONLY_ROLES_MESSAGE } };
      }
    }

    connection = await createServiceRequestConnection();

    // Resolve caller display name for audit log.
    const callerRows = await executeQuery(
      connection,
      `SELECT UserID, DisplayName FROM dbo.AppUsers WHERE EntraOid = @Oid`,
      [{ name: "Oid", type: TYPES.NVarChar, value: callerOid }],
    );
    const callerDisplayName =
      (callerRows[0]?.DisplayName as string | undefined) ?? "Unknown";
    // Who the decision ledger records as having changed the role.
    const ledgerActor = ledgerUserActor({
      name: identity.name || callerDisplayName,
      roles: callerRoles,
      userId: (callerRows[0]?.UserID as number | undefined) ?? null,
    });

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
        `SELECT Role, Email, EntraOid, IsActive FROM dbo.AppUsers WHERE UserID = @UserID`,
        [{ name: "UserID", type: TYPES.Int, value: userId }],
      );
      if (oldRows.length === 0) {
        return { status: 404, jsonBody: { error: "User not found" } };
      }
      const oldRole       = (oldRows[0].Role     as string | null | undefined) ?? null;
      const targetEmail   = (oldRows[0].Email    as string | undefined) ?? "";
      const targetOid     = (oldRows[0].EntraOid as string | null | undefined) ?? null;
      const oldActive     = oldRows[0].IsActive !== false;

      if (oldRole !== null && ADMIN_ONLY_ROLES.has(oldRole) && !callerIsAdmin) {
        return { status: 403, jsonBody: { error: ADMIN_ONLY_ROLES_MESSAGE } };
      }

      if (targetOid && targetOid === callerOid) {
        return { status: 403, jsonBody: { error: "Cannot edit your own account" } };
      }

      // An omitted role leaves the role as it is; an explicit null clears it.
      const newRole = role === undefined ? oldRole : role;
      // An edit that omits isActive leaves the account as it is; defaulting to
      // true here used to reactivate a deactivated account on every role change.
      const newActive = isActive ?? oldActive;

      // Never leave the app without an active admin.
      if (oldRole === AppRole.ADMIN && oldActive && (!newActive || newRole !== AppRole.ADMIN)) {
        const others = await executeQuery(
          connection,
          `SELECT COUNT(*) AS Remaining FROM dbo.AppUsers
           WHERE Role = @Admin AND IsActive = 1 AND UserID <> @UserID`,
          [
            { name: "Admin",  type: TYPES.NVarChar, value: AppRole.ADMIN },
            { name: "UserID", type: TYPES.Int,      value: userId },
          ],
        );
        if (((others[0]?.Remaining as number | undefined) ?? 0) < 1) {
          return { status: 409, jsonBody: { error: "Cannot deactivate or demote the last active admin" } };
        }
      }

      // The role or activation change, its UserRoleAudit row and its ledger rows
      // commit or roll back together: no ledger row, no decision.
      await beginTransaction(connection);
      try {
        await executeQuery(
          connection,
          `UPDATE dbo.AppUsers
           SET Role     = @Role,
               IsActive = @IsActive
           WHERE UserID = @UserID`,
          [
            { name: "UserID",   type: TYPES.Int,      value: userId },
            { name: "Role",     type: TYPES.NVarChar, value: newRole },
            { name: "IsActive", type: TYPES.Bit,      value: newActive },
          ],
        );

        // Write audit and ledger rows only if role actually changed.
        if (newRole !== oldRole) {
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
              { name: "NewRole",               type: TYPES.NVarChar, value: newRole },
            ],
          );
          await record(connection, {
            action: "user.role_change",
            actor: ledgerActor,
            after: { role: newRole },
            before: { role: oldRole },
            subject: { id: userId, type: "app_user" },
          });
        }
        // UserRoleAudit stays role-only; activation changes live in the ledger.
        if (newActive !== oldActive) {
          await record(connection, {
            action: "user.activation_change",
            actor: ledgerActor,
            after: { isActive: newActive },
            before: { isActive: oldActive },
            subject: { id: userId, type: "app_user" },
          });
        }
        await commitTransaction(connection);
      } catch (err) {
        await rollbackTransaction(connection).catch(() => {});
        throw err;
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
      // Indexed by UX_AppUsers_Email_Active (migration 079). Email is already
      // lowercased by the caller (line 237); the column-side LOWER() that
      // previously wrapped this comparison blocked the index seek.
      `SELECT 1 AS Hit FROM dbo.AppUsers WHERE Email = @Email AND IsActive = 1`,
      [{ name: "Email", type: TYPES.NVarChar, value: email }],
    );
    if (dupRows.length > 0) {
      return { status: 409, jsonBody: { error: "email already in use" } };
    }

    const displayName = body.displayName?.trim() || email;

    // The invite, its UserRoleAudit row and its ledger row commit or roll back
    // together: no ledger row, no decision.
    let newUserId: number;
    await beginTransaction(connection);
    try {
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
      newUserId = inserted[0].UserID as number;

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
        await record(connection, {
          action: "user.role_change",
          actor: ledgerActor,
          after: { role },
          before: { role: null },
          subject: { id: newUserId, type: "app_user" },
        });
      }
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
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
  // Verify the token signature before trusting any identity claim. This path
  // writes the EntraOid→role mapping via a service connection, so Azure SQL
  // never validates the caller's token for us — an unverified decode would let
  // a forged token claim a pre-invited row (privilege escalation).
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const { oid, name, email: rawEmail } = identity;

  // Limits count only verified callers (SEC-10): an anonymous flood naming the
  // office's IP can no longer sign the whole office out.
  const rl = checkSignInRateLimit(oid, clientAddress(request) ?? "unknown");
  if (!rl.allowed) {
    // The bucket's kind only: never the oid, the address or the token.
    context.warn(`registerSelf refused: ${rl.bucket} sign-in limit reached`);
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  const email = rawEmail.trim().toLowerCase();
  if (!EMAIL_REGEX.test(email)) {
    return { status: 400, jsonBody: { error: "invalid email" } };
  }

  // Every sign-in goes to the access log (S10); deferred, never awaited.
  noteSignIn(request, oid);

  let connection;
  try {
    connection = await createServiceRequestConnection();

    // Step 1: existing user matched by OID (returning user).
    const byOid = await executeQuery(
      connection,
      `SELECT UserID, Role FROM dbo.AppUsers WHERE EntraOid = @Oid AND IsActive = 1`,
      [{ name: "Oid", type: TYPES.NVarChar, value: oid }],
    );
    if (byOid.length > 0) {
      // Email is set at invite or first registration only. preferred_username
      // is mutable, and the director-reply check trusts the stored address.
      const { UserID, Role } = byOid[0] as { UserID: number; Role: string | null };
      return { status: 200, jsonBody: { accessHints: true, userId: UserID, role: Role ?? null } };
    }

    // Step 2: pre-invited user matched by email (first login after admin invite).
    const byEmail = await executeQuery(
      connection,
      // Indexed by UX_AppUsers_Email_Active (migration 079). Email is already
      // lowercased by the caller (line 338).
      `SELECT UserID, Role, DisplayName FROM dbo.AppUsers
       WHERE Email = @Email AND EntraOid IS NULL AND IsActive = 1`,
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
      // A pre-invite is claimed by a member account only: a guest's
      // preferred_username is neither verified nor unique to them.
      const claims = await verifiedRequestClaims(request);
      if (!claims) return unauthorizedResponse();
      if (!isMemberUserClaims(claims)) {
        Sentry.captureMessage("pre-invite claim refused: not a member account", {
          level: "warning",
          extra: { email },
        });
        return {
          status: 403,
          jsonBody: { error: "This invite can only be claimed by a member account — contact admin" },
        };
      }
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
      return { status: 200, jsonBody: { accessHints: true, userId: UserID, role: Role ?? null } };
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
      jsonBody: { accessHints: true, userId: inserted[0].UserID as number, role: null },
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
