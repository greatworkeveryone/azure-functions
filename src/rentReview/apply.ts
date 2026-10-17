// APPLY (PLAN §3.1): an approved rent becomes the schedule, in the caller's
// transaction, so it all commits or none of it does. SUBMIT's one-step path and
// APPROVE both end here.
//
//   1. lock the tenant row (UPDLOCK); C4: its ScheduleVersion is the one the
//      calc was worked on, else 409 stale_schedule; C3: the schedule is signed
//      off, else 422 not_signed_off, unless a director overrode C3 with a reason
//      (at SUBMIT, carried in the calc, or now; rentReview/directorOverride.ts);
//      C9: a rent below the current one on a lease with a ratchet needs a
//      director's override of the ratchet (at SUBMIT, carried in the calc, or
//      now), else 422 ratchet; the row is then written with ratchetExempt
//   2. write the step through the schedule engine (cpiValue, the same-base
//      cpiValuePrev, ratePercent, resolution applied, reviewId; or the exact
//      rate an override needs, rentReview/stepPlan.ts), closing the row before a
//      new one, and the change-log entries for both
//   3. ScheduleVersion + 1, sign-off kept (D7); LastReviewDate = the review date
//      and LastReviewIncreasePercent, unless a later review is already the
//      tenancy's last (LastReviewDate never moves backwards, L9); the RentPerAnnum
//      cache, only where RentPerAnnum is a cache (where it is the schedule's
//      starting rent, overwriting it would apply the review twice, so it stays)
//      and only once the review's date has come: a review applied ahead of its
//      date leaves the rent in force today, marked "deferred", and the generator
//      writes it on the date (rentReview/rentCache.ts, L10); NextReviewDate derived
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
import { LEASE_RATCHET_MESSAGE, leaseDepartures, type RentReviewCalc, unrepresentableRent } from "../rentReviewCalc";
import { insertRentScheduleChangeLog } from "../rentScheduleChangeLog";
import { diffSteps, parseSteps, type RatchetExemption, type ScheduledRateStep } from "../scheduledRateStepLogic";
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

/** C9's facts: the lease's ratchet would hold the rent, and by how much the review goes below it. */
export function ratchetFacts(currentAnnual: number, chosenAnnual: number): Record<string, unknown> {
  return {
    chosenAnnual,
    currentAnnual,
    decreasePercent: Math.round((chosenAnnual / currentAnnual - 1) * 1_000_000) / 10_000,
    leaseRatchet: true,
  };
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

  // C9 (WP26c, D23): below the lease's ratchet only on a row a director exempts.
  const belowRatchet = input.chosenNewAnnual < calc.currentAnnual && isReviewRatchetOn(tenancy);
  const storedRatchet = belowRatchet ? storedOverride(calc, "ratchet") : null;
  const ratchetNow = belowRatchet && !storedRatchet && input.directorOverride?.checks.has("ratchet") === true ? input.directorOverride : null;
  if (belowRatchet && !storedRatchet && !ratchetNow) {
    throw new RentReviewError("ratchet", LEASE_RATCHET_MESSAGE, input.director ? { directorCanOverride: true } : {});
  }
  const ratchetExempt: RatchetExemption | null = storedRatchet
    ? { at: storedRatchet.at, byName: storedRatchet.by.name.slice(0, 200), reason: storedRatchet.reason }
    : ratchetNow
      ? { at: new Date().toISOString(), byName: input.actor.name.slice(0, 200), reason: ratchetNow.reason }
      : null;

  const buildingId = Number(tenancy.BuildingId);
  const steps = parseSteps(tenancy.ScheduledRateSteps as string | null | undefined);
  const schedule = scheduleOf(tenancy, steps, await totalOccupancySqm(connection, tenantId));
  // The rent written exactly as SUBMIT showed it to the approver (rentReview/written.ts).
  const result = writtenFromCalc({
    calc,
    departs: calc.override !== undefined || departuresOf(calc, review, tenancy, steps, scheduledFor).length > 0,
    newStepId: input.newStepId,
    ratchetExempt,
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
    const why = unrepresentableRent(input.chosenNewAnnual, calc.currentAnnual, isReviewRatchetOn(tenancy) && ratchetExempt === null);
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
  // L9: an earlier review applied after a later one leaves the later one as the last.
  const movesLast = before.lastReviewDate === null || scheduledFor >= before.lastReviewDate;
  const lastReviewDate = movesLast ? scheduledFor : before.lastReviewDate;
  const lastReviewIncreasePercent = movesLast ? input.chosenPercent : before.lastReviewIncreasePercent;
  // L10: the cache holds the rent in force, so it waits for the review's date.
  const cacheable = rentPerAnnumIsCache(nextSteps);
  const cacheRent = cacheable && scheduledFor <= input.today;
  const next = derivedNextReview(tenancy, nextSteps, { lastReviewDate }, input.today);
  const scheduleVersion = await writeTenancyForReview(connection, {
    actorName: input.actor.name,
    actorOid: input.actorOid,
    ...(movesLast ? { lastReviewDate: scheduledFor, lastReviewIncreasePercent: input.chosenPercent } : {}),
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
  if (ratchetNow) {
    await recordDirectorOverride(connection, {
      actor: input.actor,
      buildingId,
      check: "ratchet",
      correlationId: input.correlationId,
      facts: ratchetFacts(calc.currentAnnual, input.chosenNewAnnual),
      reason: ratchetNow.reason,
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
      rentPerAnnumCache: cacheRent ? "written" : cacheable ? "deferred" : "kept: it is the schedule's starting rent",
      ...(cacheable && !cacheRent ? { rentPerAnnumCacheDue: scheduledFor } : {}),
      scheduleChanges,
      signOff: signOffRecord,
      step,
      tenancy: {
        lastReviewDate,
        lastReviewIncreasePercent,
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
