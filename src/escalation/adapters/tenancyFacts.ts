// Tenancies whose schedule nobody has signed off while a review date is near or past (LOOP-11). The unsigned
// schedule silences the tenancy's rent-review escalations (rentReview/escalationRules.ts), so the sign-off is
// what has to be chased. Selection is positive: live (not vacated, not archived, not test), unsigned, with a
// stored next review date inside the window or already gone.

import type { Connection } from "tedious";
import { executeQuery } from "../../db";

export const UNSIGNED_WINDOW_DAYS = 60;

export interface UnsignedSchedule {
  /** When the review date came inside the window: the start of this chase's clock. */
  since: Date;
  tenantId: number;
}

const SQL = `SELECT TenantId, NextReviewDate
  FROM dbo.Tenants
  WHERE ArchivedAt IS NULL AND Status <> N'vacated' AND ISNULL(IsTest, 0) = 0
    AND ScheduleSignedOffAt IS NULL AND NextReviewDate IS NOT NULL
    AND NextReviewDate <= DATEADD(DAY, ${UNSIGNED_WINDOW_DAYS}, CAST(SYSUTCDATETIME() AS DATE))`;

export async function listUnsignedSchedules(connection: Connection): Promise<UnsignedSchedule[]> {
  const rows = await executeQuery(connection, SQL);
  return rows
    .filter((row) => row.NextReviewDate instanceof Date)
    .map((row) => ({
      since: new Date((row.NextReviewDate as Date).getTime() - UNSIGNED_WINDOW_DAYS * 86_400_000),
      tenantId: Number(row.TenantId),
    }));
}
