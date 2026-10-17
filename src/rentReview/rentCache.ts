// The RentPerAnnum cache on a review's date (WP26 L10). APPLY writes the cache
// only once the review's date has come: a review applied ahead of its date
// leaves it as the rent in force today and marks it "deferred" in its
// rent_review.apply row. On the date, the generator's live run writes it, as the
// system, in a transaction of its own per tenancy, ledgered as
// rent_review.rent_cache; a dry run logs what it would write.
//
// Positive selection (database-safety rule 2): exactly the reviews whose latest
// APPLY deferred the cache, whose date has come, and which nobody has written
// since. Each is checked again before it is written: the tenancy is still live,
// RentPerAnnum is still only a cache (the first row a commencement row with its
// own rent), the row in force today is still this review's applied row with the
// review's rent, and RentPerAnnum is still what was read (the UPDATE says so).
// Anything else is left for a person and logged.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery, type SqlRow } from "../db";
import * as ledger from "../ledger";
import type { LedgerActor } from "../ledger";
import { sqlDateToIso } from "../nextReviewDate";
import { computeScheduleRows, parseSteps, resolveCurrentRent } from "../scheduledRateStepLogic";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { decimalOf, isReviewRatchetOn } from "./reviewTenancy";
import { rentPerAnnumIsCache } from "./stepPlan";
import { inTransaction } from "./store";

const MONEY = { precision: 20, scale: 10 } as const;

const DUE_CACHES_SQL = `SELECT r.ReviewId, r.TenantId, r.ScheduledFor, r.NewRentPerAnnum,
    t.BuildingId, t.RentPerAnnum, t.ScheduledRateSteps, t.CpiCapPercent, t.CpiFloorPercent, t.ReviewRatchet,
    t.Status AS TenantStatus, t.ArchivedAt AS TenantArchivedAt
  FROM dbo.RentReviews r
  INNER JOIN dbo.Tenants t ON t.TenantId = r.TenantId
  WHERE r.State IN ('approved', 'completed') AND r.ScheduledFor <= @Today
    AND EXISTS (
      SELECT 1 FROM dbo.DecisionLedger a
      WHERE a.SubjectType = N'rent_review' AND a.SubjectId = r.ReviewId AND a.Action = N'rent_review.apply'
        AND JSON_VALUE(a.[After], '$.rentPerAnnumCache') = N'deferred'
        AND a.LedgerId = (
          SELECT MAX(x.LedgerId) FROM dbo.DecisionLedger x
          WHERE x.SubjectType = N'rent_review' AND x.SubjectId = r.ReviewId AND x.Action = N'rent_review.apply')
        AND NOT EXISTS (
          SELECT 1 FROM dbo.DecisionLedger w
          WHERE w.SubjectType = N'rent_review' AND w.SubjectId = r.ReviewId
            AND w.Action = N'rent_review.rent_cache' AND w.LedgerId > a.LedgerId))`;

const WRITE_CACHE_SQL = `UPDATE dbo.Tenants
    SET RentPerAnnum = @RentPerAnnum, UpdatedAt = SYSUTCDATETIME(), UpdatedById = @UpdatedById, UpdatedByName = @UpdatedByName
  OUTPUT INSERTED.TenantId
  WHERE TenantId = @TenantId AND ((@Expected IS NULL AND RentPerAnnum IS NULL) OR RentPerAnnum = @Expected)`;

export type RentCachePlan =
  | { from: number | null; kind: "write"; to: number }
  | { kind: "current"; to: number }
  | { kind: "skip"; why: string };

/** What to do for one review whose cache APPLY deferred. Pure. */
export function planRentCache(row: SqlRow, today: string): RentCachePlan {
  if (row.TenantStatus === "vacated" || (row.TenantArchivedAt !== null && row.TenantArchivedAt !== undefined)) {
    return { kind: "skip", why: "the tenancy is vacated or archived" };
  }
  const steps = parseSteps(row.ScheduledRateSteps as string | null | undefined);
  if (!rentPerAnnumIsCache(steps)) return { kind: "skip", why: "RentPerAnnum is now the schedule's starting rent, not a cache" };
  const cached = decimalOf(row.RentPerAnnum);
  const terms = { cpiCapPercent: decimalOf(row.CpiCapPercent), cpiFloorPercent: decimalOf(row.CpiFloorPercent), reviewRatchet: isReviewRatchetOn(row) };
  const current = resolveCurrentRent(computeScheduleRows(steps, cached ?? 0, 0, terms), cached ?? 0, today);
  const reviewId = String(row.ReviewId);
  if (current.kind !== "row" || current.row.step.reviewId !== reviewId || current.row.step.resolution !== "applied") {
    return { kind: "skip", why: "the row in force today isn't this review's any more" };
  }
  const expected = decimalOf(row.NewRentPerAnnum);
  if (expected === null || current.row.annual !== Math.round(expected * 100) / 100) {
    return { kind: "skip", why: "the schedule's rent today isn't the rent the review applied" };
  }
  if (cached !== null && Math.abs(cached - current.row.annual) < 0.005) return { kind: "current", to: current.row.annual };
  return { from: cached, kind: "write", to: current.row.annual };
}

export interface RentCacheReport {
  errors: Array<{ message: string; reviewId: string }>;
  /** Already the review's rent (written by hand since): recorded, nothing changed. */
  current: number;
  skipped: number;
  written: number;
}

export interface RentCacheRun {
  actor: LedgerActor;
  dryRun: boolean;
  log: (message: string) => void;
  today: string;
  warn: (message: string) => void;
}

export async function writeDueRentCaches(connection: Connection, run: RentCacheRun): Promise<RentCacheReport> {
  const report: RentCacheReport = { current: 0, errors: [], skipped: 0, written: 0 };
  const rows = await executeQuery(connection, DUE_CACHES_SQL, [{ name: "Today", type: TYPES.Date, value: run.today }]);
  for (const row of rows) {
    const reviewId = String(row.ReviewId);
    const tenantId = Number(row.TenantId);
    const buildingId = Number(row.BuildingId);
    const plan = planRentCache(row, run.today);
    if (plan.kind === "skip") {
      report.skipped += 1;
      run.warn(`rentReviewGenerator: tenancy ${tenantId}'s rent cache for review ${reviewId} left for a person: ${plan.why}`);
      continue;
    }
    if (run.dryRun) {
      run.log(`rentReviewGenerator: would write tenancy ${tenantId}'s RentPerAnnum to ${plan.to} (review ${reviewId}, dated ${sqlDateToIso(row.ScheduledFor)})`);
      if (plan.kind === "write") report.written += 1;
      else report.current += 1;
      continue;
    }
    try {
      const done = await inTransaction(connection, async () => {
        if (plan.kind === "write") {
          const updated = await executeQuery(connection, WRITE_CACHE_SQL, [
            { name: "Expected", options: MONEY, type: TYPES.Decimal, value: plan.from },
            { name: "RentPerAnnum", options: MONEY, type: TYPES.Decimal, value: plan.to },
            { name: "TenantId", type: TYPES.Int, value: tenantId },
            { name: "UpdatedById", type: TYPES.NVarChar, value: `system:${run.actor.name}` },
            { name: "UpdatedByName", type: TYPES.NVarChar, value: run.actor.name },
          ]);
          if (updated.length === 0) return false;
        }
        await ledger.record(connection, {
          action: "rent_review.rent_cache",
          actor: run.actor,
          after: { rentPerAnnum: plan.to, reviewDate: sqlDateToIso(row.ScheduledFor) },
          before: { rentPerAnnum: plan.kind === "write" ? plan.from : plan.to },
          buildingId,
          ruleApplied: plan.kind === "write" ? "review_date_arrived" : "already_current",
          subject: { id: reviewId, type: "rent_review" },
          tenantId,
        });
        return true;
      });
      if (!done) {
        report.skipped += 1;
        run.warn(`rentReviewGenerator: tenancy ${tenantId}'s RentPerAnnum changed while its cache was being written; left for the next run`);
        continue;
      }
      if (plan.kind === "write") {
        report.written += 1;
        invalidateTenantAndBuilding(tenantId, buildingId);
      } else {
        report.current += 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push({ message, reviewId });
      run.warn(`rentReviewGenerator: tenancy ${tenantId}'s rent cache failed: ${message}`);
    }
  }
  run.log(
    `rentReviewGenerator: rent caches ${run.dryRun ? "to write" : "written"} ${report.written}, already current ${report.current}, ` +
      `left for a person ${report.skipped}, failed ${report.errors.length}`,
  );
  return report;
}
