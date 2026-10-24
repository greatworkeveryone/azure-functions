// Reads for the Compliance report: a handful of queries for the whole scope (one
// building, or every active commercial building), never one round trip per building or
// contractor. Read-only. The coverage plan comes back as stored JSON and is read by
// build.ts; the rules (overdue, in force, certificate dates) are decided there too.

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam, type SqlRow } from "../db";
import { DEFECTS_PERIOD_COLUMNS, TENANT_NAME } from "../defectsPeriods";
import { SELECT_SCHEDULE } from "../serviceSchedules";
import { readPlanTrades } from "./plan";
import type { ComplianceData } from "./build";
import type { ComplianceScope } from "./types";

// Company reporting covers commercial buildings only: residences are the family's own
// houses (Connor, 22 Oct 2026; tenancy schedule decision T10), and development sites
// aren't let. Selected positively, so a new category stays out until someone decides it
// belongs. Same rule as src/maintenanceSpend/load.ts and src/tenancySchedule/load.ts.
// For everything, only active buildings: a building asked for by id is reported whatever
// its state, as the Tenancy Schedule does.
const IN_SCOPE = `(SELECT cb.BuildingID FROM dbo.Buildings cb
   WHERE cb.Category = N'commercial' AND ((@BuildingId IS NULL AND cb.Active = 1) OR cb.BuildingID = @BuildingId))`;

const BUILDINGS_SQL = `SELECT b.BuildingID, b.BuildingName, b.ReferenceCode
  FROM dbo.Buildings b
 WHERE b.BuildingID IN ${IN_SCOPE}
 ORDER BY b.BuildingName, b.BuildingID`;

// Live schedules only (active, not archived), with the contractor's name and the
// asset or scope, exactly as the Maintenance page reads them.
const SCHEDULES_SQL = `${SELECT_SCHEDULE}
 WHERE s.ArchivedAt IS NULL AND s.Active = 1 AND s.BuildingId IN ${IN_SCOPE}
 ORDER BY s.BuildingId, s.NextDue, s.ServiceScheduleId`;

// Periods not archived and in force on the date; a period on a test tenancy only when the
// admin's Show test data is on (a building-wide period, or one whose tenancy is gone, never
// is a test record). build.ts decides "in force" again, so the edges are in one place.
const PERIODS_SQL = `SELECT ${DEFECTS_PERIOD_COLUMNS}, ${TENANT_NAME}, c.ContractorName
  FROM dbo.DefectsPeriods d
  LEFT JOIN dbo.Tenants t ON t.TenantID = d.TenantId
  LEFT JOIN dbo.Contractors c ON c.ContractorID = d.ContractorId
 WHERE d.ArchivedAt IS NULL AND d.BuildingId IN ${IN_SCOPE}
   AND d.PracticalCompletion <= @AsOf AND d.EndsOn >= @AsOf
   AND (t.TenantID IS NULL OR t.IsTest = 0 OR @ShowTest = 1)
 ORDER BY d.EndsOn, d.DefectsPeriodId`;

const PLANS_SQL = `SELECT mc.BuildingId, mc.PlanJson FROM dbo.MaintenanceCoverage mc WHERE mc.BuildingId IN ${IN_SCOPE}`;

const CONTRACTORS_SQL = `SELECT c.ContractorID, c.ContractorName, c.Active, c.Suspended
  FROM dbo.Contractors c
 WHERE c.ContractorID IN (SELECT CAST([value] AS INT) FROM OPENJSON(@Ids))`;

// Contractor insurance certificates in the Documentation register. Archived ones never.
const CERTIFICATES_SQL = `SELECT d.DocumentId, d.ContractorId, d.BuildingId, d.Kind, d.ServiceCategory, d.InsuranceType, d.IssuedOn, d.ExpiresOn
  FROM dbo.RegisterDocuments d
 WHERE d.ArchivedAt IS NULL AND d.Kind = N'certificate' AND d.ServiceCategory = N'Insurance'
   AND d.ContractorId IN (SELECT CAST([value] AS INT) FROM OPENJSON(@Ids))
 ORDER BY d.DocumentId`;

/** The contractors the schedules and the coverage plans name, once each. */
function contractorIds(schedules: readonly SqlRow[], plans: readonly SqlRow[]): number[] {
  const ids = new Set<number>();
  for (const row of schedules) if (row.ContractorId !== null && row.ContractorId !== undefined) ids.add(Number(row.ContractorId));
  for (const row of plans) for (const trade of readPlanTrades(row.PlanJson)) trade.contractorIds.forEach((id) => ids.add(id));
  return [...ids];
}

export async function loadComplianceData(connection: Connection, scope: ComplianceScope, asOf: string, showTest: boolean): Promise<ComplianceData> {
  const building: SqlParam = { name: "BuildingId", type: TYPES.Int, value: "buildingId" in scope ? scope.buildingId : null };
  const buildings = await executeQuery(connection, BUILDINGS_SQL, [building]);
  if (buildings.length === 0) return { buildings, certificates: [], contractors: [], periods: [], plans: [], schedules: [] };

  // One query at a time: a tedious connection runs one request at once.
  const schedules = await executeQuery(connection, SCHEDULES_SQL, [building]);
  const periods = await executeQuery(connection, PERIODS_SQL, [building, { name: "AsOf", type: TYPES.Date, value: asOf }, { name: "ShowTest", type: TYPES.Bit, value: showTest }]);
  const plans = await executeQuery(connection, PLANS_SQL, [building]);

  const ids = contractorIds(schedules, plans);
  if (ids.length === 0) return { buildings, certificates: [], contractors: [], periods, plans, schedules };
  const named: SqlParam = { name: "Ids", type: TYPES.NVarChar, value: JSON.stringify(ids) };
  const contractors = await executeQuery(connection, CONTRACTORS_SQL, [named]);
  const certificates = await executeQuery(connection, CERTIFICATES_SQL, [named]);
  return { buildings, certificates, contractors, periods, plans, schedules };
}
