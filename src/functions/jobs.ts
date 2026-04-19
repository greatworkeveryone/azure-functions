import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { createConnection, executeQuery, closeConnection, SqlRow } from "../db";
import { extractToken, unauthorizedResponse, errorResponse } from "../auth";

// ── Column lists ─────────────────────────────────────────────────────────────
// Keep one source of truth so SELECT shapes match what the frontend expects.

const JOB_COLUMNS = `
  JobID, BuildingID, WorkRequestID, Title, Description, AssignedTo,
  Status, IsStalled, ExpectedProgressUpdate, CompletionDate,
  CreatedAt, CreatedBy, LastModifiedDate
`;

const JOB_EVENT_COLUMNS = `
  JobEventID, JobID, CreatedAt, CreatedBy, [Text], NewStatus, ExpectedProgressDate, IsStalled
`;

// Editable job columns — the set an upsert payload may write. Anything else is
// ignored (CreatedAt, LastModifiedDate are managed server-side).
const JOB_WRITE_COLUMNS = [
  "BuildingID",
  "WorkRequestID",
  "Title",
  "Description",
  "AssignedTo",
  "Status",
  "IsStalled",
  "ExpectedProgressUpdate",
  "CompletionDate",
  "CreatedBy",
] as const;

type JobColumn = (typeof JOB_WRITE_COLUMNS)[number];

const COLUMN_TYPES: Record<JobColumn, any> = {
  BuildingID: TYPES.Int,
  WorkRequestID: TYPES.Int,
  Title: TYPES.NVarChar,
  Description: TYPES.NVarChar,
  AssignedTo: TYPES.NVarChar,
  Status: TYPES.NVarChar,
  IsStalled: TYPES.Bit,
  ExpectedProgressUpdate: TYPES.DateTime2,
  CompletionDate: TYPES.DateTime2,
  CreatedBy: TYPES.NVarChar,
};

function pickJobFields(body: any): Partial<Record<JobColumn, any>> {
  const out: Partial<Record<JobColumn, any>> = {};
  for (const col of JOB_WRITE_COLUMNS) {
    if (body[col] !== undefined) out[col] = body[col];
  }
  return out;
}

// ── Event-log fetch helper ───────────────────────────────────────────────────

async function fetchEventsForJobs(connection: any, jobIds: number[]): Promise<Record<number, SqlRow[]>> {
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

// ── GET /api/getJobs[?buildingId=x] ──────────────────────────────────────────

async function getJobs(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  const buildingId = request.query.get("buildingId");

  let connection;
  try {
    connection = await createConnection(token);

    const jobs = buildingId
      ? await executeQuery(
          connection,
          `SELECT ${JOB_COLUMNS} FROM Jobs WHERE BuildingID = @BuildingID ORDER BY LastModifiedDate DESC`,
          [{ name: "BuildingID", type: TYPES.Int, value: Number(buildingId) }],
        )
      : await executeQuery(
          connection,
          `SELECT ${JOB_COLUMNS} FROM Jobs ORDER BY LastModifiedDate DESC`,
        );

    const eventsByJob = await fetchEventsForJobs(connection, jobs.map((j) => j.JobID as number));
    const payload = jobs.map((j) => ({ ...j, Events: eventsByJob[j.JobID as number] ?? [] }));

    return { status: 200, jsonBody: { count: payload.length, jobs: payload } };
  } catch (error: any) {
    context.error("getJobs failed:", error.message);
    return errorResponse("Failed to fetch jobs", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getJob?jobId=x ──────────────────────────────────────────────────

async function getJob(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

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

  let connection;
  try {
    const body = (await request.json()) as any;
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

    connection = await createConnection(token);

    const params: any[] = [];
    for (const [k, v] of Object.entries(fields)) {
      params.push({ name: k, type: COLUMN_TYPES[k as JobColumn], value: v ?? null });
    }

    let newJobId: number;

    if (JobID === undefined) {
      // INSERT
      const cols = Object.keys(fields);
      const insertCols = cols.join(", ");
      const insertVals = cols.map((c) => `@${c}`).join(", ");
      const inserted = await executeQuery(
        connection,
        `INSERT INTO Jobs (${insertCols})
         OUTPUT INSERTED.JobID
         VALUES (${insertVals});`,
        params,
      );
      newJobId = inserted[0].JobID as number;
    } else {
      // UPDATE
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

// ── POST /api/deleteJob ──────────────────────────────────────────────────────
// Body: { JobID }. JobEvents cascade via FK.

async function deleteJob(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { JobID } = body ?? {};
    if (!JobID || typeof JobID !== "number") {
      return { status: 400, jsonBody: { error: "JobID (number) is required" } };
    }
    connection = await createConnection(token);
    await executeQuery(
      connection,
      "DELETE FROM Jobs WHERE JobID = @JobID",
      [{ name: "JobID", type: TYPES.Int, value: JobID }],
    );
    return { status: 200, jsonBody: { deleted: JobID } };
  } catch (error: any) {
    context.error("deleteJob failed:", error.message);
    return errorResponse("Delete failed", error.message);
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── POST /api/addJobEvent ────────────────────────────────────────────────────
// Body: { JobID, CreatedBy?, Text?, NewStatus?, ExpectedProgressDate?, IsStalled? }
// Appends one event; if NewStatus is set, also updates Jobs.Status. If
// ExpectedProgressDate is set, also updates Jobs.ExpectedProgressUpdate. If
// IsStalled is a boolean, also updates Jobs.IsStalled. Always bumps
// Jobs.LastModifiedDate.

async function addJobEvent(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();

  let connection;
  try {
    const body = (await request.json()) as any;
    const { JobID, CreatedBy, Text, NewStatus, ExpectedProgressDate, IsStalled } = body ?? {};
    if (!JobID || typeof JobID !== "number") {
      return { status: 400, jsonBody: { error: "JobID (number) is required" } };
    }
    if (
      Text == null &&
      NewStatus == null &&
      ExpectedProgressDate == null &&
      IsStalled == null
    ) {
      return {
        status: 400,
        jsonBody: {
          error: "Event must set at least one of: Text, NewStatus, ExpectedProgressDate, IsStalled",
        },
      };
    }
    const isStalledBit =
      IsStalled == null ? null : IsStalled ? 1 : 0;

    connection = await createConnection(token);

    const inserted = await executeQuery(
      connection,
      `INSERT INTO JobEvents (JobID, CreatedBy, [Text], NewStatus, ExpectedProgressDate, IsStalled)
       OUTPUT INSERTED.JobEventID
       VALUES (@JobID, @CreatedBy, @Text, @NewStatus, @ExpectedProgressDate, @IsStalled);`,
      [
        { name: "JobID", type: TYPES.Int, value: JobID },
        { name: "CreatedBy", type: TYPES.NVarChar, value: CreatedBy ?? null },
        { name: "Text", type: TYPES.NVarChar, value: Text ?? null },
        { name: "NewStatus", type: TYPES.NVarChar, value: NewStatus ?? null },
        { name: "ExpectedProgressDate", type: TYPES.DateTime2, value: ExpectedProgressDate ?? null },
        { name: "IsStalled", type: TYPES.Bit, value: isStalledBit },
      ],
    );
    if (inserted.length === 0) {
      return { status: 404, jsonBody: { error: "Job not found" } };
    }

    // Mirror the event's fields onto the parent Jobs row so list views stay current.
    const updates: string[] = ["LastModifiedDate=SYSUTCDATETIME()"];
    const updateParams: any[] = [{ name: "JobID", type: TYPES.Int, value: JobID }];
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
    await executeQuery(
      connection,
      `UPDATE Jobs SET ${updates.join(", ")} WHERE JobID = @JobID`,
      updateParams,
    );

    const eventRow = await executeQuery(
      connection,
      `SELECT ${JOB_EVENT_COLUMNS} FROM JobEvents WHERE JobEventID = @JobEventID`,
      [{ name: "JobEventID", type: TYPES.Int, value: inserted[0].JobEventID as number }],
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
app.http("deleteJob", { methods: ["POST"], authLevel: "anonymous", handler: deleteJob });
app.http("addJobEvent", { methods: ["POST"], authLevel: "anonymous", handler: addJobEvent });
