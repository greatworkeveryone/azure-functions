// APPLY (PLAN §3.1): an approved rent becomes the schedule, in the caller's
// transaction, so it all commits or none of it does. SUBMIT's one-step path and
// APPROVE both end here.
//
//   1. lock the tenant row (UPDLOCK); C4: its ScheduleVersion is the one the
//      calc was worked on, else 409 stale_schedule; C3: the schedule is signed
//      off, else 422 not_signed_off
//   2. write the step through the schedule engine (cpiValue, the same-base
//      cpiValuePrev, ratePercent, resolution applied, reviewId; or the exact
//      rate an override needs, rentReview/stepPlan.ts), closing the row before a
//      new one, and the change-log entries for both
//   3. ScheduleVersion + 1, sign-off kept (D7); LastReviewDate = the review date;
//      LastReviewIncreasePercent; the RentPerAnnum cache (only where RentPerAnnum
//      is a cache: where it is the schedule's starting rent, overwriting it would
//      apply the review twice, so it stays); NextReviewDate derived
//   4. the review -> approved with its outcome (old and new rent, %, the CPI
//      pair) and who approved it on what basis
//   5. rent_review.apply in the ledger, with every value before and after and
//      the change-log ids REVERT takes back
// The caller writes its own decision row (submit or approve) first, and does the
// after-commit work (caches, escalations, the next review, Planner).

import type { Connection } from "tedious";
import type { SqlRow } from "../db";
import * as ledger from "../ledger";
import type { LedgerActor } from "../ledger";
import { sqlDateToIso } from "../nextReviewDate";
import type { RentReviewCalc } from "../rentReviewCalc";
import { insertRentScheduleChangeLog } from "../rentScheduleChangeLog";
import { diffSteps, parseSteps } from "../scheduledRateStepLogic";
import { scheduleSignOffFromRow } from "../scheduleSignOff";
import { RentReviewError } from "./http";
import { derivedNextReview, refuseClosedTenancy, scheduleOf, tenancyReviewFields, writeTenancyForReview } from "./reviewTenancy";
import { rentPerAnnumIsCache, representStep, reviewRow, simulate, stepChanges, waivedStep } from "./stepPlan";
import { lockTenancyForReview, totalOccupancySqm } from "./store";
import { markApproved, type Person } from "./transitions";

export interface ApplyInput {
  actor: Extract<LedgerActor, { kind: "user" }>;
  /** Tenants.UpdatedById and the change log's ChangedById (the caller's Entra oid). */
  actorOid: string;
  /** "auto_in_bounds" on SUBMIT's one step; "approved" on APPROVE. */
  approvalBasis: "approved" | "auto_in_bounds";
  calc: RentReviewCalc;
  correlationId: string;
  /** The rent being applied: the override, else the computed one. */
  chosenNewAnnual: number;
  chosenPercent: number;
  from: "awaiting_approval" | "in_progress";
  /** Id for a schedule row the review adds. */
  newStepId: string;
  /** The review row, locked by the caller. */
  review: SqlRow;
  today: string;
}

export interface ApplyResult {
  buildingId: number;
  nextReviewDate: string | null;
  outcome: { appliedPercent: number; newAnnual: number; oldAnnual: number };
  scheduleVersion: number;
  stepId: string;
  tenantId: number;
}

const staleSchedule = (approving: boolean): RentReviewError =>
  new RentReviewError(
    "stale_schedule",
    approving
      ? "The schedule changed since this was calculated — return it so it can be calculated again"
      : "The schedule changed since this was calculated — calculate again",
  );

export async function applyReview(connection: Connection, input: ApplyInput): Promise<ApplyResult> {
  const { calc, review } = input;
  const reviewId = String(review.ReviewId);
  const tenantId = Number(review.TenantId);
  const scheduledFor = sqlDateToIso(review.ScheduledFor) ?? "";

  const tenancy = await lockTenancyForReview(connection, tenantId);
  if (!tenancy) throw new RentReviewError("not_found", "That review's tenancy doesn't exist");
  refuseClosedTenancy(tenancy);
  if (Number(tenancy.ScheduleVersion ?? 0) !== calc.scheduleVersion) throw staleSchedule(input.from === "awaiting_approval");
  if (!scheduleSignOffFromRow(tenancy)) {
    throw new RentReviewError("not_signed_off", "This tenancy's schedule isn't signed off yet — sign it off, then apply");
  }

  const buildingId = Number(tenancy.BuildingId);
  const steps = parseSteps(tenancy.ScheduledRateSteps as string | null | undefined);
  const placedRow = reviewRow(steps, {
    method: calc.method,
    newStepId: input.newStepId,
    reviewId,
    scheduledFor,
    stepId: typeof review.StepId === "string" ? review.StepId : null,
  });
  if (!placedRow.ok) {
    throw new RentReviewError("step_settled", "The schedule row on this review's date is already settled by another review.");
  }
  const { context } = scheduleOf(tenancy, steps, await totalOccupancySqm(connection, tenantId));
  // C4 has held, so this is the rent the calc started from; check it anyway.
  const current = simulate(context, waivedStep(placedRow.base, reviewId)).row;
  if (!current || current.pending || current.annual !== calc.currentAnnual) throw staleSchedule(input.from === "awaiting_approval");

  const written = representStep({
    base: placedRow.base,
    context,
    cpi: calc.cpi ? { current: calc.cpi.current, previous: calc.cpi.previous } : null,
    currentAnnual: calc.currentAnnual,
    method: calc.method,
    naturalRate: calc.method === "fixed" ? (calc.fixedPercent ?? 0) : calc.appliedPercent,
    reviewId,
    target: input.chosenNewAnnual,
  });
  if (!written.ok) {
    throw new RentReviewError(
      "not_representable",
      "The schedule can't hold that rent on this lease (its ratchet or bounds would change it), so it wasn't applied.",
    );
  }
  const nextSteps = written.simulation.placed.steps;
  const step = written.step;
  const closed = written.simulation.placed.closed;

  // The change log: every row the write changed, the review's own first.
  const changedBy = { changedById: input.actorOid, changedByName: input.actor.name };
  const scheduleChanges: Array<{ changeId: string; kind: "added" | "updated"; stepId: string }> = [];
  for (const change of stepChanges(steps, nextSteps, step.id)) {
    scheduleChanges.push({
      changeId: await insertRentScheduleChangeLog(connection, {
        ...changedBy,
        buildingId,
        changeKind: change.kind,
        diff: change.before ? diffSteps(change.before, change.after) : null,
        stepId: change.after.id,
        stepSnapshot: change.after,
        tenantId,
      }),
      kind: change.kind,
      stepId: change.after.id,
    });
  }
  const prior = placedRow.existing;

  const before = tenancyReviewFields(tenancy);
  const cacheRent = rentPerAnnumIsCache(nextSteps);
  const next = derivedNextReview(tenancy, nextSteps, { lastReviewDate: scheduledFor }, input.today);
  const scheduleVersion = await writeTenancyForReview(connection, {
    actorName: input.actor.name,
    actorOid: input.actorOid,
    lastReviewDate: scheduledFor,
    lastReviewIncreasePercent: input.chosenPercent,
    nextReviewDate: next?.after ?? null,
    ...(cacheRent ? { rentPerAnnum: input.chosenNewAnnual } : {}),
    steps: nextSteps,
    tenantId,
  });

  const approver: Person = { name: input.actor.name, userId: input.actor.userId };
  const moved = await markApproved(connection, reviewId, input.from, {
    approvalBasis: input.approvalBasis,
    approver,
    cpi: calc.cpi
      ? {
          current: calc.cpi.current,
          indexUsed: `${calc.cpi.region} ${calc.cpi.referenceQuarter} / ${calc.cpi.previousQuarter} (${calc.cpi.referenceBase})`.slice(0, 100),
          previous: calc.cpi.previous,
        }
      : null,
    increasePercent: input.chosenPercent,
    newAnnual: input.chosenNewAnnual,
    oldAnnual: calc.currentAnnual,
    preparer: input.from === "in_progress" ? approver : null,
    stepId: step.id,
  });
  if (!moved) throw new RentReviewError("invalid_state", "This review just moved on, so it wasn't applied");

  const outcome = { appliedPercent: input.chosenPercent, newAnnual: input.chosenNewAnnual, oldAnnual: calc.currentAnnual };
  const nextReviewDate = next?.after ?? before.nextReviewDate;
  await ledger.record(connection, {
    action: "rent_review.apply",
    actor: input.actor,
    after: {
      outcome,
      representation: written.representation,
      rentPerAnnumCache: cacheRent ? "written" : "kept: it is the schedule's starting rent",
      scheduleChanges,
      step,
      tenancy: {
        lastReviewDate: scheduledFor,
        lastReviewIncreasePercent: input.chosenPercent,
        nextReviewDate,
        rentPerAnnum: cacheRent ? input.chosenNewAnnual : before.rentPerAnnum,
        scheduleVersion,
      },
    },
    before: { step: prior ?? null, ...(closed ? { closed: closed.before } : {}), tenancy: before },
    buildingId,
    correlationId: input.correlationId,
    ruleApplied: input.approvalBasis,
    subject: { id: reviewId, type: "rent_review" },
    tenantId,
  });

  return { buildingId, nextReviewDate, outcome, scheduleVersion, stepId: step.id, tenantId };
}
