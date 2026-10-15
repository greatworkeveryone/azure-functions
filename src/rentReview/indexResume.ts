// INDEX_AVAILABLE (PLAN §3.1, WP26): after the CPI sync has stored ABS's
// quarters, every CPI review waiting for its index whose two quarters are now
// published, on one base, goes back to in progress for its owner to calculate.
// The CPI timer runs it after each successful sync (and, in its dry run, only
// says what it would move).
//
// Each review moves in a transaction of its own, only if it is still waiting
// (someone may have cancelled or waived it since), ledgered as
// rent_review.index_available by the system (the timer). Nothing is calculated
// here: the owner calculates, with the values as they stand then. The owner
// hears of it in Floorplan (D21): the review is in progress and theirs again,
// which puts "Continue rent review" back in their next action.

import type { Connection } from "tedious";
import { executeQuery } from "../db";
import * as ledger from "../ledger";
import type { LedgerActor } from "../ledger";
import { sqlDateToIso } from "../nextReviewDate";
import { Sentry } from "../sentry";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { parseBasis } from "./basis";
import { previousQuarter, referenceQuarter, type CpiIndexRow } from "./cpi";
import { inTransaction, loadCpiRows } from "./store";
import { markIndexAvailable } from "./transitions";

export const CPI_TIMER_ACTOR: LedgerActor = { kind: "system", name: "tenancyCpiSyncTimer" };

const AWAITING_SQL = `SELECT r.ReviewId, r.TenantId, r.ScheduledFor, r.Basis, r.OwnerUserId, r.ExpectedIndexAt,
    t.BuildingId AS TenantBuildingId
  FROM dbo.RentReviews r
  INNER JOIN dbo.Tenants t ON t.TenantId = r.TenantId
  WHERE r.State = 'awaiting_index'`;

export interface AwaitingReview {
  buildingId: number;
  ownerUserId: number | null;
  previousQuarter: string;
  referenceQuarter: string;
  /** null when the basis names no region the CPI sync stores. */
  region: "AUS" | "DARWIN" | null;
  reviewId: string;
  tenantId: number;
}

/** The quarters a waiting review needs, from its basis and date. Pure. */
export function awaitingReviewOf(row: Record<string, unknown>): AwaitingReview {
  const basis = parseBasis(row.Basis) ?? {};
  const region = typeof basis.region === "string" ? basis.region.toUpperCase() : "";
  const interval = typeof basis.intervalMonths === "number" ? basis.intervalMonths : null;
  const reference = referenceQuarter(sqlDateToIso(row.ScheduledFor) ?? "");
  return {
    buildingId: Number(row.TenantBuildingId),
    ownerUserId: row.OwnerUserId === null || row.OwnerUserId === undefined ? null : Number(row.OwnerUserId),
    previousQuarter: previousQuarter(reference, interval),
    referenceQuarter: reference,
    region: region === "AUS" || region === "DARWIN" ? region : null,
    reviewId: String(row.ReviewId),
    tenantId: Number(row.TenantId),
  };
}

/** Both quarters are in CpiIndex on the same known base, so the review can be calculated. Pure. */
export function indexPublished(review: AwaitingReview, rows: readonly CpiIndexRow[]): boolean {
  const current = rows.find((row) => row.period === review.referenceQuarter);
  const previous = rows.find((row) => row.period === review.previousQuarter);
  return (
    current !== undefined &&
    previous !== undefined &&
    current.referenceBase !== null &&
    current.referenceBase === previous.referenceBase
  );
}

export interface IndexResumeReport {
  errors: Array<{ message: string; reviewId: string }>;
  resumed: number;
  /** Still waiting: a quarter not yet published (or on a different base). */
  waiting: number;
}

export async function resumeAwaitingIndex(
  connection: Connection,
  run: { dryRun: boolean; log: (message: string) => void; warn: (message: string) => void },
): Promise<IndexResumeReport> {
  const report: IndexResumeReport = { errors: [], resumed: 0, waiting: 0 };
  const reviews = (await executeQuery(connection, AWAITING_SQL)).map(awaitingReviewOf);
  for (const review of reviews) {
    const rows = review.region ? await loadCpiRows(connection, review.region, [review.referenceQuarter, review.previousQuarter]) : [];
    if (!indexPublished(review, rows)) {
      report.waiting += 1;
      continue;
    }
    if (run.dryRun) {
      run.log(`cpi sync dry run: would return rent review ${review.reviewId} to in progress (${review.referenceQuarter} is published)`);
      report.resumed += 1;
      continue;
    }
    try {
      const moved = await inTransaction(connection, async () => {
        if (!(await markIndexAvailable(connection, review.reviewId))) return false;
        await ledger.record(connection, {
          action: "rent_review.index_available",
          actor: CPI_TIMER_ACTOR,
          after: {
            ownerUserId: review.ownerUserId,
            previousQuarter: review.previousQuarter,
            referenceQuarter: review.referenceQuarter,
            region: review.region,
            state: "in_progress",
          },
          before: { state: "awaiting_index" },
          buildingId: review.buildingId,
          ruleApplied: "reference_quarter_published",
          subject: { id: review.reviewId, type: "rent_review" },
          tenantId: review.tenantId,
        });
        return true;
      });
      if (moved) {
        report.resumed += 1;
        invalidateTenantAndBuilding(review.tenantId, review.buildingId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push({ message, reviewId: review.reviewId });
      run.warn(`cpi sync: rent review ${review.reviewId} couldn't go back to in progress: ${message}`);
      Sentry.captureException(error, { extra: { context: "tenancyCpiSyncTimer index resume", reviewId: review.reviewId } });
    }
  }
  run.log(
    `cpi sync: ${run.dryRun ? "would return" : "returned"} ${report.resumed} rent review(s) waiting for the index to in progress; ` +
      `${report.waiting} still waiting, ${report.errors.length} failed`,
  );
  return report;
}
