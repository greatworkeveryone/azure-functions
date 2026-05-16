import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { Connection, TYPES } from "tedious";
import {
  createConnection,
  executeQuery,
  closeConnection,
  beginTransaction,
  commitTransaction,
  rollbackTransaction,
  SqlParam,
  SqlRow,
} from "../db";
import {
  errorResponse,
  extractToken,
  oidFromToken,
  requireRole,
  rolesForRequest,
  unauthorizedResponse,
} from "../auth";
import { buildJobPacket } from "../pdf/job-packet";
import { loadJobPacketInputs } from "../pdf/job-packet-loader";

// ── Caller identity ──────────────────────────────────────────────────────────

interface UserRef { id: string; name: string }

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=");
    return JSON.parse(Buffer.from(padded, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

function callerFromToken(token: string): UserRef {
  const claims = decodeJwtPayload(token);
  const id = oidFromToken(token) ?? (claims?.preferred_username as string) ?? "unknown";
  const name =
    (claims?.name as string) ?? (claims?.preferred_username as string) ?? "Unknown user";
  return { id, name };
}

// Archive any job — set on Admin / approval-tier roles. Mirrors the frontend
// `archiveAnyJob` capability in src/constants/roles.ts. Plain "facilities"
// users get the OR with Job.CreatedBy === caller.name (handled inline).
const ARCHIVE_ANY_JOB_ROLES = [
  "Admin",
  "timesheet_approval_facilities",
  "timesheet_approval_accounts",
];

// Anyone who can create or edit jobs. Facilities team owns this day-to-day;
// approval tiers and admin retain ability to fix things.
const EDIT_JOBS_ROLES = [
  "Admin",
  "facilities",
  "timesheet_approval_facilities",
  "accounts",
  "timesheet_approval_accounts",
] as const;

// Anyone who can read jobs. Same set for now — read access is gated only to
// keep unauthorised tenants/contractors out, not internal staff.
const VIEW_JOBS_ROLES = [
  "Admin",
  "facilities",
  "timesheet_approval_facilities",
  "accounts",
  "timesheet_approval_accounts",
] as const;

// ── Column lists ─────────────────────────────────────────────────────────────
// Keep one source of truth so SELECT shapes match what the frontend expects.

const JOB_COLUMNS = `
  JobID, BuildingID, WorkRequestID, Title, Description, AssignedTo,
  Status, IsStalled, StalledReason, IsInternal, CreationMethod, SourceEmailID,
  SourceInspectionId, SourceInspectionRoomId, SourceInspectionPointId,
  AwaitingRole,
  ExpectedProgressUpdate, CompletionDate,
  ApprovedQuoteID, ApprovedBy, ApprovedAt,
  IsOnchargeable, OnchargeAmount, OnchargeNotes,
  TenantID,
  JobCode, LevelName, TenantName, Category, [Type], SubType, Priority,
  ExactLocation, ContactName, ContactPhone, ContactEmail, PersonAffected,
  IsArchived, ArchivedAt, ArchivedBy,
  CreatedAt, CreatedBy, LastModifiedDate,
  -- Count of items on this job currently waiting on director sign-off.
  -- Drives the "Director needed" filter on the Jobs screen. Covers BOTH
  -- invoices at stage-1 'approved' (awaiting director) and quotes parked
  -- in 'awaiting_director' after the submitter routed them up.
  ((SELECT COUNT(*) FROM JobInvoices ji
      WHERE ji.JobID = Jobs.JobID AND ji.Status = 'approved')
   + (SELECT COUNT(*) FROM Quotes q
       WHERE q.JobID = Jobs.JobID AND q.Status = 'awaiting_director')) AS DirectorNeededCount
`;

const JOB_EVENT_COLUMNS = `
  JobEventID, JobID, CreatedAt, CreatedBy, [Text], NewStatus,
  ExpectedProgressDate, IsStalled, EventType, PurchaseOrderID, QuoteID,
  NewAssignee, NewAwaitingRole, CreationSource
`;

// Editable job columns — the set an upsert payload may write. Anything else is
// ignored (CreatedAt, LastModifiedDate are managed server-side; Approved*
// columns flow through a dedicated approve-quote endpoint when that ships).
const JOB_WRITE_COLUMNS = [
  "BuildingID",
  "WorkRequestID",
  "Title",
  "Description",
  "AssignedTo",
  "Status",
  "IsStalled",
  "StalledReason",
  "IsInternal",
  "IsOnchargeable",
  "OnchargeAmount",
  "OnchargeNotes",
  "TenantID",
  "CreationMethod",
  "SourceEmailID",
  "SourceInspectionId",
  "SourceInspectionRoomId",
  "SourceInspectionPointId",
  "AwaitingRole",
  "ExpectedProgressUpdate",
  "CompletionDate",
  "CreatedBy",
  "JobCode",
  "LevelName",
  "TenantName",
  "Category",
  "Type",
  "SubType",
  "Priority",
  "ExactLocation",
  "ContactName",
  "ContactPhone",
  "ContactEmail",
  "PersonAffected",
] as const;

type JobColumn = (typeof JOB_WRITE_COLUMNS)[number];

type UpsertJobBody = { JobID?: number } & Partial<Record<JobColumn, unknown>>;
interface ArchiveJobBody { JobID: number }
interface UnarchiveJobBody { JobID: number }
interface AddJobEventBody {
  JobID: number;
  CreatedBy?: string;
  Text?: string;
  NewStatus?: string;
  ExpectedProgressDate?: string;
  IsStalled?: boolean | null;
  EventType?: string;
  PurchaseOrderID?: number;
  QuoteID?: number;
  NewAssignee?: string;
  NewAwaitingRole?: string;
  CreationSource?: string;
}

const COLUMN_TYPES: Record<JobColumn, any> = {
  BuildingID: TYPES.Int,
  WorkRequestID: TYPES.Int,
  Title: TYPES.NVarChar,
  Description: TYPES.NVarChar,
  AssignedTo: TYPES.NVarChar,
  Status: TYPES.NVarChar,
  IsStalled: TYPES.Bit,
  StalledReason: TYPES.NVarChar,
  IsInternal: TYPES.Bit,
  IsOnchargeable: TYPES.Bit,
  OnchargeAmount: TYPES.Decimal,
  OnchargeNotes: TYPES.NVarChar,
  TenantID: TYPES.Int,
  CreationMethod: TYPES.NVarChar,
  SourceEmailID: TYPES.Int,
  SourceInspectionId: TYPES.Int,
  SourceInspectionRoomId: TYPES.NVarChar,
  SourceInspectionPointId: TYPES.NVarChar,
  AwaitingRole: TYPES.NVarChar,
  ExpectedProgressUpdate: TYPES.DateTime2,
  CompletionDate: TYPES.DateTime2,
  CreatedBy: TYPES.NVarChar,
  JobCode: TYPES.NVarChar,
  LevelName: TYPES.NVarChar,
  TenantName: TYPES.NVarChar,
  Category: TYPES.NVarChar,
  Type: TYPES.NVarChar,
  SubType: TYPES.NVarChar,
  Priority: TYPES.NVarChar,
  ExactLocation: TYPES.NVarChar,
  ContactName: TYPES.NVarChar,
  ContactPhone: TYPES.NVarChar,
  ContactEmail: TYPES.NVarChar,
  PersonAffected: TYPES.NVarChar,
};

function pickJobFields(body: UpsertJobBody): Partial<Record<JobColumn, unknown>> {
  const out: Partial<Record<JobColumn, unknown>> = {};
  for (const col of JOB_WRITE_COLUMNS) {
    if (body[col] !== undefined) out[col] = body[col];
  }
  return out;
}

// ── Upsert validation ────────────────────────────────────────────────────────
// Whitelist enums + per-column length caps for the upsertJob body. Mirrors the
// canonical lists on the frontend (src/types/job.ts, JobWRDetailsSection.tsx)
// so a stray payload from a misbehaving client / postman dump can't write
// junk into Jobs and break filters or KPI tiles. The API is the last line of
// defence — add new values here when the frontend gains them.

// Status values are persisted verbatim — sentence-case as they appear in the
// frontend JobStatus enum, since both filters and historical rows compare
// strings.
const ALLOWED_STATUSES = [
  "New",
  "Awaiting Approval",
  "Quote",
  "Work",
  "Tenant",
  "Done",
] as const;

// AwaitingRole stores the lowercase token (per src/types/job.ts).
const ALLOWED_AWAITING_ROLES = ["facilities", "accounts"] as const;

// Job priorities — mirror JOB_PRIORITY_OPTIONS in
// command-centre/src/components/jobs/JobWRDetailsSection.tsx. The upstream
// WR priority enum has the same four values, so this gate covers both flows.
const ALLOWED_PRIORITIES = ["Critical", "High", "Normal", "Low"] as const;

const ALLOWED_CREATION_METHODS = ["manual", "wr", "email", "inspection"] as const;

const MAX_LEN: Partial<Record<JobColumn, number>> = {
  Title: 200,
  Description: 4000,
  AssignedTo: 200,
  StalledReason: 500,
  JobCode: 50,
  LevelName: 100,
  TenantName: 200,
  Category: 100,
  Type: 100,
  SubType: 100,
  ExactLocation: 200,
  ContactName: 200,
  ContactPhone: 50,
  ContactEmail: 200,
  PersonAffected: 200,
  OnchargeNotes: 4000,
};

function validateUpsertBody(
  fields: Partial<Record<JobColumn, unknown>>,
): string | null {
  if (
    fields.Status !== undefined &&
    fields.Status !== null &&
    !ALLOWED_STATUSES.includes(
      fields.Status as (typeof ALLOWED_STATUSES)[number],
    )
  ) {
    return "Invalid status";
  }
  if (
    fields.AwaitingRole !== undefined &&
    fields.AwaitingRole !== null &&
    !ALLOWED_AWAITING_ROLES.includes(
      fields.AwaitingRole as (typeof ALLOWED_AWAITING_ROLES)[number],
    )
  ) {
    return "Invalid AwaitingRole";
  }
  if (
    fields.Priority !== undefined &&
    fields.Priority !== null &&
    !ALLOWED_PRIORITIES.includes(
      fields.Priority as (typeof ALLOWED_PRIORITIES)[number],
    )
  ) {
    return "Invalid Priority";
  }
  if (
    fields.CreationMethod !== undefined &&
    fields.CreationMethod !== null &&
    !ALLOWED_CREATION_METHODS.includes(
      fields.CreationMethod as (typeof ALLOWED_CREATION_METHODS)[number],
    )
  ) {
    return "Invalid CreationMethod";
  }
  if (fields.OnchargeAmount !== undefined && fields.OnchargeAmount !== null) {
    const n = fields.OnchargeAmount;
    if (typeof n !== "number" || Number.isNaN(n) || n < 0 || n > 10_000_000) {
      return "Invalid OnchargeAmount";
    }
  }
  for (const [col, limit] of Object.entries(MAX_LEN) as Array<
    [JobColumn, number]
  >) {
    const v = fields[col];
    if (typeof v === "string" && v.length > limit) {
      return `${col} exceeds ${limit} characters`;
    }
  }
  return null;
}

// Mirror of validateUpsertBody for the addJobEvent payload — same Status /
// AwaitingRole enums plus a Text length cap. NewAssignee, EventType etc. stay
// free-form (caller owns those vocabularies).
const ADD_EVENT_TEXT_MAX = 5000;

function validateAddEventBody(body: AddJobEventBody): string | null {
  if (
    body.NewStatus !== undefined &&
    body.NewStatus !== null &&
    !ALLOWED_STATUSES.includes(body.NewStatus as (typeof ALLOWED_STATUSES)[number])
  ) {
    return "Invalid NewStatus";
  }
  if (
    body.NewAwaitingRole !== undefined &&
    body.NewAwaitingRole !== null &&
    !ALLOWED_AWAITING_ROLES.includes(
      body.NewAwaitingRole as (typeof ALLOWED_AWAITING_ROLES)[number],
    )
  ) {
    return "Invalid NewAwaitingRole";
  }
  if (typeof body.Text === "string" && body.Text.length > ADD_EVENT_TEXT_MAX) {
    return `Text exceeds ${ADD_EVENT_TEXT_MAX} characters`;
  }
  return null;
}

// ── Event-log fetch helper ───────────────────────────────────────────────────

async function fetchEventsForJobs(connection: Connection, jobIds: number[]): Promise<Record<number, SqlRow[]>> {
  if (jobIds.length === 0) return {};
  // Inline the ids — they are integers we just pulled from the Jobs table,
  // so there is no injection risk. Parameterising an IN-clause in Tedious
  // requires one @p per id, which is fiddlier than it's worth here.
  const idList = jobIds.map((n) => Math.trunc(n)).join(",");
  const rows = await executeQuery(
    connection,
    `SELECT ${JOB_EVENT_COLUMNS} FROM JobEvents WHERE JobID IN (${idList}) ORDER BY CreatedAt ASC`,
  );
  const byJob: Record<number, SqlRow[]> = {};
  for (const r of rows) {
    (byJob[r.JobID] ??= []).push(r);
  }
  return byJob;
}

// ── GET /api/getJobs[?buildingId=x][&status=Done][&archived=true] ────────────
// Three slices, mutually exclusive in practice:
//   default          → active jobs (IsArchived=0 AND Status <> 'Done')
//   ?status=Done     → completed work       (IsArchived=0 AND Status =  'Done')
//   ?archived=true   → soft-deleted jobs    (IsArchived=1, any status)
// Each frontend view (active panels / Done panel / Archived panel) hits the
// matching slice — keeps active payloads small and lets the archive panel
// surface restored-from candidates without polluting the default lists.

async function getJobs(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = requireRole(request, VIEW_JOBS_ROLES);
  if (roleCheck) return roleCheck;

  const buildingId = request.query.get("buildingId");
  const statusParam = request.query.get("status");
  const isDoneFilter = statusParam?.toLowerCase() === "done";
  const isArchivedFilter = request.query.get("archived")?.toLowerCase() === "true";

  const whereParts: string[] = [];
  if (isArchivedFilter) {
    whereParts.push("IsArchived = 1");
  } else {
    whereParts.push("IsArchived = 0");
    whereParts.push(isDoneFilter ? "Status = 'Done'" : "Status <> 'Done'");
  }
  const params: SqlParam[] = [];
  if (buildingId) {
    whereParts.push("BuildingID = @BuildingID");
    params.push({ name: "BuildingID", type: TYPES.Int, value: Number(buildingId) });
  }

  let connection;
  try {
    connection = await createConnection(token);

    const jobs = await executeQuery(
      connection,
      `SELECT ${JOB_COLUMNS} FROM Jobs WHERE ${whereParts.join(" AND ")} ORDER BY LastModifiedDate DESC`,
      params,
    );

    const eventsByJob = await fetchEventsForJobs(connection, jobs.map((j) => j.JobID as number));
    const payload = jobs.map((j) => ({ ...j, Events: eventsByJob[j.JobID as number] ?? [] }));

    return { status: 200, jsonBody: { count: payload.length, jobs: payload } };
  } catch (error: any) {
    // Tedious SQL errors don't always populate `.message`; the useful detail
    // lives on `.message || .number / .code / .originalError`. Stringify the
    // whole thing so the response body is diagnostic.
    const detail =
      error?.message || error?.originalError?.message || String(error);
    context.error("getJobs failed:", detail, error);
    return errorResponse("Failed to fetch jobs", detail);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getJob?jobId=x ──────────────────────────────────────────────────

async function getJob(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = requireRole(request, VIEW_JOBS_ROLES);
  if (roleCheck) return roleCheck;

  const jobId = Number(request.query.get("jobId"));
  if (!jobId) {
    return { status: 400, jsonBody: { error: "jobId (number) is required" } };
  }

  let connection;
  try {
    connection = await createConnection(token);
    const rows = await executeQuery(
      connection,
      `SELECT ${JOB_COLUMNS} FROM Jobs WHERE JobID = @JobID`,
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );
    if (rows.length === 0) {
      return { status: 404, jsonBody: { error: "Job not found" } };
    }
    const events = await executeQuery(
      connection,
      `SELECT ${JOB_EVENT_COLUMNS} FROM JobEvents WHERE JobID = @JobID ORDER BY CreatedAt ASC`,
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );
    return { status: 200, jsonBody: { job: { ...rows[0], Events: events } } };
  } catch (error: any) {
    context.error("getJob failed:", error.message);
    return errorResponse("Failed to fetch job", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/upsertJob ──────────────────────────────────────────────────────
// Body: { JobID?, ...job columns }. Omit JobID to create; include to update.
// Events are NOT touched by this endpoint — use addJobEvent for those.

async function upsertJob(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = requireRole(request, EDIT_JOBS_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as UpsertJobBody;
    const { JobID } = body ?? {};
    const fields = pickJobFields(body ?? {});

    if (JobID === undefined) {
      // Create — BuildingID, Title, Status are required.
      if (!fields.BuildingID || !fields.Title || !fields.Status) {
        return {
          status: 400,
          jsonBody: { error: "BuildingID, Title, Status are required to create a job" },
        };
      }
    } else if (typeof JobID !== "number") {
      return { status: 400, jsonBody: { error: "JobID must be a number when provided" } };
    } else if (Object.keys(fields).length === 0) {
      return { status: 400, jsonBody: { error: "No job columns provided — nothing to update" } };
    }

    // Enum + length checks against the whitelist. Reject fast so we don't
    // burn a SQL connection on an obviously-bogus payload.
    const validationError = validateUpsertBody(fields);
    if (validationError) {
      return { status: 400, jsonBody: { error: validationError } };
    }

    connection = await createConnection(token);

    const params: SqlParam[] = [];
    for (const [k, v] of Object.entries(fields)) {
      params.push({ name: k, type: COLUMN_TYPES[k as JobColumn], value: v ?? null });
    }

    let newJobId: number;

    if (JobID === undefined) {
      // INSERT — wrap the Jobs insert and the WR-attachment re-parenting in
      // one transaction. Otherwise a partial failure can strand WR
      // attachments on a non-existent Job (or commit the Job without the
      // matching attachments).
      const cols = Object.keys(fields);
      const insertCols = cols.join(", ");
      const insertVals = cols.map((c) => `@${c}`).join(", ");

      await beginTransaction(connection);
      try {
        const inserted = await executeQuery(
          connection,
          `INSERT INTO Jobs (${insertCols})
           OUTPUT INSERTED.JobID
           VALUES (${insertVals});`,
          params,
        );
        newJobId = inserted[0].JobID as number;

        // If the job was created from a Work Request, claim any attachments
        // that arrived with the WR. They were inserted earlier with JobID NULL
        // (WR existed, no Job yet); now that the Job exists they live on it
        // and the WR is finished with — see migration 010.
        if (typeof fields.WorkRequestID === "number") {
          await executeQuery(
            connection,
            `UPDATE Attachments
                SET JobID = @JobID
              WHERE WorkRequestID = @WorkRequestID
                AND JobID IS NULL`,
            [
              { name: "JobID", type: TYPES.Int, value: newJobId },
              { name: "WorkRequestID", type: TYPES.Int, value: fields.WorkRequestID },
            ],
          );
        }
        await commitTransaction(connection);
      } catch (err) {
        await rollbackTransaction(connection).catch(() => {});
        throw err;
      }
    } else {
      // UPDATE — single statement, no transaction needed.
      const setClause = Object.keys(fields).map((c) => `${c}=@${c}`).join(", ");
      params.push({ name: "JobID", type: TYPES.Int, value: JobID });
      const result = await executeQuery(
        connection,
        `UPDATE Jobs SET ${setClause}, LastModifiedDate=SYSUTCDATETIME()
         OUTPUT INSERTED.JobID
         WHERE JobID = @JobID;`,
        params,
      );
      if (result.length === 0) {
        return { status: 404, jsonBody: { error: "Job not found" } };
      }
      newJobId = result[0].JobID as number;
    }

    const stored = await executeQuery(
      connection,
      `SELECT ${JOB_COLUMNS} FROM Jobs WHERE JobID = @JobID`,
      [{ name: "JobID", type: TYPES.Int, value: newJobId }],
    );
    const events = await executeQuery(
      connection,
      `SELECT ${JOB_EVENT_COLUMNS} FROM JobEvents WHERE JobID = @JobID ORDER BY CreatedAt ASC`,
      [{ name: "JobID", type: TYPES.Int, value: newJobId }],
    );
    return { status: 200, jsonBody: { job: { ...stored[0], Events: events } } };
  } catch (error: any) {
    context.error("upsertJob failed:", error.message);
    return errorResponse("Upsert failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/archiveJob ─────────────────────────────────────────────────────
// Body: { JobID }. Soft-archives a job: sets IsArchived=1, ArchivedAt=now,
// ArchivedBy=caller. Records a JobEvents 'archived' row so the audit trail
// shows who and when. Authorisation:
//   • Admin / approval-tier roles can archive any job.
//   • Plain `facilities` users can only archive jobs they CreatedBy.
//   • Anyone else → 403.

async function archiveJob(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  // Baseline ops-role gate. Per-job ownership scoping for plain `facilities`
  // users happens further down once we know the job's CreatedBy.
  const roleCheck = requireRole(request, EDIT_JOBS_ROLES);
  if (roleCheck) return roleCheck;
  const caller = callerFromToken(token);
  const userRoles = rolesForRequest(request);
  const canArchiveAny = userRoles.some((r) => ARCHIVE_ANY_JOB_ROLES.includes(r));
  const isFacilities = userRoles.includes("facilities");

  let connection;
  try {
    const body = (await request.json()) as ArchiveJobBody;
    const { JobID } = body ?? {};
    if (!JobID || typeof JobID !== "number") {
      return { status: 400, jsonBody: { error: "JobID (number) is required" } };
    }
    connection = await createConnection(token);

    // Authorisation: load CreatedBy first so we can scope facilities users.
    // This read sits outside the transaction below — it's only consulted for
    // permission; the consistency-critical writes are the UPDATE + INSERT pair.
    const existing = await executeQuery(
      connection,
      "SELECT CreatedBy, IsArchived FROM Jobs WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: JobID }],
    );
    if (existing.length === 0) {
      return { status: 404, jsonBody: { error: "Job not found" } };
    }
    const createdBy = existing[0].CreatedBy as string | null;
    const alreadyArchived = Boolean(existing[0].IsArchived);
    if (alreadyArchived) {
      return { status: 200, jsonBody: { archived: JobID, alreadyArchived: true } };
    }
    if (!canArchiveAny) {
      const isOwner = isFacilities && createdBy && createdBy === caller.name;
      if (!isOwner) {
        return {
          status: 403,
          jsonBody: { error: "Not authorised to archive this job" },
        };
      }
    }

    // The UPDATE Jobs and the matching JobEvents 'archived' row MUST commit
    // together — otherwise a transient SQL failure between them leaves a job
    // archived with no audit trail (or vice versa).
    await beginTransaction(connection);
    try {
      await executeQuery(
        connection,
        `UPDATE Jobs SET IsArchived = 1, ArchivedAt = SYSUTCDATETIME(),
                         ArchivedBy = @ArchivedBy,
                         LastModifiedDate = SYSUTCDATETIME()
         WHERE JobID = @JobID`,
        [
          { name: "JobID", type: TYPES.Int, value: JobID },
          { name: "ArchivedBy", type: TYPES.NVarChar, value: caller.name },
        ],
      );
      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType)
         VALUES (@JobID, @CreatedBy, @Text, 'archived')`,
        [
          { name: "JobID", type: TYPES.Int, value: JobID },
          { name: "CreatedBy", type: TYPES.NVarChar, value: caller.name },
          { name: "Text", type: TYPES.NVarChar, value: "Job archived" },
        ],
      );
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
    return { status: 200, jsonBody: { archived: JobID } };
  } catch (error: any) {
    context.error("archiveJob failed:", error.message);
    return errorResponse("Archive failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/unarchiveJob ───────────────────────────────────────────────────
// Body: { JobID }. Same auth model as archiveJob — facilities can only
// restore jobs they originally created.

async function unarchiveJob(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  // Baseline ops-role gate; per-job ownership scoping happens below.
  const roleCheck = requireRole(request, EDIT_JOBS_ROLES);
  if (roleCheck) return roleCheck;
  const caller = callerFromToken(token);
  const userRoles = rolesForRequest(request);
  const canArchiveAny = userRoles.some((r) => ARCHIVE_ANY_JOB_ROLES.includes(r));
  const isFacilities = userRoles.includes("facilities");

  let connection;
  try {
    const body = (await request.json()) as UnarchiveJobBody;
    const { JobID } = body ?? {};
    if (!JobID || typeof JobID !== "number") {
      return { status: 400, jsonBody: { error: "JobID (number) is required" } };
    }
    connection = await createConnection(token);

    // Permission read — kept outside the transaction (see archiveJob comment).
    const existing = await executeQuery(
      connection,
      "SELECT CreatedBy, IsArchived FROM Jobs WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: JobID }],
    );
    if (existing.length === 0) {
      return { status: 404, jsonBody: { error: "Job not found" } };
    }
    const createdBy = existing[0].CreatedBy as string | null;
    const isArchived = Boolean(existing[0].IsArchived);
    if (!isArchived) {
      return { status: 200, jsonBody: { unarchived: JobID, alreadyActive: true } };
    }
    if (!canArchiveAny) {
      const isOwner = isFacilities && createdBy && createdBy === caller.name;
      if (!isOwner) {
        return {
          status: 403,
          jsonBody: { error: "Not authorised to restore this job" },
        };
      }
    }

    // UPDATE + JobEvents 'unarchived' insert must succeed/fail as a unit.
    await beginTransaction(connection);
    try {
      await executeQuery(
        connection,
        `UPDATE Jobs SET IsArchived = 0, ArchivedAt = NULL, ArchivedBy = NULL,
                         LastModifiedDate = SYSUTCDATETIME()
         WHERE JobID = @JobID`,
        [{ name: "JobID", type: TYPES.Int, value: JobID }],
      );
      await executeQuery(
        connection,
        `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType)
         VALUES (@JobID, @CreatedBy, @Text, 'unarchived')`,
        [
          { name: "JobID", type: TYPES.Int, value: JobID },
          { name: "CreatedBy", type: TYPES.NVarChar, value: caller.name },
          { name: "Text", type: TYPES.NVarChar, value: "Job restored from archive" },
        ],
      );
      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }
    return { status: 200, jsonBody: { unarchived: JobID } };
  } catch (error: any) {
    context.error("unarchiveJob failed:", error.message);
    return errorResponse("Restore failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/addJobEvent ────────────────────────────────────────────────────
// Body: {
//   JobID, CreatedBy?, Text?, NewStatus?, ExpectedProgressDate?, IsStalled?,
//   EventType?, PurchaseOrderID?, QuoteID?, NewAssignee?, CreationSource?
// }
// Appends one event and mirrors relevant fields onto the parent Jobs row so
// list views stay current:
//   NewStatus             → Jobs.Status
//   ExpectedProgressDate  → Jobs.ExpectedProgressUpdate
//   IsStalled (bool)      → Jobs.IsStalled
//   NewAssignee           → Jobs.AssignedTo
// Always bumps Jobs.LastModifiedDate.

async function addJobEvent(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = requireRole(request, EDIT_JOBS_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = (await request.json()) as AddJobEventBody;
    const {
      JobID,
      CreatedBy,
      Text,
      NewStatus,
      ExpectedProgressDate,
      IsStalled,
      EventType,
      PurchaseOrderID,
      QuoteID,
      NewAssignee,
      NewAwaitingRole,
      CreationSource,
    } = body ?? {};
    if (!JobID || typeof JobID !== "number") {
      return { status: 400, jsonBody: { error: "JobID (number) is required" } };
    }
    if (
      Text == null &&
      NewStatus == null &&
      ExpectedProgressDate == null &&
      IsStalled == null &&
      EventType == null &&
      PurchaseOrderID == null &&
      QuoteID == null &&
      NewAssignee == null &&
      NewAwaitingRole == null &&
      CreationSource == null
    ) {
      return {
        status: 400,
        jsonBody: {
          error:
            "Event must set at least one of: Text, NewStatus, ExpectedProgressDate, IsStalled, EventType, PurchaseOrderID, QuoteID, NewAssignee, NewAwaitingRole, CreationSource",
        },
      };
    }
    const validationError = validateAddEventBody(body ?? ({} as AddJobEventBody));
    if (validationError) {
      return { status: 400, jsonBody: { error: validationError } };
    }
    const isStalledBit =
      IsStalled == null ? null : IsStalled ? 1 : 0;

    connection = await createConnection(token);

    // INSERT JobEvents and the mirror UPDATE Jobs are a logical unit — an
    // event without the mirror leaves the Jobs row out of date (list views
    // read from Jobs, not from the event log), and an update without the
    // event loses the audit trail. Wrap both in one transaction.
    let insertedEventId: number;
    await beginTransaction(connection);
    try {
      const inserted = await executeQuery(
        connection,
        `INSERT INTO JobEvents (
           JobID, CreatedBy, [Text], NewStatus, ExpectedProgressDate, IsStalled,
           EventType, PurchaseOrderID, QuoteID, NewAssignee, NewAwaitingRole,
           CreationSource
         )
         OUTPUT INSERTED.JobEventID
         VALUES (
           @JobID, @CreatedBy, @Text, @NewStatus, @ExpectedProgressDate, @IsStalled,
           @EventType, @PurchaseOrderID, @QuoteID, @NewAssignee, @NewAwaitingRole,
           @CreationSource
         );`,
        [
          { name: "JobID", type: TYPES.Int, value: JobID },
          { name: "CreatedBy", type: TYPES.NVarChar, value: CreatedBy ?? null },
          { name: "Text", type: TYPES.NVarChar, value: Text ?? null },
          { name: "NewStatus", type: TYPES.NVarChar, value: NewStatus ?? null },
          { name: "ExpectedProgressDate", type: TYPES.DateTime2, value: ExpectedProgressDate ?? null },
          { name: "IsStalled", type: TYPES.Bit, value: isStalledBit },
          { name: "EventType", type: TYPES.NVarChar, value: EventType ?? null },
          { name: "PurchaseOrderID", type: TYPES.Int, value: PurchaseOrderID ?? null },
          { name: "QuoteID", type: TYPES.Int, value: QuoteID ?? null },
          { name: "NewAssignee", type: TYPES.NVarChar, value: NewAssignee ?? null },
          { name: "NewAwaitingRole", type: TYPES.NVarChar, value: NewAwaitingRole ?? null },
          { name: "CreationSource", type: TYPES.NVarChar, value: CreationSource ?? null },
        ],
      );
      if (inserted.length === 0) {
        await rollbackTransaction(connection).catch(() => {});
        return { status: 404, jsonBody: { error: "Job not found" } };
      }
      insertedEventId = inserted[0].JobEventID as number;

      // Mirror the event's fields onto the parent Jobs row so list views stay current.
      const updates: string[] = ["LastModifiedDate=SYSUTCDATETIME()"];
      const updateParams: SqlParam[] = [{ name: "JobID", type: TYPES.Int, value: JobID }];
      if (NewStatus != null) {
        updates.push("Status=@Status");
        updateParams.push({ name: "Status", type: TYPES.NVarChar, value: NewStatus });
      }
      if (ExpectedProgressDate != null) {
        updates.push("ExpectedProgressUpdate=@ExpectedProgressUpdate");
        updateParams.push({
          name: "ExpectedProgressUpdate",
          type: TYPES.DateTime2,
          value: ExpectedProgressDate,
        });
      }
      if (isStalledBit != null) {
        updates.push("IsStalled=@IsStalledMirror");
        updateParams.push({
          name: "IsStalledMirror",
          type: TYPES.Bit,
          value: isStalledBit,
        });
      }
      if (NewAssignee != null) {
        updates.push("AssignedTo=@AssignedToMirror");
        updateParams.push({
          name: "AssignedToMirror",
          type: TYPES.NVarChar,
          value: NewAssignee,
        });
      }
      if (NewAwaitingRole != null) {
        updates.push("AwaitingRole=@AwaitingRoleMirror");
        updateParams.push({
          name: "AwaitingRoleMirror",
          type: TYPES.NVarChar,
          value: NewAwaitingRole,
        });
      }
      await executeQuery(
        connection,
        `UPDATE Jobs SET ${updates.join(", ")} WHERE JobID = @JobID`,
        updateParams,
      );

      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

    const eventRow = await executeQuery(
      connection,
      `SELECT ${JOB_EVENT_COLUMNS} FROM JobEvents WHERE JobEventID = @JobEventID`,
      [{ name: "JobEventID", type: TYPES.Int, value: insertedEventId }],
    );
    const jobRow = await executeQuery(
      connection,
      `SELECT ${JOB_COLUMNS} FROM Jobs WHERE JobID = @JobID`,
      [{ name: "JobID", type: TYPES.Int, value: JobID }],
    );
    return { status: 200, jsonBody: { event: eventRow[0], job: jobRow[0] } };
  } catch (error: any) {
    context.error("addJobEvent failed:", error.message);
    return errorResponse("Add event failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getJobs", { methods: ["GET"], authLevel: "anonymous", handler: getJobs });
app.http("getJob", { methods: ["GET"], authLevel: "anonymous", handler: getJob });
app.http("upsertJob", { methods: ["POST"], authLevel: "anonymous", handler: upsertJob });
app.http("archiveJob", { methods: ["POST"], authLevel: "anonymous", handler: archiveJob });
app.http("unarchiveJob", { methods: ["POST"], authLevel: "anonymous", handler: unarchiveJob });
app.http("addJobEvent", { methods: ["POST"], authLevel: "anonymous", handler: addJobEvent });

async function getJobPacketPdf(
  request: HttpRequest,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = requireRole(request, VIEW_JOBS_ROLES);
  if (roleCheck) return roleCheck;

  const jobIdStr = request.params.jobId;
  const jobId = Number(jobIdStr);
  if (!Number.isFinite(jobId)) {
    return { status: 400, jsonBody: { error: "jobId must be numeric" } };
  }

  let connection;
  try {
    connection = await createConnection(token);
    const input = await loadJobPacketInputs(connection, jobId);
    const pdf = await buildJobPacket(input);
    return {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="job-${jobId}-packet.pdf"`,
      },
      body: pdf,
    };
  } catch (error: any) {
    context.error("getJobPacketPdf failed:", error.message);
    return errorResponse("Build job packet failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getJobPacketPdf", {
  methods: ["GET"],
  authLevel: "anonymous",
  route: "jobs/{jobId}/packet",
  handler: getJobPacketPdf,
});
