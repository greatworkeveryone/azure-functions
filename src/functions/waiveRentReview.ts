// POST /api/waiveRentReview   (PLAN §3.1 WAIVE, WP26)
//
//   { reviewId, rowVersion, reason }
//   200 { review, nextReview }
//
// Decides that a review changes nothing: any state before approval -> waived.
// In one transaction, under update locks on the review and its tenancy, the
// review's schedule row is settled as waived (resolution "waived", reviewId) by
// the schedule engine's own rules: the row on the review date is updated, or a
// waived row is added there, closing the open row before it; the change log
// records it; ScheduleVersion + 1, sign-off kept (D7); NextReviewDate derived.
// The rent doesn't change, so LastReviewDate and the RentPerAnnum cache stay.
//
//   rowVersion  the one the caller read, else 409 { code: "stale", current }
//   state       an open one, else 409 invalid_state
//   reason      required (400 reason_required)
//   role        accounts_manager, cfo or director (admin is never an approver);
//               a market review only a director (403 forbidden, ledgered as denied)
//   tenancy     archived 422 tenancy_archived, vacated 422 tenancy_vacated
//   409 step_settled when another review already settled the row on its date
// Ledgered as rent_review.waive (an exception, with the reason) with
// financialImpact = the annual increase forgone: the calc's, or worked out now
// for a CPI or fixed review that wasn't calculated (null when it can't be: no
// index yet, or a manual or market review). After the commit: caches, the
// review's escalations end as "waived", and the next review is scheduled.
//
// Gates: REVIEW_APPROVE_ROLES (rentReview/http.ts, frontend waiveRentReview),
// then the money-action gate (S11).

import { randomUUID } from "node:crypto";
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { AppRole, extractToken, oidFromToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection, type SqlRow } from "../db";
import * as ledger from "../ledger";
import { requireMoneyContext } from "../moneyGate";
import { sqlDateToIso } from "../nextReviewDate";
import { canTransition, type RentReviewState } from "../rentReviewMachine";
import { calculateReview, parseCalc, sanityBandFromEnv, type CalcMethod } from "../rentReviewCalc";
import { insertRentScheduleChangeLog } from "../rentScheduleChangeLog";
import { diffSteps, parseSteps, type RentScheduleMethodKind, type ScheduledRateStep } from "../scheduledRateStepLogic";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { afterReviewDecision } from "../rentReview/afterDecision";
import { parseBasis } from "../rentReview/basis";
import { previousQuarter, referenceQuarter } from "../rentReview/cpi";
import { toReviewDto } from "../rentReview/dto";
import { REVIEW_DECISION_CODES } from "../rentReview/escalationRules";
import {
  holdsApproverRole,
  readJsonObject,
  readReason,
  readReviewId,
  readRowVersion,
  recordReviewRefusal,
  REVIEW_APPROVE_ROLES,
  RentReviewError,
  rentReviewErrorResponse,
  resolveCaller,
  staleReview,
} from "../rentReview/http";
import { derivedNextReview, refuseClosedTenancy, scheduleOf, tenancyReviewFields, writeTenancyForReview } from "../rentReview/reviewTenancy";
import { placeStep, reviewRow, stepChanges, waivedStep } from "../rentReview/stepPlan";
import { inTransaction, loadCpiRows, loadReview, lockTenancyForReview, reviewForUpdate, totalOccupancySqm } from "../rentReview/store";
import { markWaived } from "../rentReview/transitions";

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** The annual increase the waive gives up, and where the figure came from. */
async function forgoneIncrease(
  connection: Connection,
  review: SqlRow,
  tenancy: SqlRow,
  steps: ScheduledRateStep[],
  totalSqm: number,
  today: string,
): Promise<{ computed: Record<string, unknown> | null; impact: number | null }> {
  const stored = parseCalc(review.Calc);
  if (stored) {
    const chosen = stored.override?.newAnnual ?? stored.newAnnual;
    return {
      computed: { currentAnnual: stored.currentAnnual, newAnnual: chosen, source: "calc" },
      impact: r2(chosen - stored.currentAnnual),
    };
  }
  const method = String(review.Method);
  if (method !== "cpi" && method !== "fixed") return { computed: null, impact: null };
  const basis = parseBasis(review.Basis) ?? {};
  const scheduledFor = sqlDateToIso(review.ScheduledFor) ?? "";
  const region = typeof basis.region === "string" ? basis.region.toUpperCase() : "";
  const reference = referenceQuarter(scheduledFor);
  const interval = typeof basis.intervalMonths === "number" ? basis.intervalMonths : null;
  const cpiRows =
    method === "cpi" && (region === "AUS" || region === "DARWIN") ? await loadCpiRows(connection, region, [reference, previousQuarter(reference, interval)]) : [];
  const schedule = scheduleOf(tenancy, steps, totalSqm);
  const estimate = calculateReview({
    basis,
    carparkGroups: [],
    computedAt: new Date().toISOString(),
    computedBy: { name: "estimate", userId: null },
    cpiRows,
    fallbackAnnual: schedule.context.fallbackAnnual,
    fallbackSqm: schedule.context.fallbackSqm,
    lease: {
      cpiCapPercent: schedule.context.lease.cpiCapPercent ?? null,
      cpiFloorPercent: schedule.context.lease.cpiFloorPercent ?? null,
      reviewRatchet: schedule.context.lease.reviewRatchet === true,
      workflowLiveFrom: schedule.context.lease.workflowLiveFrom ?? null,
    },
    method: method as CalcMethod,
    miscFees: [],
    newStepId: randomUUID(),
    reviewId: String(review.ReviewId),
    sanity: sanityBandFromEnv(),
    scheduledFor,
    scheduleVersion: Number(tenancy.ScheduleVersion ?? 0),
    stepId: typeof review.StepId === "string" ? review.StepId : null,
    steps,
    today,
  });
  if (estimate.kind !== "calc") return { computed: null, impact: null };
  return {
    computed: { currentAnnual: estimate.calc.currentAnnual, newAnnual: estimate.calc.newAnnual, source: "estimate" },
    impact: r2(estimate.calc.newAnnual - estimate.calc.currentAnnual),
  };
}

export async function waiveRentReview(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, REVIEW_APPROVE_ROLES);
  if (roleCheck) return roleCheck;
  const gate = await requireMoneyContext(request);
  if (gate) return gate;

  let connection;
  try {
    const body = await readJsonObject(request);
    const reviewId = readReviewId(body.reviewId);
    const rowVersion = readRowVersion(body.rowVersion);
    const reason = readReason(body.reason, "Say why the review is waived (a reason is required)");

    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    const db = connection;
    const today = todayInDarwin();
    const correlationId = ledger.newCorrelationId();

    let done;
    try {
      done = await inTransaction(db, async () => {
        const review = await reviewForUpdate(db, reviewId);
        if (!review) throw new RentReviewError("not_found", "That review doesn't exist");
        if (rowVersionHex(review.Version) !== rowVersion) throw staleReview(review, today);
        const state = review.State as RentReviewState;
        if (!canTransition(state, "WAIVE")) {
          throw new RentReviewError("invalid_state", `This review is ${state.replace(/_/g, " ")}; only a review not yet decided can be waived`, { state });
        }
        const tenantId = Number(review.TenantId);
        const method = String(review.Method);
        const refusal = (message: string) => ({
          action: "denied" as const,
          actor: caller.actor,
          before: { attempted: "rent_review.waive", method, state },
          buildingId: Number(review.TenantBuildingId),
          reason: message,
          ruleApplied: "role_not_permitted",
          subject: { id: reviewId, type: "rent_review" as const },
          tenantId,
        });
        if (!holdsApproverRole(caller.roles)) {
          const message = "Only an accounts manager, the CFO or a director can waive a rent review";
          throw new RentReviewError("forbidden", message, {}, refusal(message));
        }
        if (method === "market" && !caller.roles.includes(AppRole.DIRECTOR)) {
          const message = "Only a director can waive a market review";
          throw new RentReviewError("forbidden", message, {}, refusal(message));
        }

        const tenancy = await lockTenancyForReview(db, tenantId);
        if (!tenancy) throw new RentReviewError("not_found", "That review's tenancy doesn't exist");
        refuseClosedTenancy(tenancy);
        const buildingId = Number(tenancy.BuildingId);
        const scheduledFor = sqlDateToIso(review.ScheduledFor) ?? "";
        const steps = parseSteps(tenancy.ScheduledRateSteps as string | null | undefined);
        const placedRow = reviewRow(steps, {
          method: (["cpi", "fixed", "market", "other"].includes(method) ? method : "other") as RentScheduleMethodKind,
          newStepId: randomUUID(),
          reviewId,
          scheduledFor,
          stepId: typeof review.StepId === "string" ? review.StepId : null,
        });
        if (!placedRow.ok) {
          throw new RentReviewError("step_settled", "The schedule row on this review's date is already settled by another review.");
        }
        const totalSqm = await totalOccupancySqm(db, tenantId);
        const forgone = await forgoneIncrease(db, review, tenancy, steps, totalSqm, today);

        const step = waivedStep(placedRow.base, reviewId);
        const placed = placeStep(steps, step);
        const changedBy = { buildingId, changedById: oidFromToken(token) ?? "unknown", changedByName: caller.actor.name, tenantId };
        const prior = placedRow.existing;
        const scheduleChanges: Array<{ changeId: string; kind: "added" | "updated"; stepId: string }> = [];
        for (const change of stepChanges(steps, placed.steps, step.id)) {
          scheduleChanges.push({
            changeId: await insertRentScheduleChangeLog(db, {
              ...changedBy,
              changeKind: change.kind,
              diff: change.before ? diffSteps(change.before, change.after) : null,
              stepId: change.after.id,
              stepSnapshot: change.after,
            }),
            kind: change.kind,
            stepId: change.after.id,
          });
        }
        const before = tenancyReviewFields(tenancy);
        const next = derivedNextReview(tenancy, placed.steps, {}, today);
        const scheduleVersion = await writeTenancyForReview(db, {
          actorName: caller.actor.name,
          actorOid: changedBy.changedById,
          nextReviewDate: next?.after ?? null,
          steps: placed.steps,
          tenantId,
        });
        if (!(await markWaived(db, reviewId, reason, step.id))) {
          throw new RentReviewError("invalid_state", "This review just moved on, so it wasn't waived", { state });
        }
        await ledger.record(db, {
          action: "rent_review.waive",
          actor: caller.actor,
          after: { nextReviewDate: next?.after ?? before.nextReviewDate, scheduleChanges, scheduleVersion, state: "waived", step },
          before: { nextReviewDate: before.nextReviewDate, state, step: prior ?? null },
          buildingId,
          computed: forgone.computed ?? undefined,
          correlationId,
          financialImpact: forgone.impact,
          reason,
          ruleApplied: method === "market" ? "waive_market_director" : "waive",
          subject: { id: reviewId, type: "rent_review" },
          tenantId,
        });
        const after = await loadReview(db, reviewId);
        if (!after) throw new Error(`Review ${reviewId} vanished while being waived`);
        return { after, buildingId, scheduledFor, tenantId };
      });
    } catch (error) {
      await recordReviewRefusal(db, error);
      throw error;
    }

    const review = toReviewDto(done.after, today);
    const nextReview = await afterReviewDecision(db, {
      actor: caller.actor,
      buildingId: done.buildingId,
      code: REVIEW_DECISION_CODES.waived,
      log: (message) => context.warn(message),
      note: reason,
      reviewId,
      scheduleNext: true,
      scheduledFor: done.scheduledFor,
      state: review.state,
      tenantId: done.tenantId,
      today,
    });
    return { jsonBody: { nextReview, review }, status: 200 };
  } catch (error) {
    return rentReviewErrorResponse(error, context, "waiveRentReview");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("waiveRentReview", { authLevel: "anonymous", handler: waiveRentReview, methods: ["POST"] });
