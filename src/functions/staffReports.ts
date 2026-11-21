import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { authorizeWrite, badRequest, inTransaction, notFound, readJsonBody, txFail, txOk } from "../assetRegisterSupport";
import { ACTION_ROLES } from "../action-roles";
import { closeConnection, createRequestConnection, executeQuery } from "../db";
import { checkRateLimit } from "../rateLimit";
import { tooManyRequests } from "../rateLimitResponse";
import { parseStaffReport, reportStage, STAFF_REPORT_ID_BASE } from "../staffReports";

const REPORT_RATE_LIMIT = { limit: 10, windowMs: 60 * 60_000 };

// ── POST /api/createStaffReport ──────────────────────────────────────────────
// Body: { buildingId, details }. Files the problem in Job intake as a request marked as
// staff-reported. Writes only to our own table: nothing is sent to myBuildings.

export async function createStaffReport(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ACTION_ROLES.reportProblem.gate);
  if (!auth.ok) return auth.response;
  const limited = checkRateLimit(`staffReport:${auth.caller.oid}`, REPORT_RATE_LIMIT);
  if (!limited.allowed) return tooManyRequests(limited.retryAfterMs, "That is a lot of reports. Try again shortly.");
  const body = await readJsonBody(request);
  if (!body) return badRequest("JSON object required");
  let input;
  try {
    input = parseStaffReport(body);
  } catch (error) {
    return badRequest((error as Error).message);
  }
  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const conn = connection;
    const result = await inTransaction(conn, async () => {
      const building = await executeQuery(conn, "SELECT BuildingID, BuildingName FROM Buildings WHERE BuildingID = @Id", [
        { name: "Id", type: TYPES.Int, value: input.buildingId },
      ]);
      if (building.length === 0) return txFail(notFound("That building is not in Floorplan"));
      const next = await executeQuery(
        conn,
        "SELECT ISNULL(MAX(WorkRequestID), @Base - 1) + 1 AS NextId FROM dbo.WorkRequests WITH (UPDLOCK, HOLDLOCK) WHERE WorkRequestID >= @Base",
        [{ name: "Base", type: TYPES.Int, value: STAFF_REPORT_ID_BASE }],
      );
      const id = Number(next[0]?.NextId);
      await executeQuery(
        conn,
        `INSERT INTO dbo.WorkRequests
           (WorkRequestID, BuildingID, BuildingName, Details, StatusID, Status, Priority, ContactName, LastModifiedDate, Source, ReportedByOid, ReportedByName)
         VALUES (@Id, @BuildingId, @BuildingName, @Details, 1, N'New', N'Normal', @Name, @Now, N'staff', @Oid, @Name)`,
        [
          { name: "Id", type: TYPES.Int, value: id },
          { name: "BuildingId", type: TYPES.Int, value: input.buildingId },
          { name: "BuildingName", type: TYPES.NVarChar, value: building[0].BuildingName },
          { name: "Details", type: TYPES.NVarChar, value: input.details },
          { name: "Name", type: TYPES.NVarChar, value: auth.caller.name },
          { name: "Now", type: TYPES.NVarChar, value: new Date().toISOString() },
          { name: "Oid", type: TYPES.NVarChar, value: auth.caller.oid },
        ],
      );
      return txOk({ id, buildingName: building[0].BuildingName });
    });
    return result.ok ? { status: 200, jsonBody: { report: result.value } } : result.response;
  } catch (error) {
    context.error("createStaffReport failed:", (error as Error).message);
    return { status: 500, jsonBody: { error: "Couldn't send your report. Try again." } };
  } finally {
    if (connection) closeConnection(connection);
  }
}

// ── GET /api/getMyStaffReports ───────────────────────────────────────────────
// The caller's own reports, newest first, each with where it has got to. Filtered by the
// verified oid; there is no way to ask for someone else's.

export async function getMyStaffReports(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorizeWrite(request, ACTION_ROLES.reportProblem.gate);
  if (!auth.ok) return auth.response;
  let connection;
  try {
    connection = await createRequestConnection(auth.token);
    const rows = await executeQuery(
      connection,
      `SELECT TOP 100 wr.WorkRequestID, wr.BuildingName, wr.Details, wr.CreatedAt,
              j.JobID, j.Status AS JobStatus, j.IsArchived, j.CompletionDate
         FROM dbo.WorkRequests wr
         OUTER APPLY (SELECT TOP 1 JobID, Status, IsArchived, CompletionDate FROM dbo.Jobs
                       WHERE WorkRequestID = wr.WorkRequestID ORDER BY JobID DESC) j
        WHERE wr.ReportedByOid = @Oid
        ORDER BY wr.WorkRequestID DESC`,
      [{ name: "Oid", type: TYPES.NVarChar, value: auth.caller.oid }],
    );
    const reports = rows.map((row) => ({
      buildingName: row.BuildingName ?? null,
      closedAt: reportStage(row) === "closed" ? (row.CompletionDate ?? null) : null,
      details: row.Details ?? "",
      id: row.WorkRequestID,
      reportedAt: row.CreatedAt,
      stage: reportStage(row),
    }));
    return { status: 200, jsonBody: { reports } };
  } catch (error) {
    context.error("getMyStaffReports failed:", (error as Error).message);
    return { status: 500, jsonBody: { error: "Couldn't load your reports." } };
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("createStaffReport", { methods: ["POST"], authLevel: "anonymous", handler: createStaffReport });
app.http("getMyStaffReports", { methods: ["GET"], authLevel: "anonymous", handler: getMyStaffReports });
