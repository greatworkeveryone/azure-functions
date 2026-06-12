import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import {
  closeConnection,
  createConnection,
  executeQuery,
  SqlParam,
} from "../db";
import {
  AppRole,
  errorResponse,
  extractToken,
  forbiddenResponse,
  nameFromToken,
  oidFromToken,
  requireRole,
  rolesForRequest,
  unauthorizedResponse,
  verifiedIdentityFromRequest,
} from "../auth";
import { checkRateLimit } from "../rateLimit";

const TIMESHEET_UPSERT_RATE_LIMIT = { limit: 60, windowMs: 60_000 };
const TIMESHEET_SUBMIT_RATE_LIMIT = { limit: 30, windowMs: 60_000 };

// Explicit column list — mirrors JOB_COLUMNS pattern in jobs.ts.
// Includes Data (the entries JSON) because all four callers return the
// row to a frontend that renders the timesheet. If a future endpoint
// needs only metadata, add a TIMESHEET_LIST_COLUMNS variant rather
// than dropping Data here.
const TIMESHEET_COLUMNS = `
  TimesheetID, UserID, UserDisplayName, WeekStartDate, Role, Data,
  ReadyForApproval, ReadyForApprovalDate,
  Approved, ApprovedDate, ApprovedBy, ApprovedByName,
  SentToMyobDate,
  CreatedOn, CreatedBy, UpdatedOn, UpdatedBy
`;

interface UpsertTimesheetBody { weekStart: string; data: unknown; userId?: string; userDisplayName?: string; role?: string }
interface SubmitTimesheetBody { timesheetId: number; submit: boolean }
interface ApproveTimesheetBody { timesheetId: number; approve: boolean }

// ── Role helpers ─────────────────────────────────────────────────────────────

const FACILITIES_ROLES = [AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL] as const;
const ACCOUNTS_ROLES  = [AppRole.ACCOUNTS,   AppRole.ACCOUNTS_APPROVAL]   as const;
const APPROVAL_ROLES  = [AppRole.DIRECTOR, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS_APPROVAL] as const;

type TimesheetRole = "facilities" | "accounts";

/** Map the caller's Entra roles to the timesheet role group they belong to. */
function timesheetRoleFromClaims(roles: string[]): TimesheetRole | null {
  if (roles.includes(AppRole.ADMIN)) return null; // admin handled separately
  if (roles.some((r) => (FACILITIES_ROLES as readonly string[]).includes(r))) return "facilities";
  if (roles.some((r) => (ACCOUNTS_ROLES  as readonly string[]).includes(r))) return "accounts";
  return null;
}

/** Return which role group(s) this caller is authorised to approve/manage. */
function managedRoles(roles: string[]): TimesheetRole[] {
  if (roles.includes(AppRole.ADMIN) || roles.includes(AppRole.DIRECTOR)) return ["facilities", "accounts"];
  const out: TimesheetRole[] = [];
  if (roles.includes(AppRole.FACILITIES_APPROVAL)) out.push("facilities");
  if (roles.includes(AppRole.ACCOUNTS_APPROVAL))  out.push("accounts");
  return out;
}

function isApprovalManager(roles: string[]): boolean {
  return (
    roles.includes(AppRole.ADMIN) ||
    roles.some((r) => (APPROVAL_ROLES as readonly string[]).includes(r))
  );
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

  // Baseline gate — keeps Pending (no-role) accounts out entirely.
  const baselineDenied = await requireRole(request, [AppRole.USER]);
  if (baselineDenied) return baselineDenied;

  // Caller identity comes from the verified token, never a query/body param —
  // a body-supplied userId can only describe the SUBJECT, never the caller.
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const callerOid = identity.oid;

  const roles = await rolesForRequest(request);
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
    const params: SqlParam[] = [
      { name: "UserID",        type: TYPES.NVarChar, value: targetUserId },
      { name: "WeekStartDate", type: TYPES.Date,     value: new Date(weekStart) },
    ];

    // If manager, enforce their managed role scope
    if (!isOwnData && !roles.includes(AppRole.ADMIN)) {
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

  // Baseline gate — keeps Pending (no-role) accounts out entirely.
  const baselineDenied = await requireRole(request, [AppRole.USER]);
  if (baselineDenied) return baselineDenied;

  // Caller identity is taken from the verified token. body.userId can only
  // identify the SUBJECT (when a manager edits someone else's sheet), never
  // the caller — otherwise a forged body could spoof who's doing the write.
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const callerOid = identity.oid;
  const callerName = identity.name;

  const rl = checkRateLimit(`timesheetUpsert:${callerOid}`, TIMESHEET_UPSERT_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  const roles = await rolesForRequest(request);

  let connection;
  try {
    const body = (await request.json()) as UpsertTimesheetBody;
    const { weekStart, data, userId, userDisplayName, role: bodyRole } = body ?? {};

    if (!weekStart || !data) {
      return { status: 400, jsonBody: { error: "weekStart and data are required" } };
    }

    const targetUserId: string = userId ?? callerOid;
    const targetDisplayName: string = userDisplayName ?? callerName;

    const isOwnData = targetUserId === callerOid;
    if (!isOwnData && !isApprovalManager(roles)) {
      return forbiddenResponse("Only approval managers can create timesheets for other users");
    }

    // Determine the role for this timesheet row — claims are authoritative for
    // non-admin users; admins supply an explicit role in the body.
    const validRoles: TimesheetRole[] = ["facilities", "accounts"];
    const suppliedRole: TimesheetRole | null =
      bodyRole && (validRoles as string[]).includes(bodyRole) ? bodyRole as TimesheetRole : null;

    let timesheetRole: TimesheetRole | null;
    if (isOwnData) {
      timesheetRole = timesheetRoleFromClaims(roles) ?? suppliedRole;
    } else {
      const managed = managedRoles(roles);
      timesheetRole = suppliedRole ?? (managed.length === 1 ? managed[0] : managed[0] ?? null);
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

      // Update — role is already stored in the row, not needed here
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
        `SELECT ${TIMESHEET_COLUMNS} FROM dbo.Timesheets WHERE TimesheetID = @Id`,
        [{ name: "Id", type: TYPES.Int, value: row.TimesheetID }],
      );
      return { status: 200, jsonBody: { timesheet: updated[0] } };
    }

    // Insert — role is required for new rows
    if (!timesheetRole) {
      return { status: 400, jsonBody: { error: "Could not determine timesheet role — supply role in request body" } };
    }

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
      `SELECT ${TIMESHEET_COLUMNS} FROM dbo.Timesheets WHERE TimesheetID = @Id`,
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

  // Baseline gate — keeps Pending (no-role) accounts out entirely.
  const baselineDenied = await requireRole(request, [AppRole.USER]);
  if (baselineDenied) return baselineDenied;

  // Caller identity from verified token — body cannot spoof who is submitting.
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const callerOid = identity.oid;

  const rl = checkRateLimit(`timesheetSubmit:${callerOid}`, TIMESHEET_SUBMIT_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  const roles = await rolesForRequest(request);

  let connection;
  try {
    const body = (await request.json()) as SubmitTimesheetBody;
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
      `SELECT ${TIMESHEET_COLUMNS} FROM dbo.Timesheets WHERE TimesheetID = @Id`,
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
  const roles = await rolesForRequest(request);

  if (!isApprovalManager(roles)) {
    return forbiddenResponse("Requires facilities_manager or accounts_manager");
  }

  let connection;
  try {
    const body = (await request.json()) as ApproveTimesheetBody;
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

    if (row.UserID === callerOid && !roles.includes(AppRole.ADMIN)) {
      return forbiddenResponse("Cannot approve your own timesheet");
    }

    const managed = managedRoles(roles);
    if (!managed.includes(row.Role as TimesheetRole) && !roles.includes(AppRole.ADMIN)) {
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
      `SELECT ${TIMESHEET_COLUMNS} FROM dbo.Timesheets WHERE TimesheetID = @Id`,
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

  const roles = await rolesForRequest(request);
  if (!isApprovalManager(roles)) {
    return forbiddenResponse("Requires facilities_manager or accounts_manager");
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

    const params: SqlParam[] = [];
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

  const roles = await rolesForRequest(request);
  if (!isApprovalManager(roles)) {
    return forbiddenResponse("Requires facilities_manager or accounts_manager");
  }

  const managed = managedRoles(roles);

  let connection;
  try {
    connection = await createConnection(token);

    const params: SqlParam[] = [];
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
    const params: SqlParam[] = managed.map((r, i) => ({ name: `Role${i}`, type: TYPES.NVarChar, value: r }));

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

  const denied = await requireRole(request, [AppRole.ACCOUNTS_APPROVAL]);
  if (denied) return denied;

  const roles = await rolesForRequest(request);
  if (!isApprovalManager(roles)) {
    return forbiddenResponse("Requires facilities_manager or accounts_manager");
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
