// The review-row writes of WP26's transitions (PLAN §3.1). Each moves one
// review from the state(s) it must be in, sets the legacy Status the old CHECK
// accepts (legacyMap.ts), stamps UpdatedAt, and returns false when the review
// had already moved on (the caller holds its update lock, so that means it was
// changed outside this request). Callers own the transaction and the ledger row.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { executeQuery, type SqlParam } from "../db";
import { OPEN_RENT_REVIEW_STATES, type RentReviewState } from "../rentReviewMachine";
import { legacyStatus } from "./legacyMap";

const MONEY = { precision: 20, scale: 10 } as const;
const PERCENT = { precision: 13, scale: 10 } as const;
const INDEX = { precision: 16, scale: 10 } as const;

async function move(
  connection: Connection,
  reviewId: string,
  from: readonly RentReviewState[],
  to: RentReviewState,
  setClause: string,
  params: SqlParam[] = [],
): Promise<boolean> {
  const placeholders = from.map((_, index) => `@From${index}`).join(", ");
  const rows = await executeQuery(
    connection,
    `UPDATE dbo.RentReviews
       SET State = @To, Status = @Status, ${setClause}, UpdatedAt = SYSUTCDATETIME()
     OUTPUT INSERTED.ReviewId
     WHERE ReviewId = @ReviewId AND State IN (${placeholders})`,
    [
      { name: "ReviewId", type: TYPES.NVarChar, value: reviewId },
      { name: "To", type: TYPES.NVarChar, value: to },
      { name: "Status", type: TYPES.NVarChar, value: legacyStatus(to) },
      ...from.map((state, index) => ({ name: `From${index}`, type: TYPES.NVarChar, value: state })),
      ...params,
    ],
  );
  return rows.length > 0;
}

/** Calculate: the receipt, on an in-progress review. */
export async function saveCalc(connection: Connection, reviewId: string, calcJson: string): Promise<boolean> {
  return move(connection, reviewId, ["in_progress"], "in_progress", "Calc = @Calc", [
    { name: "Calc", type: TYPES.NVarChar, value: calcJson },
  ]);
}

/** INDEX_PENDING: in_progress -> awaiting_index, with when the quarter is expected. */
export async function markAwaitingIndex(connection: Connection, reviewId: string, expectedIndexAt: string): Promise<boolean> {
  return move(connection, reviewId, ["in_progress"], "awaiting_index", "ExpectedIndexAt = @ExpectedIndexAt, Calc = NULL", [
    { name: "ExpectedIndexAt", type: TYPES.Date, value: expectedIndexAt },
  ]);
}

/** INDEX_AVAILABLE: awaiting_index -> in_progress. */
export async function markIndexAvailable(connection: Connection, reviewId: string): Promise<boolean> {
  return move(connection, reviewId, ["awaiting_index"], "in_progress", "ExpectedIndexAt = NULL");
}

export interface Person {
  name: string;
  userId: number | null;
}

/** SUBMIT to approval: in_progress -> awaiting_approval, the preparer stamped,
 *  the calc as submitted (with any override). */
export async function markSubmitted(connection: Connection, reviewId: string, preparer: Person, calcJson: string): Promise<boolean> {
  return move(
    connection,
    reviewId,
    ["in_progress"],
    "awaiting_approval",
    "PreparedById = @PreparedById, PreparedByName = @PreparedByName, PreparedAt = SYSUTCDATETIME(), SubmittedAt = SYSUTCDATETIME(), Calc = @Calc",
    [
      { name: "PreparedById", type: TYPES.Int, value: preparer.userId },
      { name: "PreparedByName", type: TYPES.NVarChar, value: preparer.name },
      { name: "Calc", type: TYPES.NVarChar, value: calcJson },
    ],
  );
}

export interface ApprovedOutcome {
  /** "auto_in_bounds" (the preparer applied an in-bounds result) or "approved" (a second person). */
  approvalBasis: string;
  approver: Person;
  /** The calc as applied (the submitted one, with any override and its receipt). */
  calcJson: string;
  cpi: { current: number; indexUsed: string; previous: number } | null;
  increasePercent: number;
  newAnnual: number;
  oldAnnual: number;
  /** Set on SUBMIT's one-step path: the preparer is the applier. */
  preparer: Person | null;
  stepId: string;
}

/** APPLY's review half: in_progress (SUBMIT, one step) or awaiting_approval
 *  (APPROVE) -> approved, with the outcome in the review's own columns and the
 *  calc as applied, whose receipt the outcome's arrears are read from. */
export async function markApproved(
  connection: Connection,
  reviewId: string,
  from: "awaiting_approval" | "in_progress",
  outcome: ApprovedOutcome,
): Promise<boolean> {
  const prepared = outcome.preparer
    ? ", PreparedById = @PreparedById, PreparedByName = @PreparedByName, PreparedAt = SYSUTCDATETIME(), SubmittedAt = SYSUTCDATETIME()"
    : "";
  return move(
    connection,
    reviewId,
    [from],
    "approved",
    `ApprovedById = @ApprovedById, ApprovedByName = @ApprovedByName, ApprovedAt = SYSUTCDATETIME(), ApprovalBasis = @ApprovalBasis,
     OldRentPerAnnum = @OldRentPerAnnum, NewRentPerAnnum = @NewRentPerAnnum, IncreasePercent = @IncreasePercent,
     CpiIndexUsed = @CpiIndexUsed, CpiBaseValue = @CpiBaseValue, CpiCurrentValue = @CpiCurrentValue, StepId = @StepId,
     Calc = @Calc${prepared}`,
    [
      { name: "Calc", type: TYPES.NVarChar, value: outcome.calcJson },
      { name: "ApprovedById", type: TYPES.Int, value: outcome.approver.userId },
      { name: "ApprovedByName", type: TYPES.NVarChar, value: outcome.approver.name },
      { name: "ApprovalBasis", type: TYPES.NVarChar, value: outcome.approvalBasis },
      { name: "OldRentPerAnnum", options: MONEY, type: TYPES.Decimal, value: outcome.oldAnnual },
      { name: "NewRentPerAnnum", options: MONEY, type: TYPES.Decimal, value: outcome.newAnnual },
      { name: "IncreasePercent", options: PERCENT, type: TYPES.Decimal, value: outcome.increasePercent },
      { name: "CpiIndexUsed", type: TYPES.NVarChar, value: outcome.cpi?.indexUsed ?? null },
      { name: "CpiBaseValue", options: INDEX, type: TYPES.Decimal, value: outcome.cpi?.previous ?? null },
      { name: "CpiCurrentValue", options: INDEX, type: TYPES.Decimal, value: outcome.cpi?.current ?? null },
      { name: "StepId", type: TYPES.NVarChar, value: outcome.stepId },
      ...(outcome.preparer
        ? [
            { name: "PreparedById", type: TYPES.Int, value: outcome.preparer.userId },
            { name: "PreparedByName", type: TYPES.NVarChar, value: outcome.preparer.name },
          ]
        : []),
    ],
  );
}

/** RETURN: awaiting_approval -> in_progress; no longer submitted. */
export async function markReturned(connection: Connection, reviewId: string): Promise<boolean> {
  return move(connection, reviewId, ["awaiting_approval"], "in_progress", "SubmittedAt = NULL");
}

/** WAIVE: any open state -> waived, with the reason and the step it settled. */
export async function markWaived(connection: Connection, reviewId: string, reason: string, stepId: string): Promise<boolean> {
  return move(connection, reviewId, OPEN_RENT_REVIEW_STATES, "waived", "WaiveReason = @WaiveReason, StepId = @StepId", [
    { name: "WaiveReason", type: TYPES.NVarChar, value: reason },
    { name: "StepId", type: TYPES.NVarChar, value: stepId },
  ]);
}

/** CANCEL: any open state -> cancelled. The reason is the ledger row's. */
export async function markCancelled(connection: Connection, reviewId: string): Promise<boolean> {
  return move(connection, reviewId, OPEN_RENT_REVIEW_STATES, "cancelled", "ExpectedIndexAt = NULL");
}

/** REVERT: approved -> in_progress. The outcome, the approval and the
 *  submission go (they are in the ledger); the calc too, because the schedule
 *  it was worked on has changed back. Billing confirmation goes with them: the
 *  arrears line is unbilled again. */
export async function markReverted(connection: Connection, reviewId: string): Promise<boolean> {
  return move(
    connection,
    reviewId,
    ["approved"],
    "in_progress",
    `ApprovedById = NULL, ApprovedByName = NULL, ApprovedAt = NULL, ApprovalBasis = NULL,
     OldRentPerAnnum = NULL, NewRentPerAnnum = NULL, IncreasePercent = NULL,
     CpiIndexUsed = NULL, CpiBaseValue = NULL, CpiCurrentValue = NULL,
     PreparedById = NULL, PreparedByName = NULL, PreparedAt = NULL, SubmittedAt = NULL,
     BillingConfirmedAt = NULL, BillingConfirmedBy = NULL, Calc = NULL`,
  );
}
