// Reads for getPortfolioOccupancy: one row per building with its m², rent, WALE and
// tenant counts, which the Overview and the dashboard roll up into the company's
// occupancy %, annual rent, WALE and tenant count. Read-only.
//
// Company reporting covers commercial buildings only: residences are the family's own
// houses (Connor, 22 Oct 2026; TENANCY-SCHEDULE-REPORT T10). Selected positively, so a
// new category stays out until someone decides it belongs. The tenancy register and
// everything operational still see a residence's tenancy (U8).

import type { Connection } from "tedious";
import { buildingCategoryColumnExists } from "./buildingCategoryColumn";
import { executeQuery, type SqlParam } from "./db";
import { loadPendingChanges, type PendingChangeItem } from "./scheduleChange/pending";

const COMMERCIAL_TENANT = "EXISTS (SELECT 1 FROM dbo.Buildings cb WHERE cb.BuildingID = t.BuildingId AND cb.Category = N'commercial')";

const FIGURES_HEAD = `SELECT t.BuildingId,
              SUM(CASE WHEN t.Status IN ('current','holdover')
                       THEN occ.TenantSqm ELSE 0 END) AS ActiveSqm,
              SUM(occ.TenantSqm) AS TotalSqm,
              SUM(CASE WHEN t.Status IN ('current','holdover')
                       THEN t.RentPerAnnum ELSE 0 END) AS AnnualRent,
              SUM(CASE WHEN t.Status IN ('current','holdover')
                       THEN 1 ELSE 0 END) AS ActiveTenantCount,
              SUM(CASE WHEN t.Status IN ('current','holdover')
                            AND t.ScheduleSignedOffAt IS NULL
                       THEN 1 ELSE 0 END) AS UnsignedTenantCount,
              SUM(CASE WHEN t.Status IN ('current','holdover')
                            AND t.Expiry IS NOT NULL
                       THEN occ.TenantSqm
                            * DATEDIFF(day, CAST(GETDATE() AS DATE), t.Expiry)
                       ELSE 0 END) AS WaleNumeratorSqmDays,
              SUM(CASE WHEN t.Status IN ('current','holdover')
                            AND t.Expiry IS NOT NULL
                       THEN occ.TenantSqm ELSE 0 END) AS WaleDenominatorSqm
       FROM dbo.Tenants t
       INNER JOIN (
         SELECT TenantId, SUM(SizeSqm) AS TenantSqm
         FROM dbo.TenantOccupancies
         WHERE ArchivedAt IS NULL
         GROUP BY TenantId
       ) occ ON occ.TenantId = t.TenantId
       WHERE t.ArchivedAt IS NULL
         AND (t.IsTest = 0 OR @ShowTest = 1)`;
const FIGURES_TAIL = "GROUP BY t.BuildingId";

const COMMERCIAL_FIGURES_SQL = `${FIGURES_HEAD}
         AND ${COMMERCIAL_TENANT}
       ${FIGURES_TAIL}`;
// Before migration 136 there is no Buildings.Category to name (an unknown column fails the
// whole query), and every building is, in effect, commercial.
const UNCATEGORISED_FIGURES_SQL = `${FIGURES_HEAD}
       ${FIGURES_TAIL}`;

export interface PortfolioBuildingOccupancy {
  activeSqm: number;
  activeTenantCount: number;
  annualRent: number;
  buildingId: number;
  occupancyPercent: number;
  pendingChangeCount: number;
  totalSqm: number;
  unsignedTenantCount: number;
  waleExpirySqm: number;
  waleYears: number;
}

export async function loadPortfolioOccupancy(
  connection: Connection,
  showTest: SqlParam,
): Promise<{ buildings: PortfolioBuildingOccupancy[]; pending: PendingChangeItem[] }> {
  const categorised = await buildingCategoryColumnExists(connection);
  const rows = await executeQuery(connection, categorised ? COMMERCIAL_FIGURES_SQL : UNCATEGORISED_FIGURES_SQL, [showTest]);

  // WP26c: changes awaiting a director across the portfolio, dates and names
  // only: facilities read these figures too. Same buildings as the figures above.
  const pending = await loadPendingChanges(connection, categorised ? { commercial: true } : { all: true }, "dates_only", showTest.value);
  const buildings = rows.map((r) => {
    const totalSqm = Number(r.TotalSqm) || 0;
    const activeSqm = Number(r.ActiveSqm) || 0;
    const waleNumerator = Number(r.WaleNumeratorSqmDays) || 0;
    const waleDenominator = Number(r.WaleDenominatorSqm) || 0;
    return {
      activeSqm,
      activeTenantCount: Number(r.ActiveTenantCount) || 0,
      annualRent: Number(r.AnnualRent) || 0,
      buildingId: r.BuildingId as number,
      occupancyPercent: totalSqm > 0 ? (activeSqm / totalSqm) * 100 : 0,
      // The building's changes awaiting a director (WP26c): "Includes {n} changes awaiting a director".
      pendingChangeCount: pending.filter((item) => item.buildingId === Number(r.BuildingId)).length,
      totalSqm,
      // Active tenancies whose schedule nobody has signed off yet (PLAN D7).
      unsignedTenantCount: Number(r.UnsignedTenantCount) || 0,
      waleExpirySqm: waleDenominator,
      waleYears: waleDenominator > 0 ? waleNumerator / waleDenominator / 365.25 : 0,
    };
  });
  return { buildings, pending };
}
