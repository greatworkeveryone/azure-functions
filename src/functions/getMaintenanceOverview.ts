// GET /api/getMaintenanceOverview?buildingId&days
//
// Everything the Maintenance page shows, assembled here (WP51, sprint F3): the
// services due in the next `days` (default 90, at most 365) and anything
// overdue, grouped by building then asset, each with its status (scheduled /
// job open / overdue, measured against the service's due date); when each
// asset was last serviced and its recent history (schedule runs and linked
// maintenance jobs, two years back); the defects periods in force; whether any
// schedule exists yet. Read by every operational role. Response:
// MaintenanceOverview (src/maintenanceOverview.ts).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { errorResponse } from "../auth";
import { authorize, badRequest, errorMessage } from "../assetRegisterSupport";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection, executeQuery, type SqlRow } from "../db";
import { listPeriods, periodRowToApi } from "../defectsPeriods";
import { VIEW_FACILITIES_ROLES } from "../facilitiesRoles";
import { addDays } from "../facilitiesRules";
import { assembleOverview, type OverviewLinkedJob, type OverviewRun } from "../maintenanceOverview";
import { schedulerMode } from "../schedulerMode";
import { SELECT_SCHEDULE, scheduleRowToApi } from "../serviceSchedules";
import { showTestParam } from "../test-data";

const DEFAULT_DAYS = 90;
const HISTORY_DAYS = 730;

const SCHEDULES_IN_WINDOW = `${SELECT_SCHEDULE}
  WHERE s.ArchivedAt IS NULL AND s.Active = 1 AND (@BuildingId IS NULL OR s.BuildingId = @BuildingId) AND s.NextDue <= @Until
  ORDER BY s.NextDue, s.ServiceScheduleId`;
const HAS_SCHEDULES = `SELECT COUNT(*) AS Total FROM dbo.ServiceSchedules
  WHERE ArchivedAt IS NULL AND (@BuildingId IS NULL OR BuildingId = @BuildingId)`;
const RUNS = `SELECT r.ServiceScheduleId, r.DueDate, r.JobId, r.Outcome, r.CompletedAt, r.Note,
    j.Status AS JobStatus, j.Title AS JobTitle, j.IsArchived AS JobArchived
  FROM dbo.ServiceScheduleRuns r
  JOIN dbo.ServiceSchedules s ON s.ServiceScheduleId = r.ServiceScheduleId
  LEFT JOIN dbo.Jobs j ON j.JobID = r.JobId
  WHERE s.ArchivedAt IS NULL AND (@BuildingId IS NULL OR s.BuildingId = @BuildingId) AND r.DueDate >= @Since`;
const LINKED_JOBS = `SELECT ja.AssetId, j.JobID, j.Title, j.Status, j.CompletionDate, j.LastModifiedDate
  FROM dbo.JobAssets ja
  JOIN dbo.Jobs j ON j.JobID = ja.JobId
  JOIN dbo.Assets a ON a.AssetId = ja.AssetId
  WHERE ja.UnlinkedAt IS NULL AND j.IsArchived = 0 AND j.Kind = 'maintenance' AND j.Status = 'Done'
    AND (@BuildingId IS NULL OR a.BuildingId = @BuildingId)
    AND COALESCE(j.CompletionDate, j.LastModifiedDate) >= @Since
    AND (j.IsTest = 0 OR @ShowTest = 1)`;

const isoDay = (value: unknown): string => (value ? new Date(value as Date).toISOString().slice(0, 10) : "");
const isoTime = (value: unknown): string | null => (value ? new Date(value as Date).toISOString() : null);

function toRun(row: SqlRow): OverviewRun {
  return {
    completedAt: isoTime(row.CompletedAt),
    dueDate: isoDay(row.DueDate),
    jobArchived: Boolean(row.JobArchived),
    jobId: row.JobId == null ? null : Number(row.JobId),
    jobStatus: row.JobStatus == null ? null : String(row.JobStatus),
    jobTitle: row.JobTitle == null ? null : String(row.JobTitle),
    note: row.Note == null ? null : String(row.Note),
    outcome: ["recorded", "skipped", "skipped_defects"].includes(String(row.Outcome)) ? (row.Outcome as OverviewRun["outcome"]) : "job_created",
    serviceScheduleId: Number(row.ServiceScheduleId),
  };
}

function toLinkedJob(row: SqlRow): OverviewLinkedJob {
  return {
    assetId: Number(row.AssetId),
    completedOn: isoDay(row.CompletionDate ?? row.LastModifiedDate),
    jobId: Number(row.JobID),
    jobStatus: String(row.Status ?? ""),
    jobTitle: String(row.Title ?? ""),
  };
}

export async function getMaintenanceOverview(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorize(request, VIEW_FACILITIES_ROLES);
  if (!auth.ok) return auth.response;

  const rawBuilding = request.query.get("buildingId");
  const buildingId = rawBuilding === null || rawBuilding === "" ? null : Number(rawBuilding);
  if (buildingId !== null && (!Number.isInteger(buildingId) || buildingId === 0)) return badRequest("buildingId must be a whole number");
  const rawDays = request.query.get("days");
  const days = rawDays === null || rawDays === "" ? DEFAULT_DAYS : Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > 365) return badRequest("days must be a whole number from 1 to 365");

  let connection: Connection | undefined;
  try {
    connection = await createRequestConnection(auth.token);
    const today = todayInDarwin();
    const scope = { name: "BuildingId", type: TYPES.Int, value: buildingId };
    const since = { name: "Since", type: TYPES.Date, value: addDays(today, -HISTORY_DAYS) };
    // One query at a time: a tedious connection runs one request at once.
    const schedules = await executeQuery(connection, SCHEDULES_IN_WINDOW, [scope, { name: "Until", type: TYPES.Date, value: addDays(today, days) }]);
    const has = await executeQuery(connection, HAS_SCHEDULES, [scope]);
    const runs = await executeQuery(connection, RUNS, [scope, since]);
    const linked = await executeQuery(connection, LINKED_JOBS, [scope, since, await showTestParam(request)]);
    const periods = await listPeriods(connection, { buildingId, includeArchived: false });
    const overview = assembleOverview({
      days,
      hasSchedules: Number(has[0]?.Total ?? 0) > 0,
      scheduleCount: Number(has[0]?.Total ?? 0),
      linkedJobs: linked.map(toLinkedJob),
      periods: periods.map((row) => periodRowToApi(row, today)).filter((period) => period.active),
      runs: runs.map(toRun),
      schedulerMode: schedulerMode(),
      schedules: schedules.map((row) => scheduleRowToApi(row, today)),
      today,
    });
    return { jsonBody: overview, status: 200 };
  } catch (error) {
    context.error("getMaintenanceOverview failed:", errorMessage(error));
    return errorResponse("Failed to load the maintenance overview", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getMaintenanceOverview", { authLevel: "anonymous", handler: getMaintenanceOverview, methods: ["GET"] });
