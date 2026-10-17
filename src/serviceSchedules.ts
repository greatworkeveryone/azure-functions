// Service schedules (WP50; sprint F2): the contract in one place. Validators,
// row -> API transforms and the queries the handlers, the scheduler and the
// overview share. The date arithmetic is in ./facilitiesRules (mirrored on the
// frontend).
//
// Routes (one function per file in src/functions/):
//   GET  getServiceSchedules       ?buildingId&assetId&category&dueBefore&includeArchived   view
//   GET  getServiceSchedule        ?id  (+ its runs)                                        view
//   POST upsertServiceSchedule     ScheduleInput (+ rowVersion)                             manage
//   POST archiveServiceSchedule    { serviceScheduleId, archived?, reason? }                manage
//   POST runSchedulerNow           { dryRun? }                                              admin
//   GET  getServiceScheduleTemplate  xlsx                                                   manage
//   POST importServiceSchedules    multipart file (xlsx, <= 10 MB), ?dryRun=true             manage

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "./db";
import {
  DEFAULT_LEAD_DAYS,
  INTERVAL_UNITS,
  MAINTENANCE_SERVICES,
  isServiceOverdue,
  isUrgentService,
  addDays,
  type CoverageJob,
  type IntervalUnit,
  type ServiceSeries,
} from "./facilitiesRules";

/** The table's own columns (migration 120); a test keeps the two in step. */
export const SCHEDULE_COLUMNS = `
  s.ServiceScheduleId, s.BuildingId, s.AssetId, s.LocationId, s.Scope, s.Category, s.Name,
  s.ContractorId, s.IsContract, s.IntervalCount, s.IntervalUnit, s.AnchorDate, s.LeadDays,
  s.NextDue, s.LastCompletedJobId, s.Active, s.Notes, s.CreatedAt, s.CreatedBy, s.UpdatedAt,
  s.UpdatedBy, s.ArchivedAt, s.ArchivedBy, s.RowVersion
`;

// The schedule's place: its own location, else its asset's. A space's level is
// its parent when the parent is a level.
const SCHEDULE_JOINS = `
  LEFT JOIN dbo.Buildings b ON b.BuildingID = s.BuildingId
  LEFT JOIN dbo.Assets a ON a.AssetId = s.AssetId
  LEFT JOIN dbo.Locations l ON l.LocationId = COALESCE(s.LocationId, a.LocationId)
  LEFT JOIN dbo.Locations pl ON pl.LocationId = l.ParentLocationId
  LEFT JOIN dbo.Contractors c ON c.ContractorID = s.ContractorId`;
const SCHEDULE_EXTRAS = `b.BuildingName, a.Name AS AssetName, a.AssetTag, l.Name AS LocationName,
  CASE WHEN l.Kind = 'level' THEN l.LocationId WHEN pl.Kind = 'level' THEN pl.LocationId END AS LevelLocationId,
  CASE WHEN l.Kind = 'level' THEN l.Name WHEN pl.Kind = 'level' THEN pl.Name END AS LevelName,
  c.ContractorName`;
export const SELECT_SCHEDULE = `SELECT ${SCHEDULE_COLUMNS}, ${SCHEDULE_EXTRAS} FROM dbo.ServiceSchedules s ${SCHEDULE_JOINS}`;
const SELECT_SCHEDULE_FOR_UPDATE = `SELECT ${SCHEDULE_COLUMNS}, ${SCHEDULE_EXTRAS} FROM dbo.ServiceSchedules s WITH (UPDLOCK, ROWLOCK) ${SCHEDULE_JOINS}`;

export interface ScheduleApi {
  active: boolean;
  anchorDate: string;
  archived: boolean;
  archivedAt: string | null;
  archivedBy: string | null;
  assetId: number | null;
  assetName: string | null;
  assetTag: string | null;
  buildingId: number;
  buildingName: string | null;
  category: string;
  contractorId: number | null;
  contractorName: string | null;
  createdAt: string | null;
  createdBy: string | null;
  /** The date the scheduler creates the next job (NextDue - LeadDays). */
  generatesOn: string;
  intervalCount: number;
  intervalUnit: IntervalUnit;
  isContract: boolean;
  lastCompletedJobId: number | null;
  leadDays: number;
  levelLocationId: number | null;
  levelName: string | null;
  locationId: number | null;
  locationName: string | null;
  name: string;
  nextDue: string;
  notes: string | null;
  /** NextDue has passed and the service isn't done (active, live schedules only). */
  overdue: boolean;
  rowVersion: string;
  scope: string | null;
  serviceScheduleId: number;
  updatedAt: string | null;
  updatedBy: string | null;
  /** Overdue servicing in this category escalates as urgent. */
  urgent: boolean;
}

const iso = (value: unknown): string | null => (value ? new Date(value as Date).toISOString() : null);
const isoDate = (value: unknown): string => (iso(value) ?? "").slice(0, 10);
const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export function scheduleRowToApi(row: SqlRow, today: string): ScheduleApi {
  const nextDue = isoDate(row.NextDue);
  const archived = row.ArchivedAt !== null && row.ArchivedAt !== undefined;
  const active = Boolean(row.Active);
  const leadDays = Number(row.LeadDays ?? DEFAULT_LEAD_DAYS);
  return {
    active,
    anchorDate: isoDate(row.AnchorDate),
    archived,
    archivedAt: iso(row.ArchivedAt),
    archivedBy: text(row.ArchivedBy),
    assetId: num(row.AssetId),
    assetName: text(row.AssetName),
    assetTag: text(row.AssetTag),
    buildingId: Number(row.BuildingId),
    buildingName: text(row.BuildingName),
    category: String(row.Category ?? ""),
    contractorId: num(row.ContractorId),
    contractorName: text(row.ContractorName),
    createdAt: iso(row.CreatedAt),
    createdBy: text(row.CreatedBy),
    generatesOn: addDays(nextDue, -leadDays),
    intervalCount: Number(row.IntervalCount),
    intervalUnit: row.IntervalUnit === "weeks" ? "weeks" : "months",
    isContract: Boolean(row.IsContract),
    lastCompletedJobId: num(row.LastCompletedJobId),
    leadDays,
    levelLocationId: num(row.LevelLocationId),
    levelName: text(row.LevelName),
    locationId: num(row.LocationId),
    locationName: text(row.LocationName),
    name: String(row.Name ?? ""),
    nextDue,
    notes: text(row.Notes),
    overdue: active && !archived && isServiceOverdue(nextDue, today),
    rowVersion: Buffer.isBuffer(row.RowVersion) ? row.RowVersion.toString("base64") : String(row.RowVersion ?? ""),
    scope: text(row.Scope),
    serviceScheduleId: Number(row.ServiceScheduleId),
    updatedAt: iso(row.UpdatedAt),
    updatedBy: text(row.UpdatedBy),
    urgent: isUrgentService(text(row.Category)),
  };
}

export function seriesOf(schedule: Pick<ScheduleApi, "anchorDate" | "intervalCount" | "intervalUnit">): ServiceSeries {
  return { anchorDate: schedule.anchorDate, intervalCount: schedule.intervalCount, intervalUnit: schedule.intervalUnit };
}

/** "Chiller 1 (CH-01)", else the described scope. */
export function scheduleTarget(schedule: Pick<ScheduleApi, "assetName" | "assetTag" | "scope">): string | null {
  if (schedule.assetName) return schedule.assetTag ? `${schedule.assetName} (${schedule.assetTag})` : schedule.assetName;
  return schedule.scope;
}

/** The job this schedule would create, as the defects rule reads it. */
export function scheduleCoverageJob(schedule: ScheduleApi): CoverageJob {
  return {
    buildingId: schedule.buildingId,
    category: schedule.category,
    kind: "maintenance",
    levelLocationId: schedule.levelLocationId,
    levelName: schedule.levelName,
    tenantId: null,
    type: null,
  };
}

export function scheduleSnapshot(schedule: ScheduleApi): Record<string, unknown> {
  return {
    active: schedule.active,
    anchorDate: schedule.anchorDate,
    archivedAt: schedule.archivedAt,
    assetId: schedule.assetId,
    category: schedule.category,
    contractorId: schedule.contractorId,
    intervalCount: schedule.intervalCount,
    intervalUnit: schedule.intervalUnit,
    isContract: schedule.isContract,
    leadDays: schedule.leadDays,
    name: schedule.name,
    nextDue: schedule.nextDue,
    scope: schedule.scope,
  };
}

// ── Validation ───────────────────────────────────────────────────────────────

export interface ScheduleInput {
  active: boolean;
  anchorDate: string;
  assetId: number | null;
  buildingId: number;
  category: string;
  contractorId: number | null;
  intervalCount: number;
  intervalUnit: IntervalUnit;
  isContract: boolean;
  leadDays: number;
  locationId: number | null;
  name: string;
  /** Optional on create: the first due date when it isn't the first occurrence from today. */
  nextDue: string | null;
  notes: string | null;
  rowVersion: string | null;
  scope: string | null;
  serviceScheduleId: number | null;
}

type Parsed<T> = { ok: true; value: T } | { error: string; ok: false };

export function isRealDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function optionalText(value: unknown, key: string, max: number): Parsed<string | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { error: `${key} must be text`, ok: false };
  const trimmed = value.trim();
  if (trimmed.length > max) return { error: `${key} must be ${max} characters or fewer`, ok: false };
  return { ok: true, value: trimmed || null };
}

function optionalId(value: unknown, key: string): Parsed<number | null> {
  if (value === undefined || value === null) return { ok: true, value: null };
  return Number.isInteger(value) && (value as number) > 0 ? { ok: true, value: value as number } : { error: `${key} must be a positive whole number`, ok: false };
}

function optionalBool(value: unknown, key: string, fallback: boolean): Parsed<boolean> {
  if (value === undefined || value === null) return { ok: true, value: fallback };
  return typeof value === "boolean" ? { ok: true, value } : { error: `${key} must be true or false`, ok: false };
}

export function parseScheduleInput(body: Record<string, unknown>): Parsed<ScheduleInput> {
  const id = optionalId(body.serviceScheduleId, "serviceScheduleId");
  if (!id.ok) return id;
  if (id.value !== null && (typeof body.rowVersion !== "string" || body.rowVersion === "")) {
    return { error: "rowVersion is required when editing a schedule", ok: false };
  }
  if (!Number.isInteger(body.buildingId) || body.buildingId === 0) return { error: "buildingId is required", ok: false };
  const name = optionalText(body.name, "name", 200);
  if (!name.ok) return name;
  if (!name.value) return { error: "name is required (for example, Six-monthly chiller service)", ok: false };
  if (typeof body.category !== "string" || !(MAINTENANCE_SERVICES as readonly string[]).includes(body.category)) {
    return { error: "category must be one of the maintenance categories", ok: false };
  }
  const assetId = optionalId(body.assetId, "assetId");
  const locationId = optionalId(body.locationId, "locationId");
  const contractorId = optionalId(body.contractorId, "contractorId");
  const scope = optionalText(body.scope, "scope", 200);
  const notes = optionalText(body.notes, "notes", 2000);
  const isContract = optionalBool(body.isContract, "isContract", false);
  const active = optionalBool(body.active, "active", true);
  for (const field of [assetId, locationId, contractorId, scope, notes, isContract, active]) if (!field.ok) return field;
  if (!assetId.ok || !scope.ok || (assetId.value === null && scope.value === null)) {
    return { error: "Choose the asset this service is for, or describe what is serviced", ok: false };
  }
  const unit = body.intervalUnit as IntervalUnit;
  if (!INTERVAL_UNITS.includes(unit)) return { error: "intervalUnit must be weeks or months", ok: false };
  const count = body.intervalCount;
  if (!Number.isInteger(count) || (count as number) < 1 || (count as number) > 520) {
    return { error: "intervalCount must be a whole number from 1 to 520", ok: false };
  }
  if (!isRealDate(body.anchorDate)) return { error: "anchorDate must be a date (YYYY-MM-DD)", ok: false };
  const lead = body.leadDays ?? DEFAULT_LEAD_DAYS;
  if (!Number.isInteger(lead) || (lead as number) < 0 || (lead as number) > 365) {
    return { error: "leadDays must be a whole number from 0 to 365", ok: false };
  }
  if (body.nextDue !== undefined && body.nextDue !== null && !isRealDate(body.nextDue)) {
    return { error: "nextDue must be a date (YYYY-MM-DD)", ok: false };
  }
  return {
    ok: true,
    value: {
      active: active.ok ? active.value : true,
      anchorDate: body.anchorDate,
      assetId: assetId.value,
      buildingId: body.buildingId as number,
      category: body.category,
      contractorId: contractorId.ok ? contractorId.value : null,
      intervalCount: count as number,
      intervalUnit: unit,
      isContract: isContract.ok ? isContract.value : false,
      leadDays: lead as number,
      locationId: locationId.ok ? locationId.value : null,
      name: name.value,
      nextDue: (body.nextDue as string | null | undefined) ?? null,
      notes: notes.ok ? notes.value : null,
      rowVersion: id.value === null ? null : (body.rowVersion as string),
      scope: scope.value,
      serviceScheduleId: id.value,
    },
  };
}

// ── Queries ──────────────────────────────────────────────────────────────────

export async function fetchSchedule(connection: Connection, id: number, forUpdate = false): Promise<SqlRow | null> {
  const params = [{ name: "Id", type: TYPES.Int, value: id }];
  const rows = forUpdate
    ? await executeQuery(connection, `${SELECT_SCHEDULE_FOR_UPDATE} WHERE s.ServiceScheduleId = @Id`, params)
    : await executeQuery(connection, `${SELECT_SCHEDULE} WHERE s.ServiceScheduleId = @Id`, params);
  return rows[0] ?? null;
}

export interface ScheduleFilter {
  assetId: number | null;
  buildingId: number | null;
  category: string | null;
  dueBefore: string | null;
  includeArchived: boolean;
}

const LIST_SCHEDULES = `${SELECT_SCHEDULE}
  WHERE (@BuildingId IS NULL OR s.BuildingId = @BuildingId)
    AND (@AssetId IS NULL OR s.AssetId = @AssetId)
    AND (@Category IS NULL OR s.Category = @Category)
    AND (@DueBefore IS NULL OR s.NextDue <= @DueBefore)
    AND (@IncludeArchived = 1 OR s.ArchivedAt IS NULL)
  ORDER BY s.NextDue, s.ServiceScheduleId`;

export async function listSchedules(connection: Connection, filter: ScheduleFilter): Promise<SqlRow[]> {
  const params: SqlParam[] = [
    { name: "BuildingId", type: TYPES.Int, value: filter.buildingId },
    { name: "AssetId", type: TYPES.Int, value: filter.assetId },
    { name: "Category", type: TYPES.NVarChar, value: filter.category },
    { name: "DueBefore", type: TYPES.Date, value: filter.dueBefore },
    { name: "IncludeArchived", type: TYPES.Bit, value: filter.includeArchived },
  ];
  return executeQuery(connection, LIST_SCHEDULES, params);
}
