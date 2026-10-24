// Inbound email triage (EB3): the reads behind routing. Every query is parameterised and selects
// named columns; none writes. Sections: who may be chosen (staff, leave, sign-ins), who wrote the
// email (tenancy contact, contractor), what it names (a job, a building, a tenancy), and the job
// history that becomes each person's features.

import { TYPES, type Connection } from "tedious";
import { executeQuery } from "../db";
import type { SenderKind } from "./types";

/** The roles whose people may be given Incoming email. Admin, directors, the CFO and plain users are not handed mail. */
export const STAFF_ROLES = ["facilities", "facilities_manager", "accounts", "accounts_manager"] as const;

export interface StaffRow {
  name: string;
  role: string;
  userId: number;
}

// The role list is a constant of this file, never input, so it is written into the statement.
const STAFF_SQL = `SELECT UserID, DisplayName, Role FROM dbo.AppUsers
  WHERE IsActive = 1 AND (Role IN (${STAFF_ROLES.map((role) => `'${role}'`).join(", ")}) OR UserID = @Extra)`;

/** Active people in a staff role, plus `extraUserId` when they are active in any role (the sender of the send being answered). */
export async function loadStaff(connection: Connection, extraUserId: number | null): Promise<StaffRow[]> {
  const rows = await executeQuery(connection, STAFF_SQL, [{ name: "Extra", type: TYPES.Int, value: extraUserId }]);
  return rows.map((row) => ({ name: String(row.DisplayName), role: String(row.Role ?? ""), userId: Number(row.UserID) }));
}

const ON_LEAVE_SQL = `SELECT DISTINCT UserId FROM dbo.LeaveRequests
  WHERE Status = 'approved' AND @Today BETWEEN StartDate AND EndDate`;

/** People on approved leave that covers `today` (Darwin date, YYYY-MM-DD). */
export async function loadOnLeave(connection: Connection, today: string): Promise<Set<number>> {
  const rows = await executeQuery(connection, ON_LEAVE_SQL, [{ name: "Today", type: TYPES.Date, value: new Date(`${today}T00:00:00Z`) }]);
  return new Set(rows.map((row) => Number(row.UserId)));
}

const LAST_ACTIVE_SQL = `SELECT u.UserID, MAX(e.At) AS LastAt
  FROM dbo.AppUsers u
  LEFT JOIN dbo.AccessEvents e ON e.Oid = u.EntraOid
  WHERE u.UserID IN (SELECT CAST([value] AS INT) FROM OPENJSON(@Ids))
  GROUP BY u.UserID`;
const LOG_START_SQL = `SELECT MIN(At) AS FirstAt FROM dbo.AccessEvents`;

export interface ActivityFacts {
  /** When the access log began, or null when it is empty. */
  logStartedAt: Date | null;
  /** Last recorded sign-in or request, by person; absent when the person has none. */
  lastActive: Map<number, Date>;
}

/** The access log (migration 131) as far as it says when each person was last seen. */
export async function loadActivity(connection: Connection, userIds: readonly number[]): Promise<ActivityFacts> {
  const [start] = await executeQuery(connection, LOG_START_SQL);
  const rows = userIds.length === 0 ? [] : await executeQuery(connection, LAST_ACTIVE_SQL, [{ name: "Ids", type: TYPES.NVarChar, value: JSON.stringify(userIds) }]);
  const lastActive = new Map<number, Date>();
  for (const row of rows) if (row.LastAt) lastActive.set(Number(row.UserID), new Date(row.LastAt as Date | string));
  return { lastActive, logStartedAt: start?.FirstAt ? new Date(start.FirstAt as Date | string) : null };
}

export interface SenderMatch {
  buildingId: number | null;
  contractorId: number | null;
  kind: SenderKind;
  tenancyId: number | null;
  tenancyName: string | null;
}

const TENANCY_BY_EMAIL_SQL = `SELECT TOP (6) TenantId, BuildingId, COALESCE(TradingName, LegalName) AS Name FROM dbo.Tenants
  WHERE (PrimaryContactEmail = @Address OR AccountsEmail = @Address) AND ArchivedAt IS NULL AND IsTest = 0`;
const CONTRACTOR_BY_EMAIL_SQL = `SELECT TOP (2) ContractorID FROM dbo.Contractors WHERE EmailAddress = @Address AND Active = 1`;
const STAFF_BY_EMAIL_SQL = `SELECT TOP (1) UserID FROM dbo.AppUsers WHERE Email = @Address AND IsActive = 1`;

/** Who the sender is, by exact address: a tenancy's contact, a contractor, or one of our own staff. A sender who matches several tenancies resolves to a building only when they share one. */
export const UNKNOWN_SENDER: SenderMatch = { buildingId: null, contractorId: null, kind: "unknown", tenancyId: null, tenancyName: null };

export async function matchSender(connection: Connection, address: string | null): Promise<SenderMatch> {
  const none = UNKNOWN_SENDER;
  const value = address?.trim();
  if (!value) return none;
  const param = { name: "Address", type: TYPES.NVarChar, value };

  const tenancies = await executeQuery(connection, TENANCY_BY_EMAIL_SQL, [param]);
  if (tenancies.length > 0) {
    const buildings = new Set(tenancies.map((row) => Number(row.BuildingId)));
    const only = tenancies.length === 1 ? tenancies[0] : null;
    return {
      buildingId: buildings.size === 1 ? [...buildings][0] : null,
      contractorId: null,
      kind: "tenancy",
      tenancyId: only ? Number(only.TenantId) : null,
      tenancyName: only ? String(only.Name) : null,
    };
  }
  const contractors = await executeQuery(connection, CONTRACTOR_BY_EMAIL_SQL, [param]);
  if (contractors.length > 0) return { ...none, contractorId: contractors.length === 1 ? Number(contractors[0].ContractorID) : null, kind: "contractor" };
  const staff = await executeQuery(connection, STAFF_BY_EMAIL_SQL, [param]);
  return staff.length > 0 ? { ...none, kind: "staff" } : none;
}

export interface NamedJob {
  assignedToUserId: number | null;
  buildingId: number;
  jobId: number;
  tenancyId: number | null;
}

const JOB_SQL = `SELECT JobID, BuildingID, TenantID, AssignedToUserID FROM dbo.Jobs WHERE JobID = @JobId AND IsArchived = 0 AND IsTest = 0`;

/** A job by number, when it exists and is a live, non-test record: a number in an email is only a hint. */
export async function loadJob(connection: Connection, jobId: number): Promise<NamedJob | null> {
  const [row] = await executeQuery(connection, JOB_SQL, [{ name: "JobId", type: TYPES.Int, value: jobId }]);
  if (!row) return null;
  return {
    assignedToUserId: row.AssignedToUserID === null || row.AssignedToUserID === undefined ? null : Number(row.AssignedToUserID),
    buildingId: Number(row.BuildingID),
    jobId: Number(row.JobID),
    tenancyId: row.TenantID === null || row.TenantID === undefined ? null : Number(row.TenantID),
  };
}

const BUILDING_BY_NAME_SQL = `SELECT TOP (2) BuildingID, BuildingName FROM dbo.Buildings WHERE Active = 1 AND BuildingName = @Name`;
const BUILDING_BY_ID_SQL = `SELECT BuildingName FROM dbo.Buildings WHERE BuildingID = @Id`;
const TENANCY_BY_NAME_SQL = `SELECT TOP (2) TenantId, BuildingId, COALESCE(TradingName, LegalName) AS Name FROM dbo.Tenants
  WHERE (LegalName = @Name OR TradingName = @Name) AND ArchivedAt IS NULL AND IsTest = 0`;
const TENANCY_BY_ID_SQL = `SELECT BuildingId, COALESCE(TradingName, LegalName) AS Name FROM dbo.Tenants WHERE TenantId = @Id`;

/** A building by exact name; only a name that matches exactly one building counts. */
export async function buildingByName(connection: Connection, name: string): Promise<{ buildingId: number; name: string } | null> {
  const rows = await executeQuery(connection, BUILDING_BY_NAME_SQL, [{ name: "Name", type: TYPES.NVarChar, value: name }]);
  return rows.length === 1 ? { buildingId: Number(rows[0].BuildingID), name: String(rows[0].BuildingName) } : null;
}

export async function buildingNameById(connection: Connection, buildingId: number): Promise<string | null> {
  const [row] = await executeQuery(connection, BUILDING_BY_ID_SQL, [{ name: "Id", type: TYPES.Int, value: buildingId }]);
  return row?.BuildingName ? String(row.BuildingName) : null;
}

export async function tenancyByName(connection: Connection, name: string): Promise<{ buildingId: number; name: string; tenancyId: number } | null> {
  const rows = await executeQuery(connection, TENANCY_BY_NAME_SQL, [{ name: "Name", type: TYPES.NVarChar, value: name }]);
  return rows.length === 1 ? { buildingId: Number(rows[0].BuildingId), name: String(rows[0].Name), tenancyId: Number(rows[0].TenantId) } : null;
}

export async function tenancyById(connection: Connection, tenancyId: number): Promise<{ buildingId: number; name: string } | null> {
  const [row] = await executeQuery(connection, TENANCY_BY_ID_SQL, [{ name: "Id", type: TYPES.Int, value: tenancyId }]);
  return row ? { buildingId: Number(row.BuildingId), name: String(row.Name) } : null;
}

export interface AssignedJob {
  assignedToUserId: number;
  buildingId: number;
  category: string | null;
  createdAt: Date;
  open: boolean;
  tenancyId: number | null;
}

// Open jobs, and jobs raised since `@Since`, for these people: a few hundred rows at most. Test and archived jobs are not history.
const ASSIGNED_JOBS_SQL = `SELECT AssignedToUserID, BuildingID, TenantID, Category, CreatedAt,
    CASE WHEN Status = 'Done' THEN 0 ELSE 1 END AS IsOpen
  FROM dbo.Jobs
  WHERE AssignedToUserID IN (SELECT CAST([value] AS INT) FROM OPENJSON(@Ids))
    AND IsArchived = 0 AND IsTest = 0 AND (Status <> 'Done' OR CreatedAt >= @Since)`;

export async function loadAssignedJobs(connection: Connection, userIds: readonly number[], since: Date): Promise<AssignedJob[]> {
  if (userIds.length === 0) return [];
  const rows = await executeQuery(connection, ASSIGNED_JOBS_SQL, [
    { name: "Ids", type: TYPES.NVarChar, value: JSON.stringify(userIds) },
    { name: "Since", type: TYPES.DateTime2, value: since },
  ]);
  return rows.map((row) => ({
    assignedToUserId: Number(row.AssignedToUserID),
    buildingId: Number(row.BuildingID),
    category: (row.Category as string | null) ?? null,
    createdAt: new Date(row.CreatedAt as Date | string),
    open: Number(row.IsOpen) === 1,
    tenancyId: row.TenantID === null || row.TenantID === undefined ? null : Number(row.TenantID),
  }));
}
