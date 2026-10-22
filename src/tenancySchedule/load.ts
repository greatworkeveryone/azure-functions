// Reads for the Tenancy Schedule report: five batched queries for the whole
// scope (one building, or every active building that has a tenancy), never one
// round trip per building or tenancy. Read-only. The JSON columns come back raw
// and are parsed by build.ts with the register's own parsers.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery, type SqlParam } from "../db";
import { loadPendingChanges } from "../scheduleChange/pending";
import type { TenancyScheduleData } from "./build";

export type TenancyScheduleScope = { all: true } | { buildingId: number };

// Company reporting covers commercial buildings only: residences are the family's
// own houses (Connor, 22 Oct 2026), and development sites aren't let. Selected
// positively, so a new category stays out until someone decides it belongs.
const COMMERCIAL_TENANT = "EXISTS (SELECT 1 FROM dbo.Buildings cb WHERE cb.BuildingID = t.BuildingId AND cb.Category = N'commercial')";
const COMMERCIAL_CARPARK = "EXISTS (SELECT 1 FROM dbo.Buildings cb WHERE cb.BuildingID = c.BuildingId AND cb.Category = N'commercial')";

// @BuildingId is NULL for "all buildings". Archived and test tenancies are left
// out (test ones unless the admin's Show test data switch is on), as in the register.
const TENANT_SCOPE = `t.ArchivedAt IS NULL AND (t.IsTest = 0 OR @ShowTest = 1) AND (@BuildingId IS NULL OR t.BuildingId = @BuildingId) AND ${COMMERCIAL_TENANT}`;

const BUILDINGS_SQL = `SELECT b.BuildingID, b.BuildingName, b.BuildingAddress, b.ReferenceCode
  FROM dbo.Buildings b
 WHERE (@BuildingId IS NULL OR b.BuildingID = @BuildingId)
   AND b.Category = N'commercial'
   AND (@BuildingId IS NOT NULL OR (b.Active = 1 AND EXISTS (
         SELECT 1 FROM dbo.Tenants t WHERE t.BuildingId = b.BuildingID AND t.ArchivedAt IS NULL AND (t.IsTest = 0 OR @ShowTest = 1))))
 ORDER BY b.BuildingName, b.BuildingID`;

const TENANTS_SQL = `SELECT t.TenantId, t.BuildingId, t.IdNo, t.LegalName, t.TradingName,
       t.PrimaryContactName, t.PrimaryContactEmail, t.PrimaryContactPhone, t.LeaseType,
       t.Commencement, t.Expiry, t.TermMonths, t.OptionPeriods, t.Status, t.RentPerAnnum,
       t.CpiRegion, t.CpiCapPercent, t.CpiFloorPercent, t.ReviewRatchet,
       t.ScheduledRateSteps, t.CarparkScheduleGroups, t.MiscFees, t.RentReliefs, t.InfoSheetSections,
       t.ScheduleSignedOffAt, t.ScheduleSignedOffById, t.ScheduleSignedOffByName, t.ScheduleSignOffNote
  FROM dbo.Tenants t
 WHERE ${TENANT_SCOPE}
 ORDER BY t.BuildingId, t.TenantId`;

const OCCUPANCIES_SQL = `SELECT o.OccupancyId, o.TenantId, o.BuildingId, o.Level, o.Area, o.SizeSqm
  FROM dbo.TenantOccupancies o
 INNER JOIN dbo.Tenants t ON t.TenantId = o.TenantId
 WHERE o.ArchivedAt IS NULL AND ${TENANT_SCOPE}
 ORDER BY o.Level, o.Area`;

const CARPARKS_SQL = `SELECT c.CarparkId, c.BuildingId, c.AllocationKind, c.TenantId
  FROM dbo.Carparks c
 WHERE c.ArchivedAt IS NULL AND (@BuildingId IS NULL OR c.BuildingId = @BuildingId) AND ${COMMERCIAL_CARPARK}`;

export async function loadTenancyScheduleData(
  connection: Connection,
  scope: TenancyScheduleScope,
  showTest: boolean,
): Promise<TenancyScheduleData> {
  const params: SqlParam[] = [
    { name: "BuildingId", type: TYPES.Int, value: "buildingId" in scope ? scope.buildingId : null },
    { name: "ShowTest", type: TYPES.Bit, value: showTest },
  ];
  const buildings = await executeQuery(connection, BUILDINGS_SQL, params);
  const tenants = await executeQuery(connection, TENANTS_SQL, params);
  const occupancies = await executeQuery(connection, OCCUPANCIES_SQL, params);
  const carparks = await executeQuery(connection, CARPARKS_SQL, params);
  // Full detail: the report is for directors and the CFO, who read the register's figures and reasons.
  const pending = await loadPendingChanges(connection, scope, "full", showTest);
  return { buildings, carparks, occupancies, pending, tenants };
}
