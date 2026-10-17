// Defects liability periods (LAUNCH-READINESS §5, WP47/WP48; sprint F1): the
// contract in one place. Validators, row -> API transforms and the queries the
// handlers, the job guard and the reminder run share. The rule itself
// (isJobCovered) is in ./facilitiesRules, mirrored on the frontend.
//
// Routes (one function per file in src/functions/):
//   GET  getDefectsPeriods      ?buildingId&includeArchived        view
//   GET  getDefectsPeriod       ?id                                view
//   POST upsertDefectsPeriod    DefectsPeriodInput (+ rowVersion)   manage
//   POST archiveDefectsPeriod   { defectsPeriodId, archived?, reason? }  manage

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlRow } from "./db";
import {
  ALL_SERVICES,
  DEFECTS_ENFORCEMENTS,
  DEFECTS_SCOPES,
  MAINTENANCE_SERVICES,
  isJobCovered,
  isPeriodActive,
  type CoverageJob,
  type CoveragePeriod,
  type DefectsEnforcement,
  type DefectsScope,
  type DefectsServices,
} from "./facilitiesRules";

// ── SQL ──────────────────────────────────────────────────────────────────────

/** The table's own columns (migration 119); a test keeps the two in step. */
export const DEFECTS_PERIOD_COLUMNS = `
  d.DefectsPeriodId, d.BuildingId, d.Scope, d.LevelName, d.LocationId, d.TenantId,
  d.Services, d.Works, d.ContractorId, d.ContractorContact, d.PracticalCompletion,
  d.EndsOn, d.Enforcement, d.Notes, d.CreatedAt, d.CreatedBy, d.UpdatedAt,
  d.UpdatedBy, d.ArchivedAt, d.ArchivedBy, d.RowVersion
`;

const PERIOD_JOINS = `
  LEFT JOIN dbo.Buildings b ON b.BuildingID = d.BuildingId
  LEFT JOIN dbo.Tenants t ON t.TenantID = d.TenantId
  LEFT JOIN dbo.Contractors c ON c.ContractorID = d.ContractorId`;
const SELECT_PERIOD = `SELECT ${DEFECTS_PERIOD_COLUMNS}, b.BuildingName, COALESCE(t.TradingName, t.LegalName) AS TenantName, c.ContractorName
  FROM dbo.DefectsPeriods d ${PERIOD_JOINS}`;
const SELECT_PERIOD_FOR_UPDATE = `SELECT ${DEFECTS_PERIOD_COLUMNS}, b.BuildingName, COALESCE(t.TradingName, t.LegalName) AS TenantName, c.ContractorName
  FROM dbo.DefectsPeriods d WITH (UPDLOCK, ROWLOCK) ${PERIOD_JOINS}`;
const LIST_ORDER = "ORDER BY d.EndsOn, d.DefectsPeriodId";
const LIST_SQL = {
  all: `${SELECT_PERIOD} ${LIST_ORDER}`,
  allLive: `${SELECT_PERIOD} WHERE d.ArchivedAt IS NULL ${LIST_ORDER}`,
  building: `${SELECT_PERIOD} WHERE d.BuildingId = @BuildingId ${LIST_ORDER}`,
  buildingLive: `${SELECT_PERIOD} WHERE d.BuildingId = @BuildingId AND d.ArchivedAt IS NULL ${LIST_ORDER}`,
} as const;

// ── API shapes ───────────────────────────────────────────────────────────────

export interface DefectsPeriodApi {
  /** Today (Darwin) is between practical completion and the end, and it is not archived. */
  active: boolean;
  /** Same as archivedAt !== null; lets an API period stand in for the rule's CoveragePeriod. */
  archived: boolean;
  archivedAt: string | null;
  archivedBy: string | null;
  buildingId: number;
  buildingName: string | null;
  contractorContact: string | null;
  contractorId: number | null;
  contractorName: string | null;
  createdAt: string | null;
  createdBy: string | null;
  defectsPeriodId: number;
  endsOn: string;
  enforcement: DefectsEnforcement;
  levelName: string | null;
  locationId: number | null;
  notes: string | null;
  practicalCompletion: string;
  rowVersion: string;
  scope: DefectsScope;
  services: DefectsServices;
  tenantId: number | null;
  tenantName: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  works: string;
}

export interface DefectsPeriodInput {
  buildingId: number;
  contractorContact: string | null;
  contractorId: number | null;
  defectsPeriodId: number | null;
  endsOn: string;
  enforcement: DefectsEnforcement;
  levelName: string | null;
  locationId: number | null;
  notes: string | null;
  practicalCompletion: string;
  rowVersion: string | null;
  scope: DefectsScope;
  services: DefectsServices;
  tenantId: number | null;
  works: string;
}

/** An open job a period covers (shown when a period is saved). */
export interface CoveredJobApi {
  jobId: number;
  status: string;
  title: string;
}

// ── Transforms ───────────────────────────────────────────────────────────────

const iso = (value: unknown): string | null => (value ? new Date(value as Date).toISOString() : null);
const isoDate = (value: unknown): string => (iso(value) ?? "").slice(0, 10);
const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export function parseServices(value: unknown): DefectsServices {
  if (value === ALL_SERVICES || value === null || value === undefined) return ALL_SERVICES;
  try {
    const parsed: unknown = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : ALL_SERVICES;
  } catch {
    return ALL_SERVICES;
  }
}

export function serviceText(services: DefectsServices): string {
  return services === ALL_SERVICES ? ALL_SERVICES : JSON.stringify(services);
}

export function periodRowToApi(row: SqlRow, today: string): DefectsPeriodApi {
  const api: DefectsPeriodApi = {
    active: false,
    archived: row.ArchivedAt !== null && row.ArchivedAt !== undefined,
    archivedAt: iso(row.ArchivedAt),
    archivedBy: text(row.ArchivedBy),
    buildingId: Number(row.BuildingId),
    buildingName: text(row.BuildingName),
    contractorContact: text(row.ContractorContact),
    contractorId: num(row.ContractorId),
    contractorName: text(row.ContractorName),
    createdAt: iso(row.CreatedAt),
    createdBy: text(row.CreatedBy),
    defectsPeriodId: Number(row.DefectsPeriodId),
    endsOn: isoDate(row.EndsOn),
    enforcement: row.Enforcement === "warn" ? "warn" : "block",
    levelName: text(row.LevelName),
    locationId: num(row.LocationId),
    notes: text(row.Notes),
    practicalCompletion: isoDate(row.PracticalCompletion),
    rowVersion: Buffer.isBuffer(row.RowVersion) ? row.RowVersion.toString("base64") : String(row.RowVersion ?? ""),
    scope: row.Scope as DefectsScope,
    services: parseServices(row.Services),
    tenantId: num(row.TenantId),
    tenantName: text(row.TenantName),
    updatedAt: iso(row.UpdatedAt),
    updatedBy: text(row.UpdatedBy),
    works: String(row.Works ?? ""),
  };
  api.active = isPeriodActive(toCoveragePeriod(api), today);
  return api;
}

export function toCoveragePeriod(period: DefectsPeriodApi): CoveragePeriod {
  return {
    archived: period.archived,
    buildingId: period.buildingId,
    endsOn: period.endsOn,
    levelName: period.levelName,
    locationId: period.locationId,
    practicalCompletion: period.practicalCompletion,
    scope: period.scope,
    services: period.services,
    tenantId: period.tenantId,
  };
}

/** "30/06/2027" from "2027-06-30". */
export function displayDate(isoDay: string): string {
  const [year, month, day] = isoDay.split("-");
  return `${day}/${month}/${year}`;
}

/** "HVAC / mechanical, Lifts" or "all services". */
export function servicesLabel(services: DefectsServices): string {
  return services === ALL_SERVICES ? "all services" : services.join(", ");
}

// ── Validation ───────────────────────────────────────────────────────────────

type Parsed<T> = { ok: true; value: T } | { error: string; ok: false };
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function optionalText(body: Record<string, unknown>, key: string, max: number): Parsed<string | null> {
  const value = body[key];
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { error: `${key} must be text`, ok: false };
  const trimmed = value.trim();
  if (trimmed.length > max) return { error: `${key} must be ${max} characters or fewer`, ok: false };
  return { ok: true, value: trimmed === "" ? null : trimmed };
}

function optionalId(body: Record<string, unknown>, key: string): Parsed<number | null> {
  const value = body[key];
  if (value === undefined || value === null) return { ok: true, value: null };
  return Number.isInteger(value) && (value as number) > 0 ? { ok: true, value: value as number } : { error: `${key} must be a positive whole number`, ok: false };
}

function parseServiceList(value: unknown): Parsed<DefectsServices> {
  if (value === ALL_SERVICES) return { ok: true, value: ALL_SERVICES };
  if (!Array.isArray(value) || value.length === 0) return { error: 'services must be "all" or a list of maintenance categories', ok: false };
  const known = new Set<string>(MAINTENANCE_SERVICES);
  const unknown = value.find((service) => typeof service !== "string" || !known.has(service));
  if (unknown !== undefined) return { error: `"${String(unknown)}" is not a maintenance category`, ok: false };
  return { ok: true, value: [...new Set(value as string[])] };
}

export function parseDefectsPeriodInput(body: Record<string, unknown>): Parsed<DefectsPeriodInput> {
  const id = optionalId(body, "defectsPeriodId");
  if (!id.ok) return id;
  if (id.value !== null && (typeof body.rowVersion !== "string" || body.rowVersion === "")) {
    return { error: "rowVersion is required when editing a defects period", ok: false };
  }
  if (!Number.isInteger(body.buildingId) || body.buildingId === 0) return { error: "buildingId is required", ok: false };
  const scope = body.scope as DefectsScope;
  if (!DEFECTS_SCOPES.includes(scope)) return { error: "scope must be building, level or tenancy", ok: false };
  const enforcement = (body.enforcement ?? "block") as DefectsEnforcement;
  if (!DEFECTS_ENFORCEMENTS.includes(enforcement)) return { error: "enforcement must be block or warn", ok: false };
  const services = parseServiceList(body.services);
  if (!services.ok) return services;
  const works = optionalText(body, "works", 200);
  if (!works.ok) return works;
  if (!works.value) return { error: "works is required (for example, Level 3 mechanical upgrade)", ok: false };
  const levelName = optionalText(body, "levelName", 100);
  const locationId = optionalId(body, "locationId");
  const tenantId = optionalId(body, "tenantId");
  const contractorId = optionalId(body, "contractorId");
  const contact = optionalText(body, "contractorContact", 400);
  const notes = optionalText(body, "notes", 2000);
  for (const field of [levelName, locationId, tenantId, contractorId, contact, notes]) if (!field.ok) return field;
  if (!isRealDate(body.practicalCompletion)) return { error: "practicalCompletion must be a date (YYYY-MM-DD)", ok: false };
  if (!isRealDate(body.endsOn)) return { error: "endsOn must be a date (YYYY-MM-DD)", ok: false };
  if (body.endsOn < body.practicalCompletion) return { error: "The end date can't be before practical completion", ok: false };
  if (scope === "level" && !levelName.ok) return levelName;
  const level = levelName.ok ? levelName.value : null;
  if (scope === "level" && !level) return { error: "Choose the level this period covers", ok: false };
  const tenant = tenantId.ok ? tenantId.value : null;
  if (scope === "tenancy" && tenant === null) return { error: "Choose the tenancy this period covers", ok: false };
  return {
    ok: true,
    value: {
      buildingId: body.buildingId as number,
      contractorContact: contact.ok ? contact.value : null,
      contractorId: contractorId.ok ? contractorId.value : null,
      defectsPeriodId: id.value,
      endsOn: body.endsOn,
      enforcement,
      levelName: scope === "level" ? level : null,
      locationId: scope === "level" && locationId.ok ? locationId.value : null,
      notes: notes.ok ? notes.value : null,
      practicalCompletion: body.practicalCompletion,
      rowVersion: id.value === null ? null : (body.rowVersion as string),
      scope,
      services: services.value,
      tenantId: scope === "tenancy" ? tenant : null,
      works: works.value,
    },
  };
}

export function parseArchiveInput(body: Record<string, unknown>): Parsed<{ archived: boolean; defectsPeriodId: number; reason: string | null }> {
  const id = optionalId(body, "defectsPeriodId");
  if (!id.ok || id.value === null) return { error: "defectsPeriodId is required", ok: false };
  if (body.archived !== undefined && typeof body.archived !== "boolean") return { error: "archived must be true or false", ok: false };
  const reason = optionalText(body, "reason", 500);
  if (!reason.ok) return reason;
  return { ok: true, value: { archived: body.archived !== false, defectsPeriodId: id.value, reason: reason.value } };
}

// ── Queries ──────────────────────────────────────────────────────────────────

export async function fetchPeriod(connection: Connection, id: number, forUpdate = false): Promise<SqlRow | null> {
  const params = [{ name: "Id", type: TYPES.Int, value: id }];
  const rows = forUpdate
    ? await executeQuery(connection, `${SELECT_PERIOD_FOR_UPDATE} WHERE d.DefectsPeriodId = @Id`, params)
    : await executeQuery(connection, `${SELECT_PERIOD} WHERE d.DefectsPeriodId = @Id`, params);
  return rows[0] ?? null;
}

export async function listPeriods(
  connection: Connection,
  filter: { buildingId: number | null; includeArchived: boolean },
): Promise<SqlRow[]> {
  if (filter.buildingId === null) {
    return executeQuery(connection, filter.includeArchived ? LIST_SQL.all : LIST_SQL.allLive, []);
  }
  const params = [{ name: "BuildingId", type: TYPES.Int, value: filter.buildingId }];
  return executeQuery(connection, filter.includeArchived ? LIST_SQL.building : LIST_SQL.buildingLive, params);
}

/** Live periods in one building that cover `today`. */
export async function livePeriodsForBuilding(connection: Connection, buildingId: number, today: string): Promise<DefectsPeriodApi[]> {
  const rows = await executeQuery(
    connection,
    `${SELECT_PERIOD}
     WHERE d.BuildingId = @BuildingId AND d.ArchivedAt IS NULL
       AND d.PracticalCompletion <= @Today AND d.EndsOn >= @Today`,
    [
      { name: "BuildingId", type: TYPES.Int, value: buildingId },
      { name: "Today", type: TYPES.Date, value: today },
    ],
  );
  return rows.map((row) => periodRowToApi(row, today));
}

/** A job row as the coverage rule reads it. */
export function jobRowToCoverage(row: SqlRow): CoverageJob {
  return {
    buildingId: Number(row.BuildingID),
    category: text(row.Category),
    kind: text(row.Kind),
    levelLocationId: null,
    levelName: text(row.LevelName),
    tenantId: num(row.TenantID),
    type: text(row.Type),
  };
}

/** Open (not Done, not archived) jobs in the period's building that it covers today. */
export async function coveredOpenJobs(connection: Connection, period: DefectsPeriodApi, today: string): Promise<CoveredJobApi[]> {
  const rows = await executeQuery(
    connection,
    `SELECT JobID, BuildingID, Title, Status, Kind, Category, [Type], LevelName, TenantID
       FROM dbo.Jobs
      WHERE BuildingID = @BuildingId AND IsArchived = 0 AND Status <> 'Done'
      ORDER BY JobID`,
    [{ name: "BuildingId", type: TYPES.Int, value: period.buildingId }],
  );
  const coverage = toCoveragePeriod(period);
  return rows
    .filter((row) => isJobCovered(jobRowToCoverage(row), coverage, today))
    .map((row) => ({ jobId: Number(row.JobID), status: String(row.Status ?? ""), title: String(row.Title ?? "") }));
}

/** The fields a ledger row snapshots (before / after). */
export function periodSnapshot(period: DefectsPeriodApi): Record<string, unknown> {
  return {
    archivedAt: period.archivedAt,
    contractorId: period.contractorId,
    endsOn: period.endsOn,
    enforcement: period.enforcement,
    levelName: period.levelName,
    notes: period.notes,
    practicalCompletion: period.practicalCompletion,
    scope: period.scope,
    services: period.services,
    tenantId: period.tenantId,
    works: period.works,
  };
}

/** Live periods ending between two dates, inclusive (the reminder run). */
export async function periodsEndingBetween(connection: Connection, from: string, to: string): Promise<SqlRow[]> {
  return executeQuery(
    connection,
    `${SELECT_PERIOD}
     WHERE d.ArchivedAt IS NULL AND d.EndsOn >= @From AND d.EndsOn <= @To
     ORDER BY d.EndsOn, d.DefectsPeriodId`,
    [
      { name: "From", type: TYPES.Date, value: from },
      { name: "To", type: TYPES.Date, value: to },
    ],
  );
}
