// Contractor suggestions (SC-AI3): the reads behind the feature vector. Every
// query is parameterised and selects named columns; none writes. A contractor is
// a candidate only when active and not suspended (`@ActiveOnly`), and the same
// reads serve a single contractor by id when an outcome is recorded for someone
// who was not suggested, so both paths compute features the same way.

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "../db";
import type { CertificateRecord, ContractorProfile, Engagement } from "./features";

export interface JobRow {
  buildingId: number;
  category: string | null;
  isInternal: boolean;
  isTest: boolean;
  jobId: number;
}

export interface BuildingRow {
  buildingId: number;
  region: string | null;
}

export interface PoolContractor {
  contractorId: number;
  name: string;
}

/** Which contractors a read covers: everyone who may be suggested, or exactly these. */
export type Who = { activeOnly: true; ids: null } | { activeOnly: false; ids: readonly number[] };
export const WHO_POOL: Who = { activeOnly: true, ids: null };

const JOB_SQL = `SELECT JobID, BuildingID, Category, IsInternal, IsTest FROM dbo.Jobs WHERE JobID = @JobID`;
const BUILDING_SQL = `SELECT BuildingID, Region FROM dbo.Buildings WHERE BuildingID = @BuildingId`;
const PLAN_SQL = `SELECT PlanJson FROM dbo.MaintenanceCoverage WHERE BuildingId = @BuildingId`;
const PROFILES_SQL = `SELECT ContractorId, CoverageJson FROM dbo.ContractorCoverage`;
const POOL_SQL = `SELECT ContractorID, ContractorName FROM dbo.Contractors WHERE Active = 1 AND Suspended = 0`;
const REQUESTED_SQL = `SELECT ContractorID FROM dbo.JobRequestedContractors WHERE JobID = @JobID AND ContractorID IS NOT NULL`;

// Both sides of "who": the optional id list is JSON, bound as one parameter.
const WHO_FILTER = `(@Ids IS NULL OR c.ContractorID IN (SELECT CAST([value] AS INT) FROM OPENJSON(@Ids)))
  AND (@ActiveOnly = 0 OR (c.Active = 1 AND c.Suspended = 0))`;

const CERTIFICATES_SQL = `SELECT d.ContractorId, d.BuildingId, d.InsuranceType, d.IssuedOn, d.ExpiresOn
  FROM dbo.RegisterDocuments d
  JOIN dbo.Contractors c ON c.ContractorID = d.ContractorId
  WHERE d.ContractorId IS NOT NULL AND d.Kind = 'certificate' AND d.ServiceCategory = 'Insurance' AND d.ArchivedAt IS NULL
    AND ${WHO_FILTER}`;

// A contractor is engaged on a job through a purchase order or the job's approved
// quote. Jobs at this building at any time (for "days since the last job here"), and
// jobs raised or done anywhere in the last 12 months (for the trade and speed figures).
const ENGAGEMENTS_SQL = `SELECT e.ContractorID, j.JobID, j.BuildingID, j.Category, j.CreatedAt,
    CASE WHEN j.Status = 'Done' THEN COALESCE(j.CompletionDate, j.StatusSince) END AS DoneAt
  FROM (
    SELECT po.JobID, po.ContractorID FROM dbo.PurchaseOrders po
     WHERE po.ContractorID IS NOT NULL AND (po.IsTest = 0 OR @ShowTest = 1)
    UNION
    SELECT q.JobID, q.ContractorID FROM dbo.Quotes q
     WHERE q.ContractorID IS NOT NULL AND q.Status IN ('approved', 'completed') AND (q.IsTest = 0 OR @ShowTest = 1)
  ) e
  JOIN dbo.Jobs j ON j.JobID = e.JobID
  JOIN dbo.Contractors c ON c.ContractorID = e.ContractorID
  WHERE (j.IsTest = 0 OR @ShowTest = 1)
    AND (j.BuildingID = @BuildingId OR j.CreatedAt >= @Since OR COALESCE(j.CompletionDate, j.StatusSince) >= @Since)
    AND ${WHO_FILTER}`;

const QUOTE_STATUSES_SQL = `SELECT q.ContractorID, q.Status
  FROM dbo.Quotes q
  JOIN dbo.Jobs j ON j.JobID = q.JobID
  JOIN dbo.Contractors c ON c.ContractorID = q.ContractorID
  WHERE q.ContractorID IS NOT NULL AND q.CreatedAt >= @Since
    AND (q.IsTest = 0 OR @ShowTest = 1) AND (j.IsTest = 0 OR @ShowTest = 1)
    AND ${WHO_FILTER}`;

const flag = (value: SqlRow[string]): boolean => value === true || value === 1;
const idsParam = (who: Who): SqlParam => ({ name: "Ids", type: TYPES.NVarChar, value: who.ids === null ? null : JSON.stringify(who.ids) });
const whoParams = (who: Who): SqlParam[] => [idsParam(who), { name: "ActiveOnly", type: TYPES.Bit, value: who.activeOnly }];

/** DATE columns come back as a Date at UTC midnight; the register stores them as plain dates. */
function isoDate(value: unknown): string | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
}

function parseJson(text: unknown): unknown {
  try {
    return typeof text === "string" ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export async function loadJob(connection: Connection, jobId: number): Promise<JobRow | null> {
  const [row] = await executeQuery(connection, JOB_SQL, [{ name: "JobID", type: TYPES.Int, value: jobId }]);
  if (!row) return null;
  return {
    buildingId: Number(row.BuildingID),
    category: (row.Category as string | null) ?? null,
    isInternal: flag(row.IsInternal),
    isTest: flag(row.IsTest),
    jobId: Number(row.JobID),
  };
}

export async function loadBuilding(connection: Connection, buildingId: number): Promise<BuildingRow | null> {
  const [row] = await executeQuery(connection, BUILDING_SQL, [{ name: "BuildingId", type: TYPES.Int, value: buildingId }]);
  return row ? { buildingId: Number(row.BuildingID), region: (row.Region as string | null) ?? null } : null;
}

/** The building's trade-to-contractors plan as stored (migration 155); null when none is recorded. */
export async function loadAssignmentPlan(connection: Connection, buildingId: number): Promise<unknown> {
  const [row] = await executeQuery(connection, PLAN_SQL, [{ name: "BuildingId", type: TYPES.Int, value: buildingId }]);
  return row ? parseJson(row.PlanJson) : null;
}

/** Confirmed regions and trades per contractor (migration 156); a contractor with no row has no profile. */
export async function loadProfiles(connection: Connection): Promise<Map<number, ContractorProfile>> {
  const profiles = new Map<number, ContractorProfile>();
  for (const row of await executeQuery(connection, PROFILES_SQL)) {
    const json = parseJson(row.CoverageJson) as { regions?: unknown; trades?: unknown } | null;
    const strings = (value: unknown): string[] => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []);
    profiles.set(Number(row.ContractorId), { regions: strings(json?.regions), trades: strings(json?.trades) });
  }
  return profiles;
}

export async function loadPool(connection: Connection): Promise<PoolContractor[]> {
  const rows = await executeQuery(connection, POOL_SQL);
  return rows.map((row) => ({
    contractorId: Number(row.ContractorID),
    name: (row.ContractorName as string | null)?.trim() || `Contractor #${row.ContractorID}`,
  }));
}

/** Contractors already asked to quote on this job: they are not offered again for a quote request. */
export async function loadRequestedContractorIds(connection: Connection, jobId: number): Promise<Set<number>> {
  const rows = await executeQuery(connection, REQUESTED_SQL, [{ name: "JobID", type: TYPES.Int, value: jobId }]);
  return new Set(rows.map((row) => Number(row.ContractorID)));
}

function group<T>(rows: SqlRow[], keyOf: (row: SqlRow) => number, make: (row: SqlRow) => T | null): Map<number, T[]> {
  const out = new Map<number, T[]>();
  for (const row of rows) {
    const made = make(row);
    if (made !== null) out.set(keyOf(row), [...(out.get(keyOf(row)) ?? []), made]);
  }
  return out;
}

export async function loadCertificates(connection: Connection, who: Who): Promise<Map<number, CertificateRecord[]>> {
  const rows = await executeQuery(connection, CERTIFICATES_SQL, whoParams(who));
  return group(rows, (row) => Number(row.ContractorId), (row) => ({
    buildingId: row.BuildingId === null || row.BuildingId === undefined ? null : Number(row.BuildingId),
    expiresOn: isoDate(row.ExpiresOn),
    insuranceType: (row.InsuranceType as string | null) ?? null,
    issuedOn: isoDate(row.IssuedOn),
  }));
}

export async function loadEngagements(
  connection: Connection,
  args: { buildingId: number; showTest: boolean; since: Date; who: Who },
): Promise<Map<number, Engagement[]>> {
  const rows = await executeQuery(connection, ENGAGEMENTS_SQL, [
    { name: "BuildingId", type: TYPES.Int, value: args.buildingId },
    { name: "Since", type: TYPES.DateTime2, value: args.since },
    { name: "ShowTest", type: TYPES.Bit, value: args.showTest },
    ...whoParams(args.who),
  ]);
  return group(rows, (row) => Number(row.ContractorID), (row) => ({
    buildingId: Number(row.BuildingID),
    category: (row.Category as string | null) ?? null,
    createdAt: row.CreatedAt as Date,
    doneAt: (row.DoneAt as Date | null) ?? null,
    jobId: Number(row.JobID),
  }));
}

export async function loadQuoteStatuses(
  connection: Connection,
  args: { showTest: boolean; since: Date; who: Who },
): Promise<Map<number, string[]>> {
  const rows = await executeQuery(connection, QUOTE_STATUSES_SQL, [
    { name: "Since", type: TYPES.DateTime2, value: args.since },
    { name: "ShowTest", type: TYPES.Bit, value: args.showTest },
    ...whoParams(args.who),
  ]);
  return group(rows, (row) => Number(row.ContractorID), (row) => String(row.Status ?? ""));
}
