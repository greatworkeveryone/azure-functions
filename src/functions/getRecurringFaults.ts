// GET /api/getRecurringFaults?buildingId&assetId
//
// Recurring-fault signals (SC-AI5): the same asset, or the same trade on the
// same level of a building, with three or more jobs in the last year. Computed
// on read from existing records: no table, no model, nothing written. Jobs are
// counted when they are reactive or hand-raised maintenance work (the kinds
// that run the contractor flow), made in the last RECURRING_FAULT_WINDOW_DAYS
// Darwin days, not archived, not made by the scheduler (planned servicing is
// the plan, not the fault) and not test records unless an admin has Show test
// data on. Spend is approved incoming invoices, excluding GST. Read by whoever
// may see Maintenance and jobs (viewMaintenanceOverview). Response:
// RecurringFaultsResponse. Rules and grouping: src/recurringFaults.ts.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES, type Connection } from "tedious";
import { decideAuthority } from "../approvalAuthority";
import { loadApprovalFacts } from "../approvalAuthority-db";
import { parseQueryInt } from "../assetRegister";
import { authorize, badRequest, errorMessage } from "../assetRegisterSupport";
import { errorResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection, executeQuery, type SqlParam, type SqlRow } from "../db";
import { VIEW_FACILITIES_ROLES } from "../facilitiesRoles";
import { CONTRACTOR_FLOW_KINDS } from "../jobKinds";
import { MAX_LIST_ROWS } from "../pagination";
import { RECURRING_FAULT_MIN_JOBS, RECURRING_FAULT_WINDOW_DAYS } from "../recurringFaultConstants";
import {
  approvedCentsByJob,
  recurringGroups,
  toSignals,
  windowStartUtc,
  type FaultAsset,
  type FaultInvoice,
  type FaultJob,
  type RecurringFaultSignal,
} from "../recurringFaults";
import { SCHEDULED_CREATION_METHOD } from "../serviceScheduleRuns";
import { showTestParam } from "../test-data";

export interface RecurringFaultsResponse {
  /** Darwin date the signals were worked out on, YYYY-MM-DD. */
  generatedOn: string;
  minJobs: number;
  signals: RecurringFaultSignal[];
  /** The job read hit its ceiling, so the oldest jobs may be missing: ask for one building. */
  truncated: boolean;
  windowDays: number;
}

const MAX_ID = 2_147_483_647;
const KIND_PLACEHOLDERS = CONTRACTOR_FLOW_KINDS.map((_, index) => `@Kind${index}`).join(", ");

// Narrowed to the rules in the file header for volume; the rows say enough for
// recurringFaults.ts to group them. A job with two live assets comes back once
// per asset. Archived assets are kept, to tell "no asset" from "a retired one".
const JOBS = `SELECT TOP (${MAX_LIST_ROWS}) j.JobID, j.BuildingID, b.BuildingName, j.Title, j.Status, j.Kind, j.CreatedAt,
    j.Category, j.[Type], j.LevelName, ja.AssetId, a.Name AS AssetName, a.AssetTag, a.ArchivedAt AS AssetArchivedAt,
    l.Name AS LocationName, pl.Name AS ParentLocationName
  FROM dbo.Jobs j
  LEFT JOIN dbo.Buildings b ON b.BuildingID = j.BuildingID
  LEFT JOIN dbo.JobAssets ja ON ja.JobId = j.JobID AND ja.UnlinkedAt IS NULL
  LEFT JOIN dbo.Assets a ON a.AssetId = ja.AssetId
  LEFT JOIN dbo.Locations l ON l.LocationId = a.LocationId
  LEFT JOIN dbo.Locations pl ON pl.LocationId = l.ParentLocationId
  WHERE j.IsArchived = 0 AND (j.IsTest = 0 OR @ShowTest = 1)
    AND j.Kind IN (${KIND_PLACEHOLDERS}) AND j.CreationMethod <> @ScheduledMethod
    AND j.CreatedAt >= @Since
    AND (@BuildingId IS NULL OR j.BuildingID = @BuildingId)
    AND (@AssetId IS NULL OR ja.AssetId = @AssetId)
  ORDER BY j.CreatedAt DESC, j.JobID DESC`;

// Only the jobs inside a signal are looked up, as one JSON list of their ids.
const INVOICES = `SELECT i.JobID, i.Status, i.Amount
  FROM dbo.JobInvoices i
  WHERE i.JobID IN (SELECT CAST([value] AS INT) FROM OPENJSON(@JobIds))
    AND i.Direction = N'incoming' AND i.Status IN (N'approved', N'director_approved')
    AND (i.IsTest = 0 OR @ShowTest = 1)`;

function validId(value: number | undefined, allowNegative: boolean): boolean {
  if (value === undefined) return true;
  return Number.isSafeInteger(value) && value !== 0 && Math.abs(value) <= MAX_ID && (allowNegative || value > 0);
}

function toAsset(row: SqlRow): FaultAsset {
  const tag = row.AssetTag == null ? "" : String(row.AssetTag).trim();
  const name = String(row.AssetName ?? "").trim() || `Asset ${row.AssetId}`;
  const location = [row.ParentLocationName, row.LocationName].filter((part) => part != null && String(part).trim() !== "").map(String);
  return { id: Number(row.AssetId), label: tag ? `${name} (${tag})` : name, locationName: location.length > 0 ? location.join(" › ") : null };
}

/** One FaultJob per job: the rows of a job with several assets are folded together. */
function toJobs(rows: readonly SqlRow[]): FaultJob[] {
  const jobs = new Map<number, FaultJob>();
  for (const row of rows) {
    const id = Number(row.JobID);
    const job = jobs.get(id) ?? {
      assets: [],
      buildingId: Number(row.BuildingID),
      buildingName: String(row.BuildingName ?? "").trim() || `Building ${row.BuildingID}`,
      category: row.Category == null ? null : String(row.Category),
      createdAt: new Date(row.CreatedAt as Date),
      id,
      kind: String(row.Kind ?? "facilities"),
      levelName: row.LevelName == null ? null : String(row.LevelName),
      retiredAssetsOnly: false,
      status: String(row.Status ?? ""),
      title: String(row.Title ?? ""),
      type: row.Type == null ? null : String(row.Type),
    };
    if (row.AssetId != null) {
      if (row.AssetArchivedAt == null) job.assets = [...job.assets, toAsset(row)];
      else job.retiredAssetsOnly = true;
    }
    jobs.set(id, job);
  }
  return [...jobs.values()].map((job) => ({ ...job, retiredAssetsOnly: job.retiredAssetsOnly && job.assets.length === 0 }));
}

async function approvedSpend(connection: Connection, jobIds: readonly number[], showTest: SqlParam): Promise<Map<number, number>> {
  const rows = await executeQuery(connection, INVOICES, [{ name: "JobIds", type: TYPES.NVarChar, value: JSON.stringify(jobIds) }, showTest]);
  const invoices: FaultInvoice[] = rows.map((row) => ({
    amount: row.Amount == null ? null : Number(row.Amount),
    jobId: Number(row.JobID),
    status: String(row.Status),
  }));
  // The director rule is only needed to read a stage-1 approval, so the limits are loaded for those alone.
  const facts = invoices.some((invoice) => invoice.status === "approved") ? await loadApprovalFacts(connection, null) : null;
  const directorNeeded = (amount: number): boolean => facts !== null && decideAuthority({ amount, buildingId: 0, subject: "invoice" }, facts).directorRequired;
  return approvedCentsByJob(invoices, directorNeeded);
}

export async function getRecurringFaults(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const auth = await authorize(request, VIEW_FACILITIES_ROLES);
  if (!auth.ok) return auth.response;

  const buildingId = parseQueryInt(request.query.get("buildingId"), "buildingId");
  if (!buildingId.ok) return badRequest(buildingId.error);
  if (!validId(buildingId.value, true)) return badRequest("buildingId must be a building id");
  const assetId = parseQueryInt(request.query.get("assetId"), "assetId");
  if (!assetId.ok) return badRequest(assetId.error);
  if (!validId(assetId.value, false)) return badRequest("assetId must be an asset id");

  let connection: Connection | undefined;
  try {
    const today = todayInDarwin();
    const showTest = await showTestParam(request);
    connection = await createRequestConnection(auth.token);
    const params: SqlParam[] = [
      { name: "BuildingId", type: TYPES.Int, value: buildingId.value ?? null },
      { name: "AssetId", type: TYPES.Int, value: assetId.value ?? null },
      { name: "Since", type: TYPES.DateTime2, value: windowStartUtc(today) },
      { name: "ScheduledMethod", type: TYPES.NVarChar, value: SCHEDULED_CREATION_METHOD },
      showTest,
      ...CONTRACTOR_FLOW_KINDS.map((kind, index) => ({ name: `Kind${index}`, type: TYPES.NVarChar, value: kind })),
    ];
    // One query at a time: a tedious connection runs one request at once.
    const rows = await executeQuery(connection, JOBS, params);
    const groups = recurringGroups(toJobs(rows));
    const jobIds = [...new Set(groups.flatMap((group) => group.jobs.map((job) => job.id)))];
    const cents = jobIds.length > 0 ? await approvedSpend(connection, jobIds, showTest) : new Map<number, number>();
    const body: RecurringFaultsResponse = {
      generatedOn: today,
      minJobs: RECURRING_FAULT_MIN_JOBS,
      signals: toSignals(groups, cents),
      truncated: rows.length >= MAX_LIST_ROWS,
      windowDays: RECURRING_FAULT_WINDOW_DAYS,
    };
    if (body.truncated) context.warn(`getRecurringFaults: hit MAX_LIST_ROWS ceiling (${MAX_LIST_ROWS}) - the oldest jobs are missing`);
    return { jsonBody: body, status: 200 };
  } catch (error) {
    context.error("getRecurringFaults failed:", errorMessage(error));
    return errorResponse("Failed to load recurring faults", error);
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getRecurringFaults", { authLevel: "anonymous", handler: getRecurringFaults, methods: ["GET"] });
