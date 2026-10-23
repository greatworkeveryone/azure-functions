// Reads for the Maintenance spend report: two queries for the whole scope (one
// building, or every commercial building), never one round trip per building.
// Read-only. The year's exact edge is decided in build.ts; the window here only
// keeps the read from returning every invoice there has ever been.

import { TYPES, type Connection } from "tedious";
import { executeQuery, type SqlParam } from "../db";
import { queryWindow, type FinancialYear } from "./financialYear";
import type { MaintenanceSpendData } from "./build";
import type { MaintenanceSpendScope } from "./types";

// Company reporting covers commercial buildings only: residences are the family's
// own houses (Connor, 22 Oct 2026; tenancy schedule decision T10), and development
// sites aren't let. Selected positively, so a new category stays out until someone
// decides it belongs. Same rule as src/tenancySchedule/load.ts.
const BUILDINGS_SQL = `SELECT b.BuildingID, b.BuildingName, b.ReferenceCode
  FROM dbo.Buildings b
 WHERE b.Category = N'commercial' AND (@BuildingId IS NULL OR b.BuildingID = @BuildingId)
 ORDER BY b.BuildingName, b.BuildingID`;

// Approved invoices only (the status an approver sets, or a director's); archived
// jobs never; test jobs and invoices unless the admin's Show test data switch is on.
// JobInvoices has no archive flag of its own: an invoice leaves with its job.
// Outgoing rows come back for any job; build.ts keeps those on on-chargeable jobs.
// An invoice with neither a received nor an approval date comes back too, so it can
// be counted as undated rather than silently missing.
const INVOICES_SQL = `SELECT i.JobInvoiceID, i.JobID, i.Direction, i.Amount, i.ReceivedAt, i.ApprovedAt,
       j.BuildingID, j.Category, j.IsOnchargeable
  FROM dbo.JobInvoices i
  JOIN dbo.Jobs j ON j.JobID = i.JobID
 WHERE j.IsArchived = 0
   AND (j.IsTest = 0 OR @ShowTest = 1)
   AND (i.IsTest = 0 OR @ShowTest = 1)
   AND i.Status IN (N'approved', N'director_approved')
   AND i.Amount IS NOT NULL
   AND (@BuildingId IS NULL OR j.BuildingID = @BuildingId)
   AND EXISTS (SELECT 1 FROM dbo.Buildings cb WHERE cb.BuildingID = j.BuildingID AND cb.Category = N'commercial')
   AND (COALESCE(i.ReceivedAt, i.ApprovedAt) IS NULL
        OR (COALESCE(i.ReceivedAt, i.ApprovedAt) >= @From AND COALESCE(i.ReceivedAt, i.ApprovedAt) < @To))
 ORDER BY j.BuildingID, j.JobID, i.JobInvoiceID`;

export async function loadMaintenanceSpendData(
  connection: Connection,
  scope: MaintenanceSpendScope,
  year: FinancialYear,
  showTest: boolean,
): Promise<MaintenanceSpendData> {
  const window = queryWindow(year);
  const params: SqlParam[] = [
    { name: "BuildingId", type: TYPES.Int, value: "buildingId" in scope ? scope.buildingId : null },
    { name: "ShowTest", type: TYPES.Bit, value: showTest },
    { name: "From", type: TYPES.DateTime2, value: window.from },
    { name: "To", type: TYPES.DateTime2, value: window.to },
  ];
  const buildings = await executeQuery(connection, BUILDINGS_SQL, [params[0]]);
  const invoices = await executeQuery(connection, INVOICES_SQL, params);
  return { buildings, invoices };
}
