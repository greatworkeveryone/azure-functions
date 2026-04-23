import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  closeConnection,
  createConnection,
  executeQuery,
} from "../db";
import {
  errorResponse,
  extractToken,
  forbiddenResponse,
  rolesFromToken,
  unauthorizedResponse,
} from "../auth";

// ── Role helpers ─────────────────────────────────────────────────────────────

const FACILITIES_ROLES = ["facilities", "timesheet_approval_facilities"] as const;
const ACCOUNTS_ROLES  = ["accounts",   "timesheet_approval_accounts"]   as const;
const APPROVAL_ROLES  = ["timesheet_approval_facilities", "timesheet_approval_accounts"] as const;

type TimesheetRole = "facilities" | "accounts";

/** Map the caller's Entra roles to the timesheet role group they belong to. */
function timesheetRoleFromClaims(roles: string[]): TimesheetRole | null {
  if (roles.includes("Admin")) return null; // admin handled separately
  if (roles.some((r) => (FACILITIES_ROLES as readonly string[]).includes(r))) return "facilities";
  if (roles.some((r) => (ACCOUNTS_ROLES  as readonly string[]).includes(r))) return "accounts";
  return null;
}

/** Return which role group(s) this caller is authorised to approve/manage. */
function managedRoles(roles: string[]): TimesheetRole[] {
  if (roles.includes("Admin")) return ["facilities", "accounts"];
  const out: TimesheetRole[] = [];
  if (roles.includes("timesheet_approval_facilities")) out.push("facilities");
  if (roles.includes("timesheet_approval_accounts"))  out.push("accounts");
  return out;
}

function isApprovalManager(roles: string[]): boolean {
  return (
    roles.includes("Admin") ||
    roles.some((r) => (APPROVAL_ROLES as readonly string[]).includes(r))
  );
}

/** The oid claim is stored as the `oid` in the JWT payload. */
function oidFromToken(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return typeof parsed.oid === "string" ? parsed.oid : null;
  } catch {
    return null;
  }
}

function nameFromToken(token: string): string | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(json);
    return typeof parsed.name === "string" ? parsed.name : null;
  } catch {
    return null;
  }
}

// ── GET /api/getTimesheet ────────────────────────────────────────────────────
// Query: weekStart=YYYY-MM-DD  [&userId=<oid>]
// Returns the timesheet row or { timesheet: null } if none exists yet.

async function getTimesheet(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const callerOid = oidFromToken(token);
  if (!callerOid) return unauthorizedResponse();

  const roles = rolesFromToken(token);
  const weekStart = request.query.get("weekStart");
  const targetUserId = request.query.get("userId") ?? callerOid;

  if (!weekStart) return { status: 400, jsonBody: { error: "weekStart query param required (YYYY-MM-DD)" } };

  const isOwnData = targetUserId === callerOid;
  if (!isOwnData && !isApprovalManager(roles)) {
    return forbiddenResponse("Only approval managers can view other users' timesheets");
  }

  if (!isOwnData) {
    const managed = managedRoles(roles);
    if (managed.length === 0) {
      return forbiddenResponse("No managed role group");
    }
  }

  let connection;
  try {
    connection = await createConnection(token);

    let sql = `
      SELECT TimesheetID, UserID, UserDisplayName, WeekStartDate, Role, Data,
             ReadyForApproval, ReadyForApprovalDate, Approved, ApprovedDate,
             ApprovedBy, ApprovedByName, SentToMyobDate,
             CreatedOn, CreatedBy, UpdatedOn, UpdatedBy
      FROM dbo.Timesheets
      WHERE UserID = @UserID AND WeekStartDate = @WeekStartDate
    `;
    const params: any[] = [
      { name: "UserID",        type: TYPES.NVarChar, value: targetUserId },
      { name: "WeekStartDate", type: TYPES.Date,     value: new Date(weekStart) },
    ];

    // If manager, enforce their managed role scope
    if (!isOwnData && !roles.includes("Admin")) {
      const managed = managedRoles(roles);
      sql += ` AND Role IN (${managed.map((_, i) => `@Role${i}`).join(", ")})`;
      managed.forEach((r, i) => params.push({ name: `Role${i}`, type: TYPES.NVarChar, value: r }));
    }

    const rows = await executeQuery(connection, sql, params);
    return { status: 200, jsonBody: { timesheet: rows[0] ?? null } };
  } catch (error: any) {
    context.error("getTimesheet failed:", error.message);
    return errorResponse("Failed to fetch timesheet", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertTimesheet ────────────────────────────────────────────────
// Body: { weekStart, data, userId?, userDisplayName? }
// Creates or updates the Data column. Blocked when ReadyForApproval or Approved.

async function upsertTimesheet(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const callerOid = oidFromToken(token);
  if (!callerOid) return unauthorizedResponse();

  const callerName = nameFromToken(token) ?? "";
  const roles = rolesFromToken(token);

  let connection;
  try {
    const body = (await request.json()) as any;
    const { weekStart, data, userId, userDisplayName } = body ?? {};

    if (!weekStart || !data) {
      return { status: 400, jsonBody: { error: "weekStart and data are required" } };
    }

    const targetUserId: string = userId ?? callerOid;
    const targetDisplayName: string = userDisplayName ?? callerName;

    const isOwnData = targetUserId === callerOid;
    if (!isOwnData && !isApprovalManager(roles)) {
      return forbiddenResponse("Only approval managers can create timesheets for other users");
    }

    // Determine the role for this timesheet row
    let timesheetRole: TimesheetRole | null;
    if (isOwnData) {
      timesheetRole = timesheetRoleFromClaims(roles);
    } else {
      const managed = managedRoles(roles);
      timesheetRole = managed.length === 1 ? managed[0] : managed[0] ?? null;
    }

    if (!timesheetRole && !roles.includes("Admin")) {
      return { status: 400, jsonBody: { error: "Could not determine timesheet role group from token claims" } };
    }

    // For admin creating for someone else, role must be supplied
    if (!timesheetRole && roles.includes("Admin")) {
      return { status: 400, jsonBody: { error: "Admin must supply role in body when creating for another user" } };
    }

    connection = await createConnection(token);

    // Check if a timesheet exists and is locked
    const existing = await executeQuery(
      connection,
      `SELECT TimesheetID, ReadyForApproval, Approved FROM dbo.Timesheets
       WHERE UserID = @UserID AND WeekStartDate = @WeekStartDate`,
      [
        { name: "UserID",        type: TYPES.NVarChar, value: targetUserId },
        { name: "WeekStartDate", type: TYPES.Date,     value: new Date(weekStart) },
      ],
    );

    if (existing.length > 0) {
      const row = existing[0];
      if (row.ReadyForApproval || row.Approved) {
        return { status: 400, jsonBody: { error: "Timesheet is locked — recall it before editing" } };
      }

      // Update
      await executeQuery(
        connection,
        `UPDATE dbo.Timesheets
         SET Data = @Data, UpdatedOn = GETUTCDATE(), UpdatedBy = @UpdatedBy
         WHERE TimesheetID = @TimesheetID`,
        [
          { name: "Data",        type: TYPES.NVarChar, value: JSON.stringify(data) },
          { name: "UpdatedBy",   type: TYPES.NVarChar, value: callerOid },
          { name: "TimesheetID", type: TYPES.Int,      value: row.TimesheetID },
        ],
      );

      const updated = await executeQuery(
        connection,
        "SELECT * FROM dbo.Timesheets WHERE TimesheetID = @Id",
        [{ name: "Id", type: TYPES.Int, value: row.TimesheetID }],
      );
      return { status: 200, jsonBody: { timesheet: updated[0] } };
    }

    // Insert
    const inserted = await executeQuery(
      connection,
      `INSERT INTO dbo.Timesheets
         (UserID, UserDisplayName, WeekStartDate, Role, Data, CreatedBy)
       OUTPUT INSERTED.TimesheetID
       VALUES (@UserID, @UserDisplayName, @WeekStartDate, @Role, @Data, @CreatedBy)`,
      [
        { name: "UserID",          type: TYPES.NVarChar, value: targetUserId },
        { name: "UserDisplayName", type: TYPES.NVarChar, value: targetDisplayName },
        { name: "WeekStartDate",   type: TYPES.Date,     value: new Date(weekStart) },
        { name: "Role",            type: TYPES.NVarChar, value: timesheetRole },
        { name: "Data",            type: TYPES.NVarChar, value: JSON.stringify(data) },
        { name: "CreatedBy",       type: TYPES.NVarChar, value: callerOid },
      ],
    );

    const newId = inserted[0].TimesheetID as number;
    const created = await executeQuery(
      connection,
      "SELECT * FROM dbo.Timesheets WHERE TimesheetID = @Id",
      [{ name: "Id", type: TYPES.Int, value: newId }],
    );
    return { status: 200, jsonBody: { timesheet: created[0] } };
  } catch (error: any) {
    context.error("upsertTimesheet failed:", error.message);
    return errorResponse("Failed to save timesheet", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/submitTimesheetForApproval ─────────────────────────────────────
// Body: { timesheetId, submit: boolean }
// submit=true  → ReadyForApproval=1
// submit=false → ReadyForApproval=0  (recall; blocked if already Approved)

async function submitTimesheetForApproval(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const callerOid = oidFromToken(token);
  if (!callerOid) return unauthorizedResponse();

  const roles = rolesFromToken(token);

  let connection;
  try {
    const body = (await request.json()) as any;
    const { timesheetId, submit } = body ?? {};

    if (typeof timesheetId !== "number") {
      return { status: 400, jsonBody: { error: "timesheetId (number) required" } };
    }
    if (typeof submit !== "boolean") {
      return { status: 400, jsonBody: { error: "submit (boolean) required" } };
    }

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      "SELECT UserID, Approved, ReadyForApproval FROM dbo.Timesheets WHERE TimesheetID = @Id",
      [{ name: "Id", type: TYPES.Int, value: timesheetId }],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Timesheet not found" } };

    const row = rows[0];
    const isOwner = row.UserID === callerOid;

    if (!isOwner && !isApprovalManager(roles)) {
      return forbiddenResponse("Only approval managers can submit for other users");
    }
    if (row.Approved) {
      return { status: 400, jsonBody: { error: "Timesheet is already approved — unapprove first" } };
    }

    await executeQuery(
      connection,
      `UPDATE dbo.Timesheets
       SET ReadyForApproval = @Ready,
           ReadyForApprovalDate = IIF(@Ready = 1, GETUTCDATE(), NULL),
           UpdatedOn = GETUTCDATE(), UpdatedBy = @UpdatedBy
       WHERE TimesheetID = @Id`,
      [
        { name: "Ready",     type: TYPES.Bit,     value: submit ? 1 : 0 },
        { name: "UpdatedBy", type: TYPES.NVarChar, value: callerOid },
        { name: "Id",        type: TYPES.Int,      value: timesheetId },
      ],
    );

    const updated = await executeQuery(
      connection,
      "SELECT * FROM dbo.Timesheets WHERE TimesheetID = @Id",
      [{ name: "Id", type: TYPES.Int, value: timesheetId }],
    );
    return { status: 200, jsonBody: { timesheet: updated[0] } };
  } catch (error: any) {
    context.error("submitTimesheetForApproval failed:", error.message);
    return errorResponse("Failed to update approval status", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/approveTimesheet ───────────────────────────────────────────────
// Body: { timesheetId, approve: boolean }
// Requires timesheet_approval_* or Admin. Cannot approve own timesheet.
// Cannot unapprove if already sent to MYOB.

async function approveTimesheet(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const callerOid = oidFromToken(token);
  if (!callerOid) return unauthorizedResponse();

  const callerName = nameFromToken(token) ?? "";
  const roles = rolesFromToken(token);

  if (!isApprovalManager(roles)) {
    return forbiddenResponse("Requires timesheet_approval_facilities or timesheet_approval_accounts");
  }

  let connection;
  try {
    const body = (await request.json()) as any;
    const { timesheetId, approve } = body ?? {};

    if (typeof timesheetId !== "number") {
      return { status: 400, jsonBody: { error: "timesheetId (number) required" } };
    }
    if (typeof approve !== "boolean") {
      return { status: 400, jsonBody: { error: "approve (boolean) required" } };
    }

    connection = await createConnection(token);

    const rows = await executeQuery(
      connection,
      "SELECT UserID, Role, SentToMyobDate FROM dbo.Timesheets WHERE TimesheetID = @Id",
      [{ name: "Id", type: TYPES.Int, value: timesheetId }],
    );
    if (rows.length === 0) return { status: 404, jsonBody: { error: "Timesheet not found" } };

    const row = rows[0];

    if (row.UserID === callerOid && !roles.includes("Admin")) {
      return forbiddenResponse("Cannot approve your own timesheet");
    }

    const managed = managedRoles(roles);
    if (!managed.includes(row.Role as TimesheetRole) && !roles.includes("Admin")) {
      return forbiddenResponse(`You manage ${managed.join(", ")} timesheets; this is ${row.Role}`);
    }

    if (!approve && row.SentToMyobDate) {
      return { status: 400, jsonBody: { error: "Cannot unapprove a timesheet already sent to MYOB" } };
    }

    await executeQuery(
      connection,
      `UPDATE dbo.Timesheets
       SET Approved = @Approved,
           ApprovedDate    = IIF(@Approved = 1, GETUTCDATE(), NULL),
           ApprovedBy      = @ApprovedBy,
           ApprovedByName  = @ApprovedByName,
           UpdatedOn = GETUTCDATE(), UpdatedBy = @UpdatedBy
       WHERE TimesheetID = @Id`,
      [
        { name: "Approved",       type: TYPES.Bit,      value: approve ? 1 : 0 },
        { name: "ApprovedBy",     type: TYPES.NVarChar,  value: approve ? callerOid : null },
        { name: "ApprovedByName", type: TYPES.NVarChar,  value: approve ? callerName : null },
        { name: "UpdatedBy",      type: TYPES.NVarChar,  value: callerOid },
        { name: "Id",             type: TYPES.Int,       value: timesheetId },
      ],
    );

    const updated = await executeQuery(
      connection,
      "SELECT * FROM dbo.Timesheets WHERE TimesheetID = @Id",
      [{ name: "Id", type: TYPES.Int, value: timesheetId }],
    );
    return { status: 200, jsonBody: { timesheet: updated[0] } };
  } catch (error: any) {
    context.error("approveTimesheet failed:", error.message);
    return errorResponse("Failed to approve timesheet", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getTimesheets ───────────────────────────────────────────────────
// For the Payroll page. Requires approval role.
// Query: role?, readyForApproval?, approved?, weekStart?, userId?, page?, pageSize?

async function getTimesheets(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roles = rolesFromToken(token);
  if (!isApprovalManager(roles)) {
    return forbiddenResponse("Requires timesheet_approval_facilities or timesheet_approval_accounts");
  }

  const managed = managedRoles(roles);

  let connection;
  try {
    connection = await createConnection(token);

    const qRole             = request.query.get("role");
    const qReadyForApproval = request.query.get("readyForApproval");
    const qApproved         = request.query.get("approved");
    const qWeekStart        = request.query.get("weekStart");
    const qUserId           = request.query.get("userId");
    const page              = Math.max(1, parseInt(request.query.get("page") ?? "1"));
    const pageSize          = Math.min(100, parseInt(request.query.get("pageSize") ?? "50"));
    const offset            = (page - 1) * pageSize;

    const params: any[] = [];
    let WHERE_SQL = "";

    // Enforce role scope — managers can only see their groups
    const scopedRoles = qRole && managed.includes(qRole as TimesheetRole)
      ? [qRole as TimesheetRole]
      : managed;
    WHERE_SQL += ` AND Role IN (${scopedRoles.map((_, i) => `@ScopeRole${i}`).join(", ")})`;
    scopedRoles.forEach((r, i) =>
      params.push({ name: `ScopeRole${i}`, type: TYPES.NVarChar, value: r }),
    );

    if (qReadyForApproval !== null) {
      WHERE_SQL += " AND ReadyForApproval = @ReadyForApproval";
      params.push({ name: "ReadyForApproval", type: TYPES.Bit, value: qReadyForApproval === "true" ? 1 : 0 });
    }
    if (qApproved !== null) {
      WHERE_SQL += " AND Approved = @Approved";
      params.push({ name: "Approved", type: TYPES.Bit, value: qApproved === "true" ? 1 : 0 });
    }
    if (qWeekStart) {
      WHERE_SQL += " AND WeekStartDate = @WeekStartDate";
      params.push({ name: "WeekStartDate", type: TYPES.Date, value: new Date(qWeekStart) });
    }
    if (qUserId) {
      WHERE_SQL += " AND UserID = @FilterUserID";
      params.push({ name: "FilterUserID", type: TYPES.NVarChar, value: qUserId });
    }

    const countRows = await executeQuery(
      connection,
      `SELECT COUNT(*) AS Total FROM dbo.Timesheets WHERE 1=1${WHERE_SQL}`,
      params,
    );
    const total = (countRows[0]?.Total as number) ?? 0;

    const sql = `
      SELECT TimesheetID, UserID, UserDisplayName, WeekStartDate, Role, Data,
             ReadyForApproval, ReadyForApprovalDate, Approved, ApprovedDate,
             ApprovedBy, ApprovedByName, SentToMyobDate,
             CreatedOn, CreatedBy, UpdatedOn, UpdatedBy
      FROM dbo.Timesheets
      WHERE 1=1${WHERE_SQL}
      ORDER BY WeekStartDate DESC, UserDisplayName ASC
      OFFSET @Offset ROWS FETCH NEXT @PageSize ROWS ONLY`;

    const rows = await executeQuery(connection, sql, [
      ...params,
      { name: "Offset",   type: TYPES.Int, value: offset },
      { name: "PageSize", type: TYPES.Int, value: pageSize },
    ]);
    return { status: 200, jsonBody: { timesheets: rows, total, page, pageSize } };
  } catch (error: any) {
    context.error("getTimesheets failed:", error.message);
    return errorResponse("Failed to fetch timesheets", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getTimesheetUsers ───────────────────────────────────────────────
// Returns distinct users who have ever submitted a timesheet in the managed
// role group. Used to populate the user picker and detect missing submissions.
// Requires approval role.

async function getTimesheetUsers(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roles = rolesFromToken(token);
  if (!isApprovalManager(roles)) {
    return forbiddenResponse("Requires timesheet_approval_facilities or timesheet_approval_accounts");
  }

  const managed = managedRoles(roles);

  let connection;
  try {
    connection = await createConnection(token);

    const params: any[] = [];
    const PLACEHOLDERS = managed.map((_, i) => `@Role${i}`).join(", ");
    managed.forEach((r, i) => params.push({ name: `Role${i}`, type: TYPES.NVarChar, value: r }));

    const rows = await executeQuery(
      connection,
      `SELECT DISTINCT UserID, UserDisplayName, Role
       FROM dbo.Timesheets
       WHERE Role IN (${PLACEHOLDERS})
       ORDER BY UserDisplayName ASC`,
      params,
    );

    return { status: 200, jsonBody: { users: rows } };
  } catch (error: any) {
    context.error("getTimesheetUsers failed:", error.message);
    return errorResponse("Failed to fetch timesheet users", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/syncTimesheetsToMyob ───────────────────────────────────────────
// Marks newly approved timesheets as sent to MYOB. Requires approval role.
// The actual MYOB API call is stubbed — wire in credentials when ready.

export async function runMyobSync(
  token: string,
  roles: string[],
  context: InvocationContext,
): Promise<{ synced: number; errors: string[] }> {
  const managed = managedRoles(roles);
  const errors: string[] = [];
  let synced = 0;

  const connection = await createConnection(token);
  try {
    const PLACEHOLDERS = managed.map((_, i) => `@Role${i}`).join(", ");
    const params: any[] = managed.map((r, i) => ({ name: `Role${i}`, type: TYPES.NVarChar, value: r }));

    const pending = await executeQuery(
      connection,
      `SELECT TimesheetID, UserDisplayName, WeekStartDate, Data
       FROM dbo.Timesheets
       WHERE Approved = 1 AND SentToMyobDate IS NULL
         AND Role IN (${PLACEHOLDERS})`,
      params,
    );

    for (const row of pending) {
      try {
        // TODO: call MYOB API here when credentials are available
        // await sendToMyob(row);

        await executeQuery(
          connection,
          "UPDATE dbo.Timesheets SET SentToMyobDate = GETUTCDATE() WHERE TimesheetID = @Id",
          [{ name: "Id", type: TYPES.Int, value: row.TimesheetID }],
        );
        synced++;
        context.log(`MYOB sync: stamped TimesheetID ${row.TimesheetID} (${row.UserDisplayName})`);
      } catch (err: any) {
        errors.push(`TimesheetID ${row.TimesheetID}: ${err.message}`);
        context.error(`MYOB sync error for TimesheetID ${row.TimesheetID}:`, err.message);
      }
    }
  } finally {
    closeConnection(connection);
  }

  return { errors, synced };
}

async function syncTimesheetsToMyob(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roles = rolesFromToken(token);
  if (!isApprovalManager(roles)) {
    return forbiddenResponse("Requires timesheet_approval_facilities or timesheet_approval_accounts");
  }

  try {
    const result = await runMyobSync(token, roles, context);
    return { status: 200, jsonBody: result };
  } catch (error: any) {
    context.error("syncTimesheetsToMyob failed:", error.message);
    return errorResponse("MYOB sync failed", error.message);
  }
}

// ── Registrations ─────────────────────────────────────────────────────────────

app.http("getTimesheet",               { methods: ["GET"],  authLevel: "anonymous", handler: getTimesheet });
app.http("upsertTimesheet",            { methods: ["POST"], authLevel: "anonymous", handler: upsertTimesheet });
app.http("submitTimesheetForApproval", { methods: ["POST"], authLevel: "anonymous", handler: submitTimesheetForApproval });
app.http("approveTimesheet",           { methods: ["POST"], authLevel: "anonymous", handler: approveTimesheet });
app.http("getTimesheets",              { methods: ["GET"],  authLevel: "anonymous", handler: getTimesheets });
app.http("getTimesheetUsers",          { methods: ["GET"],  authLevel: "anonymous", handler: getTimesheetUsers });
app.http("syncTimesheetsToMyob",       { methods: ["POST"], authLevel: "anonymous", handler: syncTimesheetsToMyob });
