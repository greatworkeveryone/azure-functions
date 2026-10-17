// REVERT (PLAN §3.1): an applied review goes back to in progress, and the
// schedule goes back to how it was before APPLY, in the caller's transaction.
//
//   1. APPLY's own ledger row (rent_review.apply, append-only) says what it
//      wrote: the change-log ids of the steps it wrote, and the tenancy's review
//      fields before and after
//   2. those steps are restored from the change log (rentReview/stepPlan.ts
//      undoChanges): a row APPLY added is removed, a row it updated gets its
//      earlier values back. If any of them, or the tenancy's review fields, has
//      been changed since, the revert is refused (409 changed_since_apply)
//      rather than undo someone else's edit
//   3. first, the next review APPLY scheduled is cancelled (ledgered), or the
//      one-open-review index (migration 101) would refuse this review going back
//      to in progress. Only one nobody has started (scheduled or due): one in
//      progress is 409 next_review_in_progress
//   4. the review -> in_progress (outcome, approval, submission and calc
//      cleared; billing confirmation cleared, so the arrears line is unbilled)
//   5. the steps and LastReviewDate, LastReviewIncreasePercent and RentPerAnnum
//      (if APPLY wrote it, or the generator wrote a cache APPLY deferred)
//      restored, ScheduleVersion + 1 (sign-off kept), NextReviewDate re-derived
//      with this review's date open again
//   6. rent_review.revert in the ledger: an exception, with the reason and the
//      annual increase undone as its financialImpact

import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { todayInDarwin } from "../darwinDate";
import { executeQuery, type SqlRow } from "../db";
import * as ledger from "../ledger";
import type { LedgerActor } from "../ledger";
import { sqlDateToIso } from "../nextReviewDate";
import { appliedCascade, arrearsFor, parseCalc, reviewChanges } from "../rentReviewCalc";
import { insertRentScheduleChangeLog, loadChangeLogEntries } from "../rentScheduleChangeLog";
import { parseReliefs } from "../scheduleCharges";
import { diffSteps, parseSteps } from "../scheduledRateStepLogic";
import { RentReviewError } from "./http";
import {
  decimalOf,
  derivedNextReview,
  refuseClosedTenancy,
  resolvedReviewDatesNow,
  tenancyReviewFields,
  writeTenancyForReview,
} from "./reviewTenancy";
import { undoChanges } from "./stepPlan";
import { lockTenancyForReview, otherOpenReview, reviewForUpdate } from "./store";
import { markCancelled, markReverted } from "./transitions";

const APPLY_ROW_SQL = `SELECT TOP 1 LedgerId, [Before], [After]
  FROM dbo.DecisionLedger
  WHERE SubjectType = N'rent_review' AND SubjectId = @ReviewId AND Action = N'rent_review.apply'
  ORDER BY LedgerId DESC`;

// The generator's write of a cache APPLY deferred (rentReview/rentCache.ts, L10).
const CACHE_ROW_SQL = `SELECT TOP 1 LedgerId, [Before], [After]
  FROM dbo.DecisionLedger
  WHERE SubjectType = N'rent_review' AND SubjectId = @ReviewId AND Action = N'rent_review.rent_cache'
    AND LedgerId > @ApplyLedgerId
  ORDER BY LedgerId DESC`;

interface ApplyRecord {
  rentPerAnnumWritten: boolean;
  scheduleChanges: Array<{ changeId: string; stepId: string }>;
  tenancyAfter: Record<string, unknown>;
  tenancyBefore: Record<string, unknown>;
}

const objectOf = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

async function loadApplyRecord(connection: Connection, reviewId: string): Promise<ApplyRecord | null> {
  const rows = await executeQuery(connection, APPLY_ROW_SQL, [{ name: "ReviewId", type: TYPES.NVarChar, value: reviewId }]);
  if (rows.length === 0) return null;
  try {
    const before = objectOf(JSON.parse(String(rows[0].Before ?? "null")));
    const after = objectOf(JSON.parse(String(rows[0].After ?? "null")));
    const changes = Array.isArray(after.scheduleChanges) ? after.scheduleChanges : [];
    // A deferred cache the generator wrote on the date counts as written, from what it was then.
    const cached =
      after.rentPerAnnumCache === "deferred"
        ? (
            await executeQuery(connection, CACHE_ROW_SQL, [
              { name: "ReviewId", type: TYPES.NVarChar, value: reviewId },
              { name: "ApplyLedgerId", type: TYPES.BigInt, value: Number(rows[0].LedgerId) },
            ])
          )[0]
        : undefined;
    if (cached) {
      const cacheBefore = objectOf(JSON.parse(String(cached.Before ?? "null")));
      const cacheAfter = objectOf(JSON.parse(String(cached.After ?? "null")));
      before.tenancy = { ...objectOf(before.tenancy), rentPerAnnum: cacheBefore.rentPerAnnum ?? null };
      after.tenancy = { ...objectOf(after.tenancy), rentPerAnnum: cacheAfter.rentPerAnnum ?? null };
    }
    return {
      rentPerAnnumWritten: after.rentPerAnnumCache === "written" || cached !== undefined,
      scheduleChanges: changes
        .map((change) => objectOf(change))
        .filter((change) => typeof change.changeId === "string" && typeof change.stepId === "string")
        .map((change) => ({ changeId: change.changeId as string, stepId: change.stepId as string })),
      tenancyAfter: objectOf(after.tenancy),
      tenancyBefore: objectOf(before.tenancy),
    };
  } catch {
    return null;
  }
}

const same = (a: unknown, b: unknown): boolean => {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (typeof a === "number" || typeof b === "number") return Math.abs(Number(a) - Number(b)) < 1e-6;
  return a === b;
};

export interface RevertInput {
  actor: Extract<LedgerActor, { kind: "user" }>;
  actorOid: string;
  correlationId: string;
  reason: string;
  /** The review row, locked by the caller and checked to be approved. */
  review: SqlRow;
  today: string;
}

export interface RevertResult {
  buildingId: number;
  /** The next review cancelled first, if there was one. */
  cancelledNext: { reviewId: string; scheduledFor: string } | null;
  tenantId: number;
}

export async function revertReview(connection: Connection, input: RevertInput): Promise<RevertResult> {
  const { review } = input;
  const reviewId = String(review.ReviewId);
  const tenantId = Number(review.TenantId);
  const scheduledFor = sqlDateToIso(review.ScheduledFor) ?? "";

  const tenancy = await lockTenancyForReview(connection, tenantId);
  if (!tenancy) throw new RentReviewError("not_found", "That review's tenancy doesn't exist");
  refuseClosedTenancy(tenancy);
  const buildingId = Number(tenancy.BuildingId);

  const record = await loadApplyRecord(connection, reviewId);
  if (!record || record.scheduleChanges.length === 0) {
    throw new RentReviewError("not_revertible", "This review's record of what it applied can't be found, so it can't be reverted safely");
  }
  const logged = await loadChangeLogEntries(connection, tenantId, record.scheduleChanges.map((change) => change.changeId));
  if (logged.length !== record.scheduleChanges.length) {
    throw new RentReviewError("not_revertible", "Part of this review's schedule history can't be found, so it can't be reverted safely");
  }
  const steps = parseSteps(tenancy.ScheduledRateSteps as string | null | undefined);
  const undone = undoChanges(steps, logged);
  if (!undone.ok) {
    throw new RentReviewError(
      "changed_since_apply",
      "The schedule row this review wrote has been changed since it was applied, so it can't be reverted. Change the schedule back by hand.",
      { stepId: undone.stepId },
    );
  }
  const now = tenancyReviewFields(tenancy);
  const checked: Array<"lastReviewDate" | "lastReviewIncreasePercent" | "rentPerAnnum"> = [
    "lastReviewDate",
    "lastReviewIncreasePercent",
    ...(record.rentPerAnnumWritten ? (["rentPerAnnum"] as const) : []),
  ];
  for (const field of checked) {
    if (!same(now[field], record.tenancyAfter[field])) {
      throw new RentReviewError(
        "changed_since_apply",
        "The tenancy's review details have been changed since this review was applied, so it can't be reverted. Change them back by hand.",
        { field },
      );
    }
  }

  // The next review APPLY scheduled goes first: the tenancy can hold one open review.
  let cancelledNext: RevertResult["cancelledNext"] = null;
  const nextId = await otherOpenReview(connection, tenantId, reviewId);
  if (nextId) {
    const next = await reviewForUpdate(connection, nextId);
    const nextDate = sqlDateToIso(next?.ScheduledFor) ?? "";
    if (!next || (next.State !== "scheduled" && next.State !== "due") || nextDate <= scheduledFor) {
      throw new RentReviewError(
        "next_review_in_progress",
        "The tenancy's next review has already been started, so this one can't go back to in progress. Cancel or finish that one first.",
        { reviewId: nextId },
      );
    }
    if (!(await markCancelled(connection, nextId))) {
      throw new RentReviewError("next_review_in_progress", "The tenancy's next review just moved on; try again", { reviewId: nextId });
    }
    await ledger.record(connection, {
      action: "rent_review.cancel",
      actor: input.actor,
      after: { kind: "superseded", replacement: "none: the review before it was reverted and is open again", state: "cancelled" },
      before: { state: next.State },
      buildingId,
      correlationId: input.correlationId,
      reason: `The review of ${scheduledFor} was reverted, so the next one isn't due yet: ${input.reason}`.slice(0, 2000),
      ruleApplied: "revert_supersedes_next",
      subject: { id: nextId, type: "rent_review" },
      tenantId,
    });
    cancelledNext = { reviewId: nextId, scheduledFor: nextDate };
  }

  const oldAnnual = decimalOf(review.OldRentPerAnnum);
  const newAnnual = decimalOf(review.NewRentPerAnnum);
  // Read before markReverted clears it: the charges the review changed, for the voided arrears line.
  const appliedCalc = parseCalc(review.Calc);
  const appliedAt = review.ApprovedAt instanceof Date ? review.ApprovedAt : null;
  if (!(await markReverted(connection, reviewId))) {
    throw new RentReviewError("invalid_state", "This review just moved on, so it wasn't reverted");
  }

  // The restored rows, in the change log as the review writes them.
  const changedBy = { buildingId, changedById: input.actorOid, changedByName: input.actor.name, tenantId };
  const restoredChanges: Array<{ changeId: string; kind: "deleted" | "updated"; stepId: string }> = [];
  for (const restored of undone.restored) {
    const kind = restored.after === null ? "deleted" : "updated";
    restoredChanges.push({
      changeId: await insertRentScheduleChangeLog(connection, {
        ...changedBy,
        changeKind: kind,
        diff: restored.after ? diffSteps(restored.before, restored.after) : null,
        stepId: restored.stepId,
        stepSnapshot: restored.after ?? restored.before,
      }),
      kind,
      stepId: restored.stepId,
    });
  }

  const restoredLast = (record.tenancyBefore.lastReviewDate as string | null | undefined) ?? null;
  const restoredPercent = (record.tenancyBefore.lastReviewIncreasePercent as number | null | undefined) ?? null;
  const next = derivedNextReview(
    tenancy,
    undone.steps,
    { lastReviewDate: restoredLast, resolvedReviewDates: await resolvedReviewDatesNow(connection, tenantId) },
    input.today,
  );
  const scheduleVersion = await writeTenancyForReview(connection, {
    actorName: input.actor.name,
    actorOid: input.actorOid,
    lastReviewDate: restoredLast,
    lastReviewIncreasePercent: restoredPercent,
    nextReviewDate: next?.after ?? null,
    ...(record.rentPerAnnumWritten ? { rentPerAnnum: (record.tenancyBefore.rentPerAnnum as number | null | undefined) ?? null } : {}),
    steps: undone.steps,
    tenantId,
  });

  const arrears =
    oldAnnual !== null && newAnnual !== null && appliedAt
      ? arrearsFor(
          scheduledFor,
          todayInDarwin(appliedAt),
          reviewChanges(oldAnnual, newAnnual, appliedCascade(appliedCalc)),
          parseReliefs(tenancy.RentReliefs as string | null | undefined),
        )
      : null;
  await ledger.record(connection, {
    action: "rent_review.revert",
    actor: input.actor,
    after: {
      arrears: arrears ? { ...arrears, billed: false, status: "void: the review was reverted" } : null,
      nextReviewCancelled: cancelledNext,
      scheduleChanges: restoredChanges,
      state: "in_progress",
      steps: undone.restored.map((restored) => ({ step: restored.after, stepId: restored.stepId })),
      tenancy: {
        lastReviewDate: restoredLast,
        lastReviewIncreasePercent: restoredPercent,
        nextReviewDate: next?.after ?? now.nextReviewDate,
        rentPerAnnum: record.rentPerAnnumWritten ? (record.tenancyBefore.rentPerAnnum ?? null) : now.rentPerAnnum,
        scheduleVersion,
      },
    },
    before: {
      outcome: { newAnnual, oldAnnual },
      state: "approved",
      steps: undone.restored.map((restored) => ({ step: restored.before, stepId: restored.stepId })),
      tenancy: now,
    },
    buildingId,
    correlationId: input.correlationId,
    // The annual increase undone: at risk until the review is decided again.
    financialImpact: oldAnnual !== null && newAnnual !== null ? Math.round((newAnnual - oldAnnual) * 100) / 100 : null,
    reason: input.reason,
    ruleApplied: "revert_from_change_log",
    subject: { id: reviewId, type: "rent_review" },
    tenantId,
  });

  return { buildingId, cancelledNext, tenantId };
}
