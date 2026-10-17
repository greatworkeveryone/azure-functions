import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { Connection, TYPES } from "tedious";
import {
  createRequestConnection,
  executeQuery,
  closeConnection,
  beginTransaction,
  commitTransaction,
  rollbackTransaction,
  SqlParam,
  SqlRow,
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
import { raiseCriticalJobEscalation } from "../escalation/criticalJob";
import { todayInDarwin } from "../darwinDate";
import { guardNewJob, recordDefectsOverride } from "../defectsJobGuard";
import { isWorkCompletion, markServiceJobCompleted } from "../serviceScheduleRuns";
import {
  MAX_LIST_ROWS,
  parsePagination,
  paginationSqlSuffix,
} from "../pagination";

const JOB_WRITE_RATE_LIMIT = { limit: 60, windowMs: 60_000 };
const JOB_ARCHIVE_RATE_LIMIT = { limit: 30, windowMs: 60_000 };
import { buildJobPacket } from "../pdf/job-packet";
import { loadJobPacketInputs } from "../pdf/job-packet-loader";
import { resolveActivePlannerTasks } from "../planner";
import { syncJobActionTriggersStandalone } from "../jobPlannerSync";
import {
  AwaitingRole,
  type JobState,
  JobStatus,
  resolveManualTarget,
} from "../jobStatusMachine";
import { flagChangeRefusal, guardTransition, type GuardStatus } from "../jobTransitionGuard";
import { loadJobForTransition } from "../jobTransitionFacts";

// Archive any job — set on Admin / approval-tier roles. Mirrors the frontend
// `archiveAnyJob` capability in src/constants/roles.ts. Plain "facilities"
// users get the OR with Job.CreatedBy === caller.name (handled inline).
const ARCHIVE_ANY_JOB_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES_APPROVAL,
  AppRole.ACCOUNTS_APPROVAL,
];

// Anyone who can create or edit jobs. Facilities team owns this day-to-day;
// approval tiers and admin retain ability to fix things.
const EDIT_JOBS_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
] as const;

// Anyone who can read jobs. Same set for now — read access is gated only to
// keep unauthorised tenants/contractors out, not internal staff.
const VIEW_JOBS_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
] as const;

// ── Column lists ─────────────────────────────────────────────────────────────
// Keep one source of truth so SELECT shapes match what the frontend expects.

const JOB_COLUMNS = `
  JobID, BuildingID, WorkRequestID, Title, Description, AssignedTo,
  AssignedToUserID,
  StalledAt,
  Status, IsStalled, StalledReason, IsInternal, CreationMethod, SourceEmailID,
  SourceInspectionId, SourceInspectionRoomId, SourceInspectionPointId,
  AwaitingRole,
  PreBlockStatus, PreBlockAwaitingRole,
  AcknowledgedAt, AcknowledgedBy, EscalatedAt, StatusSince,
  ExpectedProgressUpdate, CompletionDate,
  ApprovedQuoteID, ApprovedBy, ApprovedAt,
  IsOnchargeable, OnchargeAmount, OnchargeNotes,
  Kind,
  IsContract,
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
  InvoiceID,
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
  "AssignedToUserID",
  "Status",
  "IsStalled",
  "StalledReason",
  "IsInternal",
  "IsOnchargeable",
  "OnchargeAmount",
  "OnchargeNotes",
  "Kind",
  "IsContract",
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
  InvoiceID?: number;
  NewAssignee?: string;
  NewAssigneeUserID?: number;
  NewAwaitingRole?: string;
  CreationSource?: string;
}

const COLUMN_TYPES: Record<JobColumn, any> = {
  BuildingID: TYPES.Int,
  WorkRequestID: TYPES.Int,
  Title: TYPES.NVarChar,
  Description: TYPES.NVarChar,
  AssignedTo: TYPES.NVarChar,
  AssignedToUserID: TYPES.Int,
  Status: TYPES.NVarChar,
  IsStalled: TYPES.Bit,
  StalledReason: TYPES.NVarChar,
  IsInternal: TYPES.Bit,
  IsOnchargeable: TYPES.Bit,
  OnchargeAmount: TYPES.Decimal,
  OnchargeNotes: TYPES.NVarChar,
  Kind: TYPES.NVarChar,
  IsContract: TYPES.Bit,
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

// Job kind — reactive Facilities works vs scheduled Maintenance servicing
// (m079). Mirrors JobKind in command-centre/src/types/job.ts.
const ALLOWED_KINDS = ["facilities", "maintenance"] as const;

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
  if (
    fields.Kind !== undefined &&
    fields.Kind !== null &&
    !ALLOWED_KINDS.includes(fields.Kind as (typeof ALLOWED_KINDS)[number])
  ) {
    return "Invalid Kind";
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

  const roleCheck = await requireRole(request, VIEW_JOBS_ROLES);
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
    connection = await createRequestConnection(token);

    const pagination = parsePagination(request.query);
    const whereSql = whereParts.join(" AND ");

    // Apply OFFSET/FETCH when paginating; otherwise TOP enforces the ceiling.
    const topClause = pagination.active ? "" : `TOP ${MAX_LIST_ROWS} `;
    const jobs = await executeQuery(
      connection,
      `SELECT ${topClause}${JOB_COLUMNS} FROM Jobs
       WHERE ${whereSql}
       ORDER BY LastModifiedDate DESC${paginationSqlSuffix(pagination)}`,
      params,
    );

    const eventsByJob = await fetchEventsForJobs(connection, jobs.map((j) => j.JobID as number));
    const payload = jobs.map((j) => ({ ...j, Events: eventsByJob[j.JobID as number] ?? [] }));

    // Total is only meaningful when paginating; otherwise count = payload.length.
    let total = payload.length;
    if (pagination.active) {
      const totalRows = await executeQuery(
        connection,
        `SELECT COUNT(*) AS Total FROM Jobs WHERE ${whereSql}`,
        params,
      );
      total = (totalRows[0]?.Total as number) ?? payload.length;
    }

    const truncated = !pagination.active && payload.length >= MAX_LIST_ROWS;
    if (truncated) {
      context.warn(`getJobs: hit MAX_LIST_ROWS ceiling (${MAX_LIST_ROWS}) — caller should paginate`);
    }

    return {
      status: 200,
      jsonBody: {
        count: payload.length,
        jobs: payload,
        total,
        truncated,
        ...(pagination.active
          ? { page: pagination.page, pageSize: pagination.pageSize }
          : {}),
      },
    };
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

  const roleCheck = await requireRole(request, VIEW_JOBS_ROLES);
  if (roleCheck) return roleCheck;

  const jobId = Number(request.query.get("jobId"));
  if (!jobId) {
    return { status: 400, jsonBody: { error: "jobId (number) is required" } };
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
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
    const plannerTaskRows = await executeQuery(
      connection,
      `SELECT Id, TriggerType, LeadTimeDays, PlannerTaskId, DueDate,
              Status, CreatedAt, ResolvedAt,
              LastSyncedAt, LastError, AttemptCount
       FROM dbo.PlannerTasks
       WHERE EntityType = 'job' AND EntityId = @JobID
       ORDER BY CreatedAt DESC`,
      [{ name: "JobID", type: TYPES.Int, value: jobId }],
    );
    const plannerTasks = plannerTaskRows.map((r) => ({
      id: r.Id as number,
      triggerType: r.TriggerType as string,
      leadTimeDays: r.LeadTimeDays as number,
      dueDate: r.DueDate
        ? (r.DueDate as Date).toISOString().slice(0, 10)
        : null,
      status: r.Status as string,
      createdAt: (r.CreatedAt as Date).toISOString(),
      resolvedAt: r.ResolvedAt ? (r.ResolvedAt as Date).toISOString() : null,
      lastSyncedAt: r.LastSyncedAt
        ? (r.LastSyncedAt as Date).toISOString()
        : null,
      lastError: (r.LastError as string | null) ?? null,
      attemptCount: (r.AttemptCount as number | null) ?? 0,
    }));
    return {
      status: 200,
      jsonBody: { job: { ...rows[0], Events: events, PlannerTasks: plannerTasks } },
    };
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

export async function upsertJob(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, EDIT_JOBS_ROLES);
  if (roleCheck) return roleCheck;

  // Identity for audit columns (CreatedById, UpdatedBy) must come from the
  // verified token — never from the body — so a forged payload can't claim
  // someone else authored or modified the job.
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  const rl = checkRateLimit(`upsertJob:${identity.oid}`, JOB_WRITE_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

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
      // D4 machine guard (WP18a): a job is always born in 'New'. Any other
      // status on create would let a payload sidestep the state machine and
      // start mid-lifecycle. The frontend always creates as 'New'; reject the
      // rest at the API boundary.
      if (fields.Status !== "New") {
        return {
          status: 400,
          jsonBody: { error: "Status must be 'New' when creating a job" },
        };
      }
      // Default AwaitingRole to 'facilities' when the caller omits it — a New
      // job is always on the facilities side first.
      if (fields.AwaitingRole === undefined || fields.AwaitingRole === null) {
        fields.AwaitingRole = "facilities";
      }
      // N4 (J2): only a manager starts a job as contract or internal.
      if (fields.IsContract || fields.IsInternal) {
        const refusal = flagChangeRefusal({ actor: { kind: "user", roles: await rolesForRequest(request) }, hasMoneyRecords: false });
        if (refusal) {
          return { status: refusal.code === "role_not_permitted" ? 403 : 422, jsonBody: { code: refusal.code, error: refusal.reason } };
        }
      }
    } else if (typeof JobID !== "number") {
      return { status: 400, jsonBody: { error: "JobID must be a number when provided" } };
    } else if (Object.keys(fields).length === 0) {
      return { status: 400, jsonBody: { error: "No job columns provided — nothing to update" } };
    } else {
      // D4 machine guard (WP18a): status + awaiting-role transitions are owned
      // by the state machine via the addJobEvent endpoint. upsertJob edits the
      // job's descriptive fields only — never the lifecycle. Reject either write
      // so a stray payload can't bypass the machine (and leave the old inline
      // status_change / awaiting_role_change audit blocks below dead, so they
      // were removed).
      if (fields.Status !== undefined) {
        return {
          status: 422,
          jsonBody: {
            error:
              "Status changes must use the addJobEvent endpoint, not upsertJob.",
          },
        };
      }
      if (fields.AwaitingRole !== undefined) {
        return {
          status: 422,
          jsonBody: {
            error:
              "AwaitingRole changes must use the addJobEvent endpoint, not upsertJob.",
          },
        };
      }
    }

    // Enum + length checks against the whitelist. Reject fast so we don't
    // burn a SQL connection on an obviously-bogus payload.
    const validationError = validateUpsertBody(fields);
    if (validationError) {
      return { status: 400, jsonBody: { error: validationError } };
    }

    connection = await createRequestConnection(token);

    // Defects liability periods (sprint F1, LAUNCH-READINESS §5): new planned
    // maintenance on a covered scope is refused (409) unless a manager books it
    // anyway with a reason; anything else covered comes back as a warning.
    const defects =
      JobID === undefined
        ? await guardNewJob(connection, request, body as Record<string, unknown>, fields, todayInDarwin())
        : null;
    if (defects?.response) return defects.response;

    const params: SqlParam[] = [];
    for (const [k, v] of Object.entries(fields)) {
      params.push({ name: k, type: COLUMN_TYPES[k as JobColumn], value: v ?? null });
    }

    let newJobId: number;
    // The Priority the job had before this save, for the job.critical hook below.
    let previousPriority: unknown = null;

    if (JobID === undefined) {
      // INSERT — wrap the Jobs insert and the WR-attachment re-parenting in
      // one transaction. Otherwise a partial failure can strand WR
      // attachments on a non-existent Job (or commit the Job without the
      // matching attachments).
      //
      // Server-stamp CreatedBy (display name) and CreatedById (Entra OID)
      // from the verified token, overriding any body-supplied values. The
      // ownership compare on archive/unarchive trusts these, so they must
      // not come from the (forgeable) request body.
      fields.CreatedBy = identity.name;
      const filteredParams = params.filter((p) => p.name !== "CreatedBy");
      filteredParams.push({ name: "CreatedBy", type: TYPES.NVarChar, value: identity.name });
      // Stamp StatusSince at creation (WP18a) so the escalation age clock has a
      // starting point for the New state; SYSUTCDATETIME() is inlined (no param)
      // exactly like LastModifiedDate on the UPDATE path.
      const cols = Object.keys(fields);
      const insertCols = [...cols, "CreatedById", "StatusSince"].join(", ");
      const insertVals = [
        ...cols.map((c) => `@${c}`),
        "@CreatedById",
        "SYSUTCDATETIME()",
      ].join(", ");
      const insertParams: SqlParam[] = [
        ...filteredParams,
        { name: "CreatedById", type: TYPES.NVarChar, value: identity.oid },
      ];

      await beginTransaction(connection);
      try {
        const inserted = await executeQuery(
          connection,
          `INSERT INTO Jobs (${insertCols})
           OUTPUT INSERTED.JobID
           VALUES (${insertVals});`,
          insertParams,
        );
        newJobId = inserted[0].JobID as number;

        if (defects?.override) {
          await recordDefectsOverride(connection, request, {
            buildingId: fields.BuildingID as number,
            callerName: identity.name,
            jobId: newJobId,
            override: defects.override,
          });
        }

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
      // UPDATE — wrap the diff-snapshot SELECT, the UPDATE, and any audit
      // JobEvents INSERTs in one transaction so the audit trail can't drift
      // from the underlying Jobs row. Frontend used to fire these audit events
      // post-hoc via addJobEvent; doing it here keeps them atomic.
      //
      // CreatedBy is immutable post-INSERT; strip any body-supplied value so
      // a caller can't rewrite the original creator's name on edit.
      if ("CreatedBy" in fields) {
        delete fields.CreatedBy;
        const idx = params.findIndex((p) => p.name === "CreatedBy");
        if (idx >= 0) params.splice(idx, 1);
      }


      // Mirror StalledAt when IsStalled is explicitly set (same logic as addJobEvent).
      const stalledAtExtra: { clause: string; param: SqlParam } | null =
        fields.IsStalled !== undefined
          ? {
              clause: "StalledAt=@StalledAt",
              param: { name: "StalledAt", type: TYPES.DateTime2, value: fields.IsStalled ? new Date() : null },
            }
          : null;

      const setClause = [
        ...Object.keys(fields).map((c) => `${c}=@${c}`),
        ...(stalledAtExtra ? [stalledAtExtra.clause] : []),
      ].join(", ");
      if (stalledAtExtra) params.push(stalledAtExtra.param);
      params.push({ name: "JobID", type: TYPES.Int, value: JobID });

      await beginTransaction(connection);
      try {
        // Snapshot the columns we audit before the UPDATE rewrites them. Status
        // is read only for the contract-flip guard below — upsertJob can no
        // longer write Status or AwaitingRole (D4 guard rejects both upstream),
        // so those diff/event blocks were removed.
        const previousRows = await executeQuery(
          connection,
          `SELECT Status, AssignedTo, Kind, IsContract, IsInternal, Priority,
                  CASE WHEN EXISTS (SELECT 1 FROM Quotes q WHERE q.JobID = Jobs.JobID)
                         OR EXISTS (SELECT 1 FROM PurchaseOrders p WHERE p.JobID = Jobs.JobID)
                         OR EXISTS (SELECT 1 FROM JobInvoices i WHERE i.JobID = Jobs.JobID) THEN 1 ELSE 0 END AS HasMoneyRecords
             FROM Jobs WITH (UPDLOCK, HOLDLOCK) WHERE JobID = @JobID`,
          [{ name: "JobID", type: TYPES.Int, value: JobID }],
        );
        const previous = previousRows[0]; // may be undefined — the UPDATE 0-row check below handles "Job not found".
        previousPriority = previous?.Priority ?? null;

        // N4 (J2): IsContract / IsInternal decide which money path the job
        // takes, so only a manager changes them, and never once a quote, PO
        // or invoice exists. Re-sending the value the job has is no change.
        const flips = (column: "IsContract" | "IsInternal"): boolean =>
          previous !== undefined && fields[column] !== undefined && Boolean(fields[column]) !== Boolean(previous[column]);
        if (flips("IsContract") || flips("IsInternal")) {
          const refusal = flagChangeRefusal({
            actor: { kind: "user", roles: await rolesForRequest(request) },
            hasMoneyRecords: Boolean(previous?.HasMoneyRecords),
          });
          if (refusal) {
            await rollbackTransaction(connection).catch(() => {});
            return { status: refusal.code === "role_not_permitted" ? 403 : 422, jsonBody: { code: refusal.code, error: refusal.reason } };
          }
        }

        // Guard the contract flip (WP10): isContract may only change while the
        // job is still New — flipping it mid-flow would invalidate the quote /
        // contract path the job has already taken. Reject before the UPDATE so
        // the change never lands.
        if (previous && fields.IsContract !== undefined) {
          const prevContract = Boolean(previous.IsContract);
          const nextContract = Boolean(fields.IsContract);
          if (prevContract !== nextContract && previous.Status !== "New") {
            await rollbackTransaction(connection).catch(() => {});
            return {
              status: 422,
              jsonBody: {
                error:
                  "Contract status can only be changed while the job is New.",
              },
            };
          }
        }

        const result = await executeQuery(
          connection,
          `UPDATE Jobs SET ${setClause}, LastModifiedDate=SYSUTCDATETIME()
           OUTPUT INSERTED.JobID
           WHERE JobID = @JobID;`,
          params,
        );
        if (result.length === 0) {
          await rollbackTransaction(connection).catch(() => {});
          return { status: 404, jsonBody: { error: "Job not found" } };
        }
        newJobId = result[0].JobID as number;

        // Diff the audit-worthy descriptive fields and INSERT a JobEvents row
        // per change. Status / AwaitingRole are NOT diffed here — they can't be
        // written through upsertJob (D4 guard); those transitions and their
        // audit events flow through addJobEvent. Only fields explicitly present
        // on the payload count — an omitted field is "no change", not a clear.
        if (previous) {
          // Use the verified identity (token signature checked) so audit rows
          // can't be authored by a forged JWT name claim.
          const caller = { id: identity.oid, name: identity.name };
          const newAssignedTo = fields.AssignedTo as string | null | undefined;
          const newKind = fields.Kind as string | null | undefined;
          const newIsContract = fields.IsContract as boolean | number | null | undefined;

          if (newAssignedTo !== undefined && newAssignedTo !== previous.AssignedTo) {
            const fromLabel = (previous.AssignedTo as string | null) || "—";
            const toLabel = newAssignedTo || null;
            const text = toLabel
              ? `Reassigned to ${toLabel} (was ${fromLabel})`
              : `Unassigned (was ${fromLabel})`;
            await executeQuery(
              connection,
              `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType, NewAssignee)
               VALUES (@JobID, @CreatedBy, @Text, @EventType, @NewAssignee)`,
              [
                { name: "JobID", type: TYPES.Int, value: newJobId },
                { name: "CreatedBy", type: TYPES.NVarChar, value: caller.name },
                { name: "Text", type: TYPES.NVarChar, value: text },
                { name: "EventType", type: TYPES.NVarChar, value: "assignment_change" },
                { name: "NewAssignee", type: TYPES.NVarChar, value: toLabel },
              ],
            );
          }

          if (newKind !== undefined && newKind !== previous.Kind) {
            const fromLabel = (previous.Kind as string | null) || "facilities";
            const toLabel = newKind || "facilities";
            await executeQuery(
              connection,
              `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType)
               VALUES (@JobID, @CreatedBy, @Text, @EventType)`,
              [
                { name: "JobID", type: TYPES.Int, value: newJobId },
                { name: "CreatedBy", type: TYPES.NVarChar, value: caller.name },
                { name: "Text", type: TYPES.NVarChar, value: `Kind: ${fromLabel} → ${toLabel}` },
                { name: "EventType", type: TYPES.NVarChar, value: "kind_change" },
              ],
            );
          }

          if (fields.IsInternal !== undefined && Boolean(fields.IsInternal) !== Boolean(previous.IsInternal)) {
            await executeQuery(
              connection,
              `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType)
               VALUES (@JobID, @CreatedBy, @Text, @EventType)`,
              [
                { name: "JobID", type: TYPES.Int, value: newJobId },
                { name: "CreatedBy", type: TYPES.NVarChar, value: caller.name },
                {
                  name: "Text",
                  type: TYPES.NVarChar,
                  value: fields.IsInternal ? "Marked as internal (no quote, PO or invoice)" : "Internal flag removed",
                },
                { name: "EventType", type: TYPES.NVarChar, value: "internal_change" },
              ],
            );
          }

          if (
            newIsContract !== undefined &&
            Boolean(newIsContract) !== Boolean(previous.IsContract)
          ) {
            const toContract = Boolean(newIsContract);
            await executeQuery(
              connection,
              `INSERT INTO JobEvents (JobID, CreatedBy, [Text], EventType)
               VALUES (@JobID, @CreatedBy, @Text, @EventType)`,
              [
                { name: "JobID", type: TYPES.Int, value: newJobId },
                { name: "CreatedBy", type: TYPES.NVarChar, value: caller.name },
                {
                  name: "Text",
                  type: TYPES.NVarChar,
                  value: toContract
                    ? "Marked as standing-contract (quotes skipped)"
                    : "Standing-contract flag removed (quoted flow)",
                },
                { name: "EventType", type: TYPES.NVarChar, value: "contract_change" },
              ],
            );
          }
        }

        await commitTransaction(connection);
      } catch (err) {
        await rollbackTransaction(connection).catch(() => {});
        throw err;
      }
    }

    // job.critical (WP20): a job created or re-prioritised Critical raises an
    // escalation at once. The save above has committed; this can't fail it.
    await raiseCriticalJobEscalation({
      connection,
      jobId: newJobId,
      log: (message) => context.warn(message),
      previousPriority,
      priority: fields.Priority,
      request,
    });

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

    // Eager-fire the job-bound Planner triggers (awaiting_accounts,
    // stalled_facilities, oncharge_pending) when any of their inputs were in
    // the payload. Each trigger's sync is idempotent and no-ops when the
    // condition doesn't apply. Failures are swallowed internally; the nightly
    // plannerSyncTimer is the reconciliation safety net.
    if (
      fields.IsOnchargeable !== undefined ||
      fields.IsStalled !== undefined ||
      fields.AwaitingRole !== undefined ||
      fields.AssignedToUserID !== undefined ||
      fields.Status !== undefined
    ) {
      await syncJobActionTriggersStandalone(newJobId, (msg) => context.log(msg));
    }

    return {
      status: 200,
      jsonBody: {
        job: { ...stored[0], Events: events },
        ...(defects && defects.warnings.length > 0 ? { defectsWarnings: defects.warnings } : {}),
      },
    };
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
  // users happens further down once we know the job's CreatedById.
  const roleCheck = await requireRole(request, EDIT_JOBS_ROLES);
  if (roleCheck) return roleCheck;
  // Identity must come from the verified token — the ownership check below
  // compares it against the stored CreatedById, so an unverified value would
  // let a forged JWT bypass the per-job scope.
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const caller = { id: identity.oid, name: identity.name };

  const rl = checkRateLimit(`archiveJob:${identity.oid}`, JOB_ARCHIVE_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  const userRoles = await rolesForRequest(request);
  const canArchiveAny = userRoles.some((r) => ARCHIVE_ANY_JOB_ROLES.includes(r as AppRole));
  const isFacilities = userRoles.includes(AppRole.FACILITIES);

  let connection;
  try {
    const body = (await request.json()) as ArchiveJobBody;
    const { JobID } = body ?? {};
    if (!JobID || typeof JobID !== "number") {
      return { status: 400, jsonBody: { error: "JobID (number) is required" } };
    }
    connection = await createRequestConnection(token);

    // Authorisation: load CreatedById + CreatedBy first so we can scope
    // facilities users. This read sits outside the transaction below — it's
    // only consulted for permission; the consistency-critical writes are the
    // UPDATE + INSERT pair.
    const existing = await executeQuery(
      connection,
      "SELECT CreatedBy, CreatedById, IsArchived FROM Jobs WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: JobID }],
    );
    if (existing.length === 0) {
      return { status: 404, jsonBody: { error: "Job not found" } };
    }
    const createdBy = existing[0].CreatedBy as string | null;
    const createdById = existing[0].CreatedById as string | null;
    const alreadyArchived = Boolean(existing[0].IsArchived);
    if (alreadyArchived) {
      return { status: 200, jsonBody: { archived: JobID, alreadyArchived: true } };
    }
    if (!canArchiveAny) {
      // Prefer the verified OID compare when CreatedById is populated. Fall
      // back to the legacy display-name compare ONLY for historical rows
      // (CreatedById IS NULL) — those pre-date migration 050 and have no OID.
      const isOwner = isFacilities && (
        createdById
          ? createdById === identity.oid
          : Boolean(createdBy) && createdBy === caller.name
      );
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
    resolveActivePlannerTasks("job", JobID, ["stalled_facilities", "awaiting_accounts", "director_approval", "job_update_due"]).catch(
      (err: unknown) =>
        context.warn("plannerResolve (archiveJob):", err instanceof Error ? err.message : String(err)),
    );
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
  const roleCheck = await requireRole(request, EDIT_JOBS_ROLES);
  if (roleCheck) return roleCheck;
  // Identity must come from the verified token — see archiveJob for rationale.
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();
  const caller = { id: identity.oid, name: identity.name };

  const rl = checkRateLimit(`unarchiveJob:${identity.oid}`, JOB_ARCHIVE_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  const userRoles = await rolesForRequest(request);
  const canArchiveAny = userRoles.some((r) => ARCHIVE_ANY_JOB_ROLES.includes(r as AppRole));
  const isFacilities = userRoles.includes(AppRole.FACILITIES);

  let connection;
  try {
    const body = (await request.json()) as UnarchiveJobBody;
    const { JobID } = body ?? {};
    if (!JobID || typeof JobID !== "number") {
      return { status: 400, jsonBody: { error: "JobID (number) is required" } };
    }
    connection = await createRequestConnection(token);

    // Permission read — kept outside the transaction (see archiveJob comment).
    const existing = await executeQuery(
      connection,
      "SELECT CreatedBy, CreatedById, IsArchived FROM Jobs WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: JobID }],
    );
    if (existing.length === 0) {
      return { status: 404, jsonBody: { error: "Job not found" } };
    }
    const createdBy = existing[0].CreatedBy as string | null;
    const createdById = existing[0].CreatedById as string | null;
    const isArchived = Boolean(existing[0].IsArchived);
    if (!isArchived) {
      return { status: 200, jsonBody: { unarchived: JobID, alreadyActive: true } };
    }
    if (!canArchiveAny) {
      // CreatedById compare when populated; legacy display-name fallback for
      // historical rows that pre-date migration 050.
      const isOwner = isFacilities && (
        createdById
          ? createdById === identity.oid
          : Boolean(createdBy) && createdBy === caller.name
      );
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

export async function addJobEvent(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const roleCheck = await requireRole(request, EDIT_JOBS_ROLES);
  if (roleCheck) return roleCheck;

  // CreatedBy on the JobEvents row must come from the verified token. The
  // body's CreatedBy is ignored — keeping the field on AddJobEventBody is
  // backward-compat with older clients only.
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return unauthorizedResponse();

  const rl = checkRateLimit(`addJobEvent:${identity.oid}`, JOB_WRITE_RATE_LIMIT);
  if (!rl.allowed) {
    return {
      status: 429,
      headers: { "Retry-After": String(Math.ceil(rl.retryAfterMs / 1000)) },
      jsonBody: { error: "Rate limit exceeded" },
    };
  }

  let connection;
  try {
    const body = (await request.json()) as AddJobEventBody;
    const {
      JobID,
      Text,
      NewStatus,
      ExpectedProgressDate,
      IsStalled,
      EventType,
      PurchaseOrderID,
      QuoteID,
      InvoiceID,
      NewAssignee,
      NewAssigneeUserID,
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
      NewAssigneeUserID == null &&
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
    // N1 (J2): the awaiting side is derived by the state machine from the
    // status; a request never writes it, with or without a status change.
    if (NewAwaitingRole != null) {
      return {
        status: 422,
        jsonBody: {
          code: "awaiting_role_derived",
          error: "Who the job waits on follows its status, so it can't be set directly.",
        },
      };
    }
    const isStalledBit =
      IsStalled == null ? null : IsStalled ? 1 : 0;

    connection = await createRequestConnection(token);
    const roles = await rolesForRequest(request);

    // Everything below is one transaction: the job is read and locked, the
    // transition guard decides on exactly that state (J2), and the event and
    // the mirror UPDATE are written, the UPDATE predicated on the state read.
    // An event without the mirror leaves the Jobs row out of date (list views
    // read from Jobs, not from the event log), and an update without the event
    // loses the audit trail.
    let resolvedNewStatus: string | null = null;
    let resolvedNewAwaitingRole: string | null = null;
    // The state the guard decided on; the mirror UPDATE only lands if the row
    // still holds it.
    let expectedState: JobState | null = null;
    // Pre-block capture/restore for tenant blocks (WP8): capture the composite
    // the job is leaving when it is blocked, clear it when it is unblocked (the
    // machine has already applied the restore to the target).
    let preBlockToCapture: JobState | null = null;
    let clearsPreBlock = false;
    // A real transition (not a self-transition no-op) resets the
    // accountability clock: StatusSince=now, prior acknowledgement and
    // escalation cleared.
    let isRealTransition = false;
    let insertedEventId: number;
    await beginTransaction(connection);
    try {
      if (NewStatus != null) {
        const locked = await loadJobForTransition(connection, JobID);
        if (!locked) {
          await rollbackTransaction(connection).catch(() => {});
          return { status: 404, jsonBody: { error: "Job not found" } };
        }
        const currentState: JobState = {
          awaitingRole: locked.current.awaitingRole as AwaitingRole,
          status: locked.current.status as JobStatus,
        };
        if (NewStatus === currentState.status) {
          // Self-transitions are accepted as no-ops so the activity event
          // still lands in the feed ("Quote received" while already Awaiting
          // Approval).
          resolvedNewStatus = currentState.status;
          resolvedNewAwaitingRole = currentState.awaitingRole;
        } else {
          const preBlockState: JobState | undefined = locked.preBlock
            ? { awaitingRole: locked.preBlock.awaitingRole as AwaitingRole, status: locked.preBlock.status as JobStatus }
            : undefined;
          const machineTarget = resolveManualTarget(currentState, NewStatus as JobStatus, {
            isContract: locked.facts.isContract,
            isInternal: locked.facts.isInternal,
            preBlockState,
          });
          const decision = guardTransition({
            actor: { kind: "user", roles },
            current: locked.current,
            facts: locked.facts,
            machineTarget,
            request: { kind: "manual", target: NewStatus as GuardStatus },
          });
          if (!decision.allowed) {
            await rollbackTransaction(connection).catch(() => {});
            return {
              status: decision.code === "role_not_permitted" ? 403 : 422,
              jsonBody: { code: decision.code, error: decision.reason, from: currentState.status, to: NewStatus },
            };
          }
          const target: JobState = { awaitingRole: decision.to.awaitingRole as AwaitingRole, status: decision.to.status as JobStatus };
          resolvedNewStatus = target.status;
          resolvedNewAwaitingRole = target.awaitingRole;
          expectedState = currentState;
          isRealTransition = target.status !== currentState.status || target.awaitingRole !== currentState.awaitingRole;
          if (target.status === JobStatus.TENANT) {
            preBlockToCapture = currentState;
          } else if (currentState.status === JobStatus.TENANT) {
            clearsPreBlock = true;
          }
        }
      }

      const inserted = await executeQuery(
        connection,
        `INSERT INTO JobEvents (
           JobID, CreatedBy, [Text], NewStatus, ExpectedProgressDate, IsStalled,
           EventType, PurchaseOrderID, QuoteID, InvoiceID, NewAssignee,
           NewAwaitingRole, CreationSource
         )
         OUTPUT INSERTED.JobEventID
         VALUES (
           @JobID, @CreatedBy, @Text, @NewStatus, @ExpectedProgressDate, @IsStalled,
           @EventType, @PurchaseOrderID, @QuoteID, @InvoiceID, @NewAssignee,
           @NewAwaitingRole, @CreationSource
         );`,
        [
          { name: "JobID", type: TYPES.Int, value: JobID },
          { name: "CreatedBy", type: TYPES.NVarChar, value: identity.name },
          { name: "Text", type: TYPES.NVarChar, value: Text ?? null },
          { name: "NewStatus", type: TYPES.NVarChar, value: resolvedNewStatus },
          { name: "ExpectedProgressDate", type: TYPES.DateTime2, value: ExpectedProgressDate ?? null },
          { name: "IsStalled", type: TYPES.Bit, value: isStalledBit },
          { name: "EventType", type: TYPES.NVarChar, value: EventType ?? null },
          { name: "PurchaseOrderID", type: TYPES.Int, value: PurchaseOrderID ?? null },
          { name: "QuoteID", type: TYPES.Int, value: QuoteID ?? null },
          { name: "InvoiceID", type: TYPES.Int, value: InvoiceID ?? null },
          { name: "NewAssignee", type: TYPES.NVarChar, value: NewAssignee ?? null },
          { name: "NewAwaitingRole", type: TYPES.NVarChar, value: resolvedNewAwaitingRole },
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
      if (resolvedNewStatus != null) {
        updates.push("Status=@Status");
        updateParams.push({ name: "Status", type: TYPES.NVarChar, value: resolvedNewStatus });
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
        updates.push("StalledAt=@StalledAtMirror");
        updateParams.push({
          name: "StalledAtMirror",
          type: TYPES.DateTime2,
          value: isStalledBit === 1 ? new Date() : null,
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
      if (NewAssigneeUserID != null) {
        updates.push("AssignedToUserID=@AssignedToUserIDMirror");
        updateParams.push({
          name: "AssignedToUserIDMirror",
          type: TYPES.Int,
          value: NewAssigneeUserID,
        });
      }
      if (resolvedNewAwaitingRole != null) {
        updates.push("AwaitingRole=@AwaitingRoleMirror");
        updateParams.push({
          name: "AwaitingRoleMirror",
          type: TYPES.NVarChar,
          value: resolvedNewAwaitingRole,
        });
      }
      if (preBlockToCapture != null) {
        updates.push("PreBlockStatus=@PreBlockStatus", "PreBlockAwaitingRole=@PreBlockAwaitingRole");
        updateParams.push(
          { name: "PreBlockStatus", type: TYPES.NVarChar, value: preBlockToCapture.status },
          { name: "PreBlockAwaitingRole", type: TYPES.NVarChar, value: preBlockToCapture.awaitingRole },
        );
      } else if (clearsPreBlock) {
        updates.push("PreBlockStatus=NULL", "PreBlockAwaitingRole=NULL");
      }
      // Acknowledge event (WP18a): stamp who/when in the same transaction as
      // the event; resets the escalation clock. Never alongside a real
      // transition, which clears it.
      if (EventType === "acknowledged" && !isRealTransition) {
        updates.push("AcknowledgedAt=SYSUTCDATETIME()", "AcknowledgedBy=@AcknowledgedBy");
        updateParams.push({
          name: "AcknowledgedBy",
          type: TYPES.NVarChar,
          value: identity.name,
        });
      }
      if (isRealTransition) {
        updates.push(
          "StatusSince=SYSUTCDATETIME()",
          "AcknowledgedAt=NULL",
          "AcknowledgedBy=NULL",
          "EscalatedAt=NULL",
        );
      }
      if (expectedState) {
        // Predicated on the state the guard decided on: if the job moved in
        // between (it can't while the row lock holds, but the write says so
        // itself), nothing lands and the caller is told.
        updateParams.push(
          { name: "ExpectedStatus", type: TYPES.NVarChar, value: expectedState.status },
          { name: "ExpectedAwaitingRole", type: TYPES.NVarChar, value: expectedState.awaitingRole },
        );
        const moved = await executeQuery(
          connection,
          `UPDATE Jobs SET ${updates.join(", ")}
           OUTPUT INSERTED.JobID
           WHERE JobID = @JobID AND Status = @ExpectedStatus AND ISNULL(AwaitingRole, 'facilities') = @ExpectedAwaitingRole`,
          updateParams,
        );
        if (moved.length === 0) {
          await rollbackTransaction(connection).catch(() => {});
          return {
            status: 409,
            jsonBody: { code: "job_changed", error: "This job changed while you were saving. Reload it and try again." },
          };
        }
      } else {
        await executeQuery(
          connection,
          `UPDATE Jobs SET ${updates.join(", ")} WHERE JobID = @JobID`,
          updateParams,
        );
      }

      // Service schedules (sprint F2, WP50): completing a scheduled job's work
      // moves its schedule on to the next due date of the anchor series.
      if (isRealTransition && isWorkCompletion(resolvedNewStatus, resolvedNewAwaitingRole)) {
        await markServiceJobCompleted(connection, JobID, identity.name);
      }

      await commitTransaction(connection);
    } catch (err) {
      await rollbackTransaction(connection).catch(() => {});
      throw err;
    }

      if (ExpectedProgressDate != null) {
        resolveActivePlannerTasks("job", JobID, ["job_update_due"]).catch(
          (err: unknown) =>
            context.warn("plannerResolve (addJobEvent):", err instanceof Error ? err.message : String(err)),
        );
      }
      if (isStalledBit === 0) {
        resolveActivePlannerTasks("job", JobID, ["stalled_facilities"]).catch(
          (err: unknown) =>
            context.warn("plannerResolve (stalled cleared):", err instanceof Error ? err.message : String(err)),
        );
      }
      // Key off the machine-resolved role actually written to the row, not the
      // caller's advisory NewAwaitingRole — the state machine may have resolved
      // a different role (or none), so the raw value can resolve/skip the
      // awaiting_accounts planner task against a value that was never persisted.
      if (resolvedNewAwaitingRole !== null && resolvedNewAwaitingRole !== undefined && resolvedNewAwaitingRole !== "accounts") {
        resolveActivePlannerTasks("job", JobID, ["awaiting_accounts"]).catch(
          (err: unknown) =>
            context.warn("plannerResolve (awaiting role changed):", err instanceof Error ? err.message : String(err)),
        );
      }
      if (NewStatus === "Done") {
        resolveActivePlannerTasks("job", JobID, ["stalled_facilities", "awaiting_accounts", "director_approval", "job_update_due"]).catch(
          (err: unknown) =>
            context.warn("plannerResolve (job done):", err instanceof Error ? err.message : String(err)),
        );
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

  const roleCheck = await requireRole(request, VIEW_JOBS_ROLES);
  if (roleCheck) return roleCheck;

  const jobIdStr = request.params.jobId;
  const jobId = Number(jobIdStr);
  if (!Number.isFinite(jobId)) {
    return { status: 400, jsonBody: { error: "jobId must be numeric" } };
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
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
