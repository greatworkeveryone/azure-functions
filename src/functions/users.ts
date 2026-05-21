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
  unauthorizedResponse,
  userInfoFromToken,
} from "../auth";

// ── GET /api/getAppUsers ──────────────────────────────────────────────────────
// Returns all active users. Used to populate assignment dropdowns.
// Requires any authenticated caller.

const VIEW_USERS_ROLES = [AppRole.ADMIN, AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL] as const;

async function getAppUsers(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, VIEW_USERS_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT UserID, DisplayName, Email, Role
       FROM dbo.AppUsers
       WHERE IsActive = 1
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
// Create or update an AppUser. Admin only.
// Body: { userId?, displayName, email, entraOid, role?, isActive? }

interface UpsertAppUserBody {
  userId?: number;
  displayName: string;
  email: string;
  entraOid: string;
  role?: string | null;
  isActive?: boolean;
}

async function upsertAppUser(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = requireRole(request, [AppRole.ADMIN]);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as UpsertAppUserBody;
    const { userId, displayName, email, entraOid, role, isActive } = body ?? {};

    if (!displayName || !email || !entraOid) {
      return { status: 400, jsonBody: { error: "displayName, email and entraOid are required" } };
    }

    connection = await createServiceConnection();

    if (userId) {
      await executeQuery(
        connection,
        `UPDATE dbo.AppUsers
         SET DisplayName = @DisplayName,
             Email       = @Email,
             EntraOid    = @EntraOid,
             Role        = @Role,
             IsActive    = @IsActive
         WHERE UserID = @UserID`,
        [
          { name: "UserID",      type: TYPES.Int,      value: userId },
          { name: "DisplayName", type: TYPES.NVarChar,  value: displayName },
          { name: "Email",       type: TYPES.NVarChar,  value: email },
          { name: "EntraOid",    type: TYPES.NVarChar,  value: entraOid },
          { name: "Role",        type: TYPES.NVarChar,  value: role ?? null },
          { name: "IsActive",    type: TYPES.Bit,       value: isActive ?? true },
        ],
      );
      return { status: 200, jsonBody: { userId } };
    }

    const inserted = await executeQuery(
      connection,
      `INSERT INTO dbo.AppUsers (DisplayName, Email, EntraOid, Role)
       OUTPUT INSERTED.UserID
       VALUES (@DisplayName, @Email, @EntraOid, @Role)`,
      [
        { name: "DisplayName", type: TYPES.NVarChar, value: displayName },
        { name: "Email",       type: TYPES.NVarChar, value: email },
        { name: "EntraOid",    type: TYPES.NVarChar, value: entraOid },
        { name: "Role",        type: TYPES.NVarChar, value: role ?? null },
      ],
    );
    return { status: 201, jsonBody: { userId: inserted[0].UserID as number } };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    context.error("upsertAppUser failed:", message);
    return errorResponse("Failed to upsert user", message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/registerSelf ────────────────────────────────────────────────────
// Upserts the caller into AppUsers using their own token claims.
// No role required — any authenticated user can call this.
// Does not set Role (admin-controlled); only syncs identity fields.

async function registerSelf(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const appToken = request.headers.get("x-app-token");
  if (!appToken) return unauthorizedResponse();

  const oid = oidFromToken(token);
  const info = userInfoFromToken(appToken);

  if (!oid || !info) {
    return { status: 400, jsonBody: { error: "Could not extract identity from token" } };
  }

  let connection;
  try {
    connection = await createServiceConnection();
    const result = await executeQuery(
      connection,
      `MERGE dbo.AppUsers AS target
       USING (SELECT @EntraOid AS EntraOid) AS source ON target.EntraOid = source.EntraOid
       WHEN MATCHED THEN
         UPDATE SET DisplayName = @DisplayName, Email = @Email
       WHEN NOT MATCHED THEN
         INSERT (DisplayName, Email, EntraOid)
         VALUES (@DisplayName, @Email, @EntraOid)
       OUTPUT INSERTED.UserID;`,
      [
        { name: "EntraOid",    type: TYPES.NVarChar, value: oid },
        { name: "DisplayName", type: TYPES.NVarChar, value: info.name },
        { name: "Email",       type: TYPES.NVarChar, value: info.email },
      ],
    );
    return { status: 200, jsonBody: { userId: result[0].UserID as number } };
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
