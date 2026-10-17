// SQL for review instances. Every statement is parameterised, every query that
// reads a review ignores legacy rows (State IS NULL): rows written before the
// workflow keep their old shape and are not instances (migration 101).
//
// A writer holds an update lock on the review row (reviewForUpdate), checks the
// RowVersion the caller read, writes, and ledgers, all in one transaction.

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import {
  beginTransaction,
  commitTransaction,
  executeQuery,
  type SqlParam,
  type SqlRow,
} from "../db";
import { RESOLVED_REVIEW_DATES_SQL } from "../nextReviewDate";
import { OPEN_RENT_REVIEW_STATES, type RentReviewMethod, type RentReviewState } from "../rentReviewMachine";
import { SIGN_OFF_COLUMNS } from "../scheduleSignOff";
import { rollbackQuietly } from "../tenancyScheduleWrite";
import type { CpiIndexRow } from "./cpi";
import { legacyReviewType, legacyStatus } from "./legacyMap";

/** The most rows a list returns; matches pagination.ts's ceiling. */
export const REVIEW_LIST_LIMIT = 5000;

const REVIEW_COLUMNS = `
  r.ReviewId, r.TenantId, r.ScheduledFor, r.Status, r.ReviewType, r.State, r.Method, r.StepId,
  r.BuildingId, r.OwnerUserId, r.Basis, r.Calc,
  r.PreparedById, r.PreparedByName, r.PreparedAt, r.SubmittedAt,
  r.ApprovedById, r.ApprovedByName, r.ApprovedAt, r.ApprovalBasis,
  r.NoticeIssuedAt, r.NoticeIssuedBy, r.NoticeMethod,
  r.BillingConfirmedAt, r.BillingConfirmedBy,
  r.WaiveReason, r.ExpectedIndexAt, r.CreatedAt, r.UpdatedAt, r.Version,
  r.OldRentPerAnnum, r.NewRentPerAnnum, r.IncreasePercent,
  t.BuildingId AS TenantBuildingId, t.LegalName, t.TradingName, t.Status AS TenantStatus,
  t.ArchivedAt AS TenantArchivedAt, t.RentReliefs AS TenantRentReliefs,
  u.DisplayName AS OwnerName,
  lr.ReturnedAt, lr.ReturnedByName, lr.ReturnNote,
  ia.IndexArrivedAt, ia.IndexArrivedQuarter,
  ar.ApprovalRung, cr.CancelReason`;

// The last RETURN of a review that is back in progress and hasn't been
// submitted since (WP26): the latest rent_review.return row in the decision
// ledger with no rent_review.submit after it. RETURN clears SubmittedAt, so the
// ledger is the only record that the review came back, and from whom, with
// what note. Read for in-progress reviews only; IX_DecisionLedger_Subject
// (SubjectType, SubjectId, ...) serves both lookups, a handful of rows each.
const LAST_RETURN = `
  OUTER APPLY (
    SELECT TOP 1 l.OccurredAt AS ReturnedAt, l.ActorName AS ReturnedByName, l.Reason AS ReturnNote
    FROM dbo.DecisionLedger l
    WHERE r.State = 'in_progress'
      AND l.SubjectType = N'rent_review' AND l.SubjectId = r.ReviewId AND l.Action = N'rent_review.return'
      AND NOT EXISTS (
        SELECT 1 FROM dbo.DecisionLedger s
        WHERE s.SubjectType = N'rent_review' AND s.SubjectId = r.ReviewId
          AND s.Action = N'rent_review.submit' AND s.LedgerId > l.LedgerId)
    ORDER BY l.LedgerId DESC
  ) lr`;

// The CPI index a waiting review needed was published (L7): the latest
// rent_review.index_available row while the review is in progress and hasn't
// been submitted since, so its owner sees why it is back and what to do.
const LAST_INDEX_ARRIVAL = `
  OUTER APPLY (
    SELECT TOP 1 a.OccurredAt AS IndexArrivedAt, JSON_VALUE(a.[After], '$.referenceQuarter') AS IndexArrivedQuarter
    FROM dbo.DecisionLedger a
    WHERE r.State = 'in_progress'
      AND a.SubjectType = N'rent_review' AND a.SubjectId = r.ReviewId AND a.Action = N'rent_review.index_available'
      AND NOT EXISTS (
        SELECT 1 FROM dbo.DecisionLedger s
        WHERE s.SubjectType = N'rent_review' AND s.SubjectId = r.ReviewId
          AND s.Action = N'rent_review.submit' AND s.LedgerId > a.LedgerId)
    ORDER BY a.LedgerId DESC
  ) ia`;

// C7's rung while the review waits for approval: the highest any E3 has reached
// since the review was last submitted, live or not (1 accounts_manager, 2 cfo,
// 3 director; nobody independent left, or a role it doesn't know, counts as
// the directors). APPROVE reads it from the locked row and the review's DTO
// shows it, so the two can't disagree (rentReview/approvalLevel.ts).
const APPROVAL_RUNG = `
  OUTER APPLY (
    SELECT MAX(CASE
        WHEN e.NoIndependentTarget = 1 THEN 3
        WHEN e.TargetRole = N'accounts_manager' THEN 1
        WHEN e.TargetRole = N'cfo' THEN 2
        ELSE 3 END) AS ApprovalRung
    FROM dbo.Escalations e
    WHERE r.State = 'awaiting_approval'
      AND e.SubjectType = N'rent_review' AND e.SubjectId = r.ReviewId AND e.PolicyKey = N'rent_review.approval'
      AND (r.SubmittedAt IS NULL OR e.CreatedAt >= r.SubmittedAt)
  ) ar`;

// A cancelled review's reason: CANCEL records it in the ledger, not on the row.
const LAST_CANCEL = `
  OUTER APPLY (
    SELECT TOP 1 c.Reason AS CancelReason
    FROM dbo.DecisionLedger c
    WHERE r.State = 'cancelled'
      AND c.SubjectType = N'rent_review' AND c.SubjectId = r.ReviewId AND c.Action = N'rent_review.cancel'
    ORDER BY c.LedgerId DESC
  ) cr`;

const REVIEW_JOINS = `
  INNER JOIN dbo.Tenants t ON t.TenantId = r.TenantId
  LEFT JOIN dbo.AppUsers u ON u.UserID = r.OwnerUserId
  ${LAST_RETURN}
  ${LAST_INDEX_ARRIVAL}
  ${APPROVAL_RUNG}
  ${LAST_CANCEL}`;

const REVIEW_BY_ID = `SELECT ${REVIEW_COLUMNS} FROM dbo.RentReviews r ${REVIEW_JOINS}
  WHERE r.ReviewId = @ReviewId AND r.State IS NOT NULL`;

const REVIEW_BY_ID_FOR_UPDATE = `SELECT ${REVIEW_COLUMNS} FROM dbo.RentReviews r WITH (UPDLOCK, ROWLOCK) ${REVIEW_JOINS}
  WHERE r.ReviewId = @ReviewId AND r.State IS NOT NULL`;

export async function loadReview(connection: Connection, reviewId: string): Promise<SqlRow | null> {
  const rows = await executeQuery(connection, REVIEW_BY_ID, [{ name: "ReviewId", type: TYPES.NVarChar, value: reviewId }]);
  return rows[0] ?? null;
}

/** The review, locked for the rest of the transaction. */
export async function reviewForUpdate(connection: Connection, reviewId: string): Promise<SqlRow | null> {
  const rows = await executeQuery(connection, REVIEW_BY_ID_FOR_UPDATE, [
    { name: "ReviewId", type: TYPES.NVarChar, value: reviewId },
  ]);
  return rows[0] ?? null;
}

export interface ReviewFilters {
  buildingId?: number;
  states?: readonly RentReviewState[];
  tenantId?: number;
}

/** Reviews matching every filter given, newest review date first. A list across
 *  tenancies (a building, a state) leaves out the reviews of archived tenancies
 *  (D4); naming one tenancy by id still returns its reviews, so its page can show
 *  the history. */
export async function loadReviews(connection: Connection, filters: ReviewFilters): Promise<SqlRow[]> {
  const whereParts: string[] = ["r.State IS NOT NULL"];
  const params: SqlParam[] = [{ name: "Limit", type: TYPES.Int, value: REVIEW_LIST_LIMIT }];
  if (filters.tenantId !== undefined) {
    whereParts.push("r.TenantId = @TenantId");
    params.push({ name: "TenantId", type: TYPES.Int, value: filters.tenantId });
  }
  if (filters.buildingId !== undefined) {
    whereParts.push("t.BuildingId = @BuildingId");
    params.push({ name: "BuildingId", type: TYPES.Int, value: filters.buildingId });
  }
  if (filters.states && filters.states.length > 0) {
    const placeholders = filters.states.map((_, index) => `@State${index}`).join(", ");
    whereParts.push(`r.State IN (${placeholders})`);
    filters.states.forEach((state, index) => params.push({ name: `State${index}`, type: TYPES.NVarChar, value: state }));
  }
  if (filters.tenantId === undefined) whereParts.push("t.ArchivedAt IS NULL");
  const whereSql = whereParts.join(" AND ");
  return executeQuery(
    connection,
    `SELECT TOP (@Limit) ${REVIEW_COLUMNS} FROM dbo.RentReviews r ${REVIEW_JOINS}
     WHERE ${whereSql}
     ORDER BY r.ScheduledFor DESC, r.CreatedAt DESC`,
    params,
  );
}

const TENANCY_FOR_REVIEW = `SELECT t.TenantId, t.BuildingId, t.LegalName, t.TradingName, t.Status, t.ArchivedAt,
    t.Commencement, t.Expiry, t.ReviewType, t.ReviewIntervalMonths, t.LastReviewDate, t.FixedReviewPercent,
    t.CpiRegion, t.CpiCapPercent, t.CpiFloorPercent, t.ReviewRatchet, t.RentPerAnnum, t.ScheduleVersion,
    t.ScheduledRateSteps, t.CarparkScheduleGroups, t.MiscFees, t.RentReliefs, b.BuildingName,
    t.ScheduleSignedOffAt, t.ScheduleSignedOffByName
  FROM dbo.Tenants t
  LEFT JOIN dbo.Buildings b ON b.BuildingID = t.BuildingId
  WHERE t.TenantId = @TenantId`;

/** The lease terms a review is decided on, one tenancy. */
export async function loadTenancyForReview(connection: Connection, tenantId: number): Promise<SqlRow | null> {
  const rows = await executeQuery(connection, TENANCY_FOR_REVIEW, [{ name: "TenantId", type: TYPES.Int, value: tenantId }]);
  return rows[0] ?? null;
}

const TENANCY_LOCKED_FOR_REVIEW = `SELECT t.TenantId, t.BuildingId, t.Status, t.ArchivedAt, t.ScheduleVersion,
    t.Commencement, t.LastReviewDate, t.LastReviewIncreasePercent, t.ReviewIntervalMonths, t.NextReviewDate,
    t.ReviewType, t.FixedReviewPercent, t.CpiRegion, t.CpiCapPercent, t.CpiFloorPercent, t.ReviewRatchet,
    t.RentPerAnnum, t.ScheduledRateSteps, t.CarparkScheduleGroups, t.MiscFees, t.RentReliefs, t.UpdatedAt, t.UpdatedByName,
    ${SIGN_OFF_COLUMNS},
    ${RESOLVED_REVIEW_DATES_SQL}
  FROM dbo.Tenants t WITH (UPDLOCK, ROWLOCK)
  WHERE t.TenantId = @TenantId`;

/** The review's tenancy, locked for the rest of the transaction: what APPLY,
 *  WAIVE and REVERT read and write (PLAN §3.1: "lock the tenant row"). */
export async function lockTenancyForReview(connection: Connection, tenantId: number): Promise<SqlRow | null> {
  const rows = await executeQuery(connection, TENANCY_LOCKED_FOR_REVIEW, [{ name: "TenantId", type: TYPES.Int, value: tenantId }]);
  return rows[0] ?? null;
}

/** Total leaseable area of the tenancy: the schedule's rent is worked from it. */
export async function totalOccupancySqm(connection: Connection, tenantId: number): Promise<number> {
  const rows = await executeQuery(
    connection,
    `SELECT COALESCE(SUM(SizeSqm), 0) AS Sqm FROM dbo.TenantOccupancies WHERE TenantId = @TenantId`,
    [{ name: "TenantId", type: TYPES.Int, value: tenantId }],
  );
  const sqm = Number(rows[0]?.Sqm ?? 0);
  return Number.isFinite(sqm) ? sqm : 0;
}

/** Another open review on the tenancy (C1), ignoring `exceptReviewId`. The
 *  filtered unique index already makes a second one impossible; this is the
 *  check by name, and the answer where the index is missing. */
export async function otherOpenReview(
  connection: Connection,
  tenantId: number,
  exceptReviewId: string,
): Promise<string | null> {
  const placeholders = OPEN_RENT_REVIEW_STATES.map((_, index) => `@Open${index}`).join(", ");
  const params: SqlParam[] = [
    { name: "TenantId", type: TYPES.Int, value: tenantId },
    { name: "ReviewId", type: TYPES.NVarChar, value: exceptReviewId },
    ...OPEN_RENT_REVIEW_STATES.map((state, index) => ({ name: `Open${index}`, type: TYPES.NVarChar, value: state })),
  ];
  const rows = await executeQuery(
    connection,
    `SELECT TOP 1 ReviewId FROM dbo.RentReviews
     WHERE TenantId = @TenantId AND ReviewId <> @ReviewId AND State IN (${placeholders})`,
    params,
  );
  return rows.length > 0 ? String(rows[0].ReviewId) : null;
}

/** The two CpiIndex rows a CPI suggestion needs (either may not exist yet). */
export async function loadCpiRows(
  connection: Connection,
  region: string,
  periods: readonly [string, string],
): Promise<CpiIndexRow[]> {
  const rows = await executeQuery(
    connection,
    `SELECT Period, IndexValue, ReferenceBase FROM dbo.CpiIndex
     WHERE Region = @Region AND Period IN (@PeriodA, @PeriodB)`,
    [
      { name: "Region", type: TYPES.NVarChar, value: region },
      { name: "PeriodA", type: TYPES.NVarChar, value: periods[0] },
      { name: "PeriodB", type: TYPES.NVarChar, value: periods[1] },
    ],
  );
  return rows.map((row) => ({
    indexValue: Number(row.IndexValue),
    period: String(row.Period),
    referenceBase: typeof row.ReferenceBase === "string" ? row.ReferenceBase : null,
  }));
}

// ── Writes ──────────────────────────────────────────────────────────────────

export interface NewReview {
  buildingId: number;
  method: RentReviewMethod;
  reviewId: string;
  scheduledFor: string;
  tenantId: number;
}

/** SCHEDULE: a new instance in `scheduled`. The filtered unique index on open
 *  reviews rejects a second open one for the tenancy (2601/2627). */
export async function insertScheduledReview(connection: Connection, review: NewReview): Promise<void> {
  await executeQuery(
    connection,
    `INSERT INTO dbo.RentReviews
       (ReviewId, TenantId, ScheduledFor, Status, ReviewType, State, Method, BuildingId, UpdatedAt)
     VALUES
       (@ReviewId, @TenantId, @ScheduledFor, @Status, @ReviewType, 'scheduled', @Method, @BuildingId, SYSUTCDATETIME())`,
    [
      { name: "ReviewId", type: TYPES.NVarChar, value: review.reviewId },
      { name: "TenantId", type: TYPES.Int, value: review.tenantId },
      { name: "ScheduledFor", type: TYPES.Date, value: review.scheduledFor },
      { name: "Status", type: TYPES.NVarChar, value: legacyStatus("scheduled") },
      { name: "ReviewType", type: TYPES.NVarChar, value: legacyReviewType(review.method) },
      { name: "Method", type: TYPES.NVarChar, value: review.method },
      { name: "BuildingId", type: TYPES.Int, value: review.buildingId },
    ],
  );
}

/** OPEN_WINDOW: scheduled -> due, only if it is still scheduled. True when it moved. */
export async function markWindowOpen(connection: Connection, reviewId: string): Promise<boolean> {
  const moved = await executeQuery(
    connection,
    `UPDATE dbo.RentReviews
       SET State = 'due', Status = @Status, UpdatedAt = SYSUTCDATETIME()
     OUTPUT INSERTED.ReviewId
     WHERE ReviewId = @ReviewId AND State = 'scheduled'`,
    [
      { name: "ReviewId", type: TYPES.NVarChar, value: reviewId },
      { name: "Status", type: TYPES.NVarChar, value: legacyStatus("due") },
    ],
  );
  return moved.length > 0;
}

export interface Commencement {
  basisJson: string;
  buildingId: number;
  method: RentReviewMethod;
  ownerUserId: number;
  reviewId: string;
  stepId: string | null;
}

/** COMMENCE: scheduled or due -> in_progress, the owner set, the basis stored. */
export async function markCommenced(connection: Connection, commence: Commencement): Promise<boolean> {
  const moved = await executeQuery(
    connection,
    `UPDATE dbo.RentReviews
       SET State = 'in_progress', Status = @Status, ReviewType = @ReviewType, Method = @Method,
           OwnerUserId = @OwnerUserId, StepId = @StepId, BuildingId = @BuildingId, Basis = @Basis,
           UpdatedAt = SYSUTCDATETIME()
     OUTPUT INSERTED.ReviewId
     WHERE ReviewId = @ReviewId AND State IN ('scheduled', 'due')`,
    [
      { name: "ReviewId", type: TYPES.NVarChar, value: commence.reviewId },
      { name: "Status", type: TYPES.NVarChar, value: legacyStatus("in_progress") },
      { name: "ReviewType", type: TYPES.NVarChar, value: legacyReviewType(commence.method) },
      { name: "Method", type: TYPES.NVarChar, value: commence.method },
      { name: "OwnerUserId", type: TYPES.Int, value: commence.ownerUserId },
      { name: "StepId", type: TYPES.NVarChar, value: commence.stepId },
      { name: "BuildingId", type: TYPES.Int, value: commence.buildingId },
      { name: "Basis", type: TYPES.NVarChar, value: commence.basisJson },
    ],
  );
  return moved.length > 0;
}

/** Replaces the basis of a review that is still being worked on. A calculation
 *  worked on the old basis no longer stands, so it goes with it (WP26). */
export async function saveBasis(connection: Connection, reviewId: string, basisJson: string): Promise<boolean> {
  const saved = await executeQuery(
    connection,
    `UPDATE dbo.RentReviews
       SET Basis = @Basis, Calc = NULL, UpdatedAt = SYSUTCDATETIME()
     OUTPUT INSERTED.ReviewId
     WHERE ReviewId = @ReviewId AND State IN ('in_progress', 'awaiting_index')`,
    [
      { name: "ReviewId", type: TYPES.NVarChar, value: reviewId },
      { name: "Basis", type: TYPES.NVarChar, value: basisJson },
    ],
  );
  return saved.length > 0;
}

/** Runs `work` in a transaction on `connection`: commit when it returns, roll back when it throws. */
export async function inTransaction<T>(connection: Connection, work: () => Promise<T>): Promise<T> {
  await beginTransaction(connection);
  try {
    const result = await work();
    await commitTransaction(connection);
    return result;
  } catch (error) {
    await rollbackQuietly(connection);
    throw error;
  }
}
