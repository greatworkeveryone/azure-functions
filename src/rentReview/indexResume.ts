// INDEX_AVAILABLE (PLAN §3.1, WP26): after the CPI sync has stored ABS's
// quarters, every CPI review waiting for its index whose two quarters are now
// published, on one base, goes back to in progress for its owner to calculate.
// The CPI timer runs it after each successful sync (and, in its dry run, only
// says what it would move).
//
// Each review moves in a transaction of its own, only if it is still waiting
// (someone may have cancelled or waived it since), ledgered as
// rent_review.index_available by the system (the timer). It is then calculated
// straight away, in a second transaction, as the system (L7): the same
// calculation CALCULATE runs (rentReview/calculate.ts), ledgered as
// rent_review.calculate by the timer, computedBy "Floorplan, when the CPI was
// published". A calculation that is refused (an earlier review unsettled, say)
// or fails leaves the review in progress for its owner to calculate by hand.
// The owner hears of it in Floorplan (D21): the review is theirs and in progress
// again, carrying indexArrived (when, which quarter) until it is submitted, and
// its calc, if Floorplan made one, says so (computedBy.userId null).

import type { Connection } from "tedious";
import { executeQuery } from "../db";
import * as ledger from "../ledger";
import type { LedgerActor } from "../ledger";
import { sqlDateToIso } from "../nextReviewDate";
import { Sentry } from "../sentry";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { type CpiReferenceRule, cpiReferenceRuleOf, parseBasis } from "./basis";
import { previousQuarter, referenceQuarterFor, type CpiIndexRow } from "./cpi";
import { todayInDarwin } from "../darwinDate";
import { parseCalc } from "../rentReviewCalc";
import { workOutReview } from "./calculate";
import { inTransaction, loadCpiRows, loadTenancyForReview, reviewForUpdate } from "./store";
import { markIndexAvailable, saveCalc } from "./transitions";

export const CPI_TIMER_ACTOR: LedgerActor = { kind: "system", name: "tenancyCpiSyncTimer" };

/** Who a calculation made by the CPI timer says worked it out. */
export const AUTO_CALC_BY = { name: "Floorplan, when the CPI was published", userId: null } as const;

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
  /** The basis's reference-quarter rule (M4). */
  rule: CpiReferenceRule;
  tenantId: number;
}

/** The quarters a waiting review needs, from its basis and date. Pure. */
export function awaitingReviewOf(row: Record<string, unknown>): AwaitingReview {
  const basis = parseBasis(row.Basis) ?? {};
  const region = typeof basis.region === "string" ? basis.region.toUpperCase() : "";
  const interval = typeof basis.intervalMonths === "number" ? basis.intervalMonths : null;
  const rule = cpiReferenceRuleOf(basis.referenceQuarterRule);
  const reference = referenceQuarterFor(rule, sqlDateToIso(row.ScheduledFor) ?? "");
  return {
    buildingId: Number(row.TenantBuildingId),
    ownerUserId: row.OwnerUserId === null || row.OwnerUserId === undefined ? null : Number(row.OwnerUserId),
    previousQuarter: previousQuarter(reference, interval),
    referenceQuarter: reference,
    region: region === "AUS" || region === "DARWIN" ? region : null,
    reviewId: String(row.ReviewId),
    rule,
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
  /** Back in progress and calculated straight away. */
  calculated: number;
  errors: Array<{ message: string; reviewId: string }>;
  /** Back in progress but not calculated: why, for the owner to pick up. */
  notCalculated: Array<{ reviewId: string; why: string }>;
  resumed: number;
  /** Still waiting: a quarter not yet published (or on a different base). */
  waiting: number;
}

/** CALCULATE as the system, for a review INDEX_AVAILABLE just moved: "calculated", or why not. */
async function calculateResumed(connection: Connection, review: AwaitingReview, today: string): Promise<string> {
  return inTransaction(connection, async () => {
    const row = await reviewForUpdate(connection, review.reviewId);
    if (!row || row.State !== "in_progress" || parseCalc(row.Calc)) return "it moved on before it could be calculated";
    const tenancy = await loadTenancyForReview(connection, review.tenantId);
    if (!tenancy || tenancy.Status === "vacated" || (tenancy.ArchivedAt !== null && tenancy.ArchivedAt !== undefined)) {
      return "its tenancy is vacated or archived";
    }
    const result = await workOutReview(connection, { computedBy: { ...AUTO_CALC_BY }, manual: null, method: "cpi", review: row, tenancy, today });
    if (result.kind === "index_pending") return "its quarters aren't both published on one base";
    if (result.kind === "refused") return `${result.code}: ${result.message}`;
    if (!(await saveCalc(connection, review.reviewId, JSON.stringify(result.calc)))) return "it moved on before it could be calculated";
    await ledger.record(connection, {
      action: "rent_review.calculate",
      actor: CPI_TIMER_ACTOR,
      after: result.calc,
      buildingId: review.buildingId,
      ruleApplied: `cpi_${review.rule}`,
      subject: { id: review.reviewId, type: "rent_review" },
      tenantId: review.tenantId,
    });
    return "calculated";
  });
}

export async function resumeAwaitingIndex(
  connection: Connection,
  run: { dryRun: boolean; log: (message: string) => void; today?: string; warn: (message: string) => void },
): Promise<IndexResumeReport> {
  const report: IndexResumeReport = { calculated: 0, errors: [], notCalculated: [], resumed: 0, waiting: 0 };
  const today = run.today ?? todayInDarwin();
  const reviews = (await executeQuery(connection, AWAITING_SQL)).map(awaitingReviewOf);
  for (const review of reviews) {
    const rows = review.region ? await loadCpiRows(connection, review.region, [review.referenceQuarter, review.previousQuarter]) : [];
    if (!indexPublished(review, rows)) {
      report.waiting += 1;
      continue;
    }
    if (run.dryRun) {
      run.log(`cpi sync dry run: would return rent review ${review.reviewId} to in progress and calculate it (${review.referenceQuarter} is published)`);
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
      if (!moved) continue;
      report.resumed += 1;
      invalidateTenantAndBuilding(review.tenantId, review.buildingId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.errors.push({ message, reviewId: review.reviewId });
      run.warn(`cpi sync: rent review ${review.reviewId} couldn't go back to in progress: ${message}`);
      Sentry.captureException(error, { extra: { context: "tenancyCpiSyncTimer index resume", reviewId: review.reviewId } });
      continue;
    }
    // In progress again: calculate it now, so the owner finds it ready to check and submit.
    try {
      const outcome = await calculateResumed(connection, review, today);
      if (outcome === "calculated") report.calculated += 1;
      else {
        report.notCalculated.push({ reviewId: review.reviewId, why: outcome });
        run.warn(`cpi sync: rent review ${review.reviewId} is back in progress but wasn't calculated: ${outcome}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      report.notCalculated.push({ reviewId: review.reviewId, why: message });
      run.warn(`cpi sync: rent review ${review.reviewId} is back in progress but its calculation failed: ${message}`);
      Sentry.captureException(error, { extra: { context: "tenancyCpiSyncTimer index resume calculate", reviewId: review.reviewId } });
    }
  }
  run.log(
    `cpi sync: ${run.dryRun ? "would return" : "returned"} ${report.resumed} rent review(s) waiting for the index to in progress ` +
      `(${run.dryRun ? "each to be" : `${report.calculated}`} calculated); ${report.waiting} still waiting, ${report.errors.length} failed`,
  );
  return report;
}
