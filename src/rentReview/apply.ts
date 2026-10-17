// APPLY (PLAN §3.1): an approved rent becomes the schedule, in the caller's
// transaction, so it all commits or none of it does. SUBMIT's one-step path and
// APPROVE both end here.
//
//   1. lock the tenant row (UPDLOCK); C4: its ScheduleVersion is the one the
//      calc was worked on, else 409 stale_schedule; C3: the schedule is signed
//      off, else 422 not_signed_off, unless a director overrode C3 with a reason
//      (at SUBMIT, carried in the calc, or now; rentReview/directorOverride.ts)
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
import { leaseDepartures, type RentReviewCalc, unrepresentableRent } from "../rentReviewCalc";
import { insertRentScheduleChangeLog } from "../rentScheduleChangeLog";
import { diffSteps, parseSteps, type ScheduledRateStep } from "../scheduledRateStepLogic";
import { scheduleSignOffFromRow } from "../scheduleSignOff";
import { parseBasis } from "./basis";
import { type DirectorOverride, recordDirectorOverride, signOffFacts, storedOverride } from "./directorOverride";
import { RentReviewError } from "./http";
import { stepOnDate } from "./method";
import {
  derivedNextReview,
  isReviewRatchetOn,
  leaseTermsOf,
  refuseClosedTenancy,
  scheduleOf,
  tenancyReviewFields,
  writeTenancyForReview,
} from "./reviewTenancy";
import { rentPerAnnumIsCache, stepChanges } from "./stepPlan";
import { lockTenancyForReview, totalOccupancySqm } from "./store";
import { markApproved, type Person } from "./transitions";
import { writtenFromCalc } from "./written";

export interface ApplyInput {
  actor: Extract<LedgerActor, { kind: "user" }>;
  /** Tenants.UpdatedById and the change log's ChangedById (the caller's Entra oid). */
  actorOid: string;
  /** "auto_in_bounds" on SUBMIT's one step; "director_override" when a director's
   *  C5 override made it one step; "approved" on APPROVE. */
  approvalBasis: "approved" | "auto_in_bounds" | "director_override";
  calc: RentReviewCalc;
  /** The caller is a director: a refused C3 then says a director may override it. */
  director?: boolean;
  /** A director's override made now (APPROVE): C3 is ledgered here with its facts. */
  directorOverride?: DirectorOverride | null;
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

/** The terms the review departs from the lease on: what submit stored with the
 *  calc, else worked out again from the review's basis and the lease. */
function departuresOf(calc: RentReviewCalc, review: SqlRow, tenancy: SqlRow, steps: ScheduledRateStep[], scheduledFor: string): string[] {
  if (Array.isArray(calc.departures)) return calc.departures;
  if (calc.method === "other") return [];
  return leaseDepartures(calc.method, parseBasis(review.Basis) ?? {}, leaseTermsOf(tenancy, stepOnDate(steps, scheduledFor)));
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
  // C3, or a director's override of it: made at SUBMIT (it rides in the calc) or now.
  const signOff = scheduleSignOffFromRow(tenancy);
  const stored = signOff ? null : storedOverride(calc, "not_signed_off");
  const overrideNow = !signOff && !stored && input.directorOverride?.checks.has("not_signed_off") === true ? input.directorOverride : null;
  if (!signOff && !stored && !overrideNow) {
    throw new RentReviewError(
      "not_signed_off",
      "This tenancy's schedule isn't signed off yet — sign it off, then apply",
      input.director ? { directorCanOverride: true } : {},
    );
  }

  const buildingId = Number(tenancy.BuildingId);
  const steps = parseSteps(tenancy.ScheduledRateSteps as string | null | undefined);
  const schedule = scheduleOf(tenancy, steps, await totalOccupancySqm(connection, tenantId));
  // The rent written exactly as SUBMIT showed it to the approver (rentReview/written.ts).
  const result = writtenFromCalc({
    calc,
    departs: calc.override !== undefined || departuresOf(calc, review, tenancy, steps, scheduledFor).length > 0,
    newStepId: input.newStepId,
    reviewId,
    schedule,
    scheduledFor,
    stepId: typeof review.StepId === "string" ? review.StepId : null,
    target: input.chosenNewAnnual,
    today: input.today,
  });
  if (result.kind === "step_settled") {
    throw new RentReviewError("step_settled", "The schedule row on this review's date is already settled by another review.");
  }
  // C4 has held, so the rent the calc started from is still the schedule's; check it anyway.
  if (result.kind === "stale") throw staleSchedule(input.from === "awaiting_approval");
  if (result.kind === "unrepresentable") {
    const why = unrepresentableRent(input.chosenNewAnnual, calc.currentAnnual, isReviewRatchetOn(tenancy));
    throw new RentReviewError(why.code, why.message);
  }
  const written = result.written;
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
  const prior = result.existing;

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
    calcJson: JSON.stringify(calc),
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
  if (overrideNow) {
    await recordDirectorOverride(connection, {
      actor: input.actor,
      buildingId,
      check: "not_signed_off",
      correlationId: input.correlationId,
      facts: await signOffFacts(connection, tenancy),
      reason: overrideNow.reason,
      reviewId,
      tenantId,
    });
  }
  const signOffRecord = signOff
    ? { at: signOff.at, by: signOff.by }
    : { overriddenBy: stored?.by ?? { name: input.actor.name, userId: input.actor.userId }, reason: stored?.reason ?? overrideNow?.reason ?? null };
  await ledger.record(connection, {
    action: "rent_review.apply",
    actor: input.actor,
    after: {
      outcome,
      representation: written.representation,
      rentPerAnnumCache: cacheRent ? "written" : "kept: it is the schedule's starting rent",
      scheduleChanges,
      signOff: signOffRecord,
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
