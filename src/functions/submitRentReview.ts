// POST /api/submitRentReview   (PLAN §3.1 SUBMIT, D3, WP26)
//
//   { reviewId, rowVersion, override?: { newAnnual, reason } }
//   200 { review, applied, nextReview? }
//
// Sends a calculated review on. In one transaction, under update locks on the
// review and its tenancy:
//   rowVersion  the one the caller read, else 409 { code: "stale", current }
//   state       in_progress, else 409 invalid_state; a calc, else 409 not_calculated
//   tenancy     archived 422 tenancy_archived, vacated 422 tenancy_vacated
//   C4          the schedule hasn't changed since the calc (ScheduleVersion), else
//               409 stale_schedule "The schedule changed since this was calculated — calculate again"
//   C3          the schedule is signed off, else 422 not_signed_off
//   C5          the applied % is inside REVIEW_SANITY_MIN/MAX_PERCENT (−5 / +15)
//   C9          a new rent below the current one on a lease with a ratchet is
//               refused (422 ratchet): the schedule engine holds every review of
//               a ratchet lease at no decrease, so it could not hold that rent. A
//               director may still go below a ratchet the review's basis adds
//               (and the lease doesn't) with an override and its reason.
// Then:
//   one step    a CPI or fixed result, inside the band, on the lease's own terms
//               (an unchanged fixed %), with no override: APPLY now
//               (rentReview/apply.ts), rule auto_in_bounds. applied: true.
//   approval    anything else (an override, out of band, an `other` review, a basis
//               that departs from the lease): awaiting_approval, the preparer
//               stamped, and after the commit E3 (rent_review.approval) to an
//               accounts manager who isn't the preparer. applied: false.
// An override records computed vs chosen and the $ difference in the calc
// (calc.override) and in its own ledger row, rent_review.override (an exception,
// reason required); financialImpact is the annual rent forgone (computed − chosen).
//
// Ledgered as rent_review.submit (+ rent_review.override, + rent_review.apply on
// the one-step path), all in the same transaction.
//
// Gates: the roles that may apply a review (rentReview/http.ts REVIEW_APPLY_ROLES,
// PLAN WP26's apply capability, mirrored in the frontend), then the money-action
// gate (S11): submitting can change what a tenant is billed.

import { randomUUID } from "node:crypto";
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, extractToken, oidFromToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import * as ledger from "../ledger";
import { requireMoneyContext } from "../moneyGate";
import { sqlDateToIso } from "../nextReviewDate";
import { canTransition, type RentReviewState } from "../rentReviewMachine";
import { leaseDepartures, parseCalc, sanityBandFromEnv, sanityOf, type RentReviewCalc } from "../rentReviewCalc";
import { parseSteps } from "../scheduledRateStepLogic";
import { scheduleSignOffFromRow } from "../scheduleSignOff";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { afterReviewDecision, type NextReviewRef } from "../rentReview/afterDecision";
import { applyReview } from "../rentReview/apply";
import { parseBasis } from "../rentReview/basis";
import { toReviewDto } from "../rentReview/dto";
import { REVIEW_DECISION_CODES } from "../rentReview/escalationRules";
import { raiseApprovalEscalation, separationOfDuties } from "../rentReview/escalations";
import {
  readJsonObject,
  readReason,
  readReviewId,
  readRowVersion,
  REVIEW_APPLY_ROLES,
  RentReviewError,
  rentReviewErrorResponse,
  resolveCaller,
  staleReview,
} from "../rentReview/http";
import { stepOnDate } from "../rentReview/method";
import { isReviewRatchetOn, leaseTermsOf, refuseClosedTenancy } from "../rentReview/reviewTenancy";
import { inTransaction, loadReview, lockTenancyForReview, reviewForUpdate } from "../rentReview/store";
import { markSubmitted } from "../rentReview/transitions";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r4 = (n: number): number => Math.round(n * 10000) / 10000 || 0;
const MAX_RENT = 1e10;

function readOverride(raw: unknown): { newAnnual: number; reason: string } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new RentReviewError("bad_request", "override must be { newAnnual, reason }");
  const { newAnnual, reason } = raw as Record<string, unknown>;
  if (typeof newAnnual !== "number" || !Number.isFinite(newAnnual) || newAnnual <= 0 || newAnnual >= MAX_RENT) {
    throw new RentReviewError("bad_request", "override.newAnnual must be the new annual rent, more than $0");
  }
  return { newAnnual: r2(newAnnual), reason: readReason(reason, "Say why the rent differs from the calculated one (a reason is required)") };
}

export async function submitRentReview(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, REVIEW_APPLY_ROLES);
  if (roleCheck) return roleCheck;
  const gate = await requireMoneyContext(request);
  if (gate) return gate;

  let connection;
  try {
    const body = await readJsonObject(request);
    const reviewId = readReviewId(body.reviewId);
    const rowVersion = readRowVersion(body.rowVersion);
    const override = readOverride(body.override);

    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    const db = connection;
    const today = todayInDarwin();
    const correlationId = ledger.newCorrelationId();

    const done = await inTransaction(db, async () => {
      const review = await reviewForUpdate(db, reviewId);
      if (!review) throw new RentReviewError("not_found", "That review doesn't exist");
      if (rowVersionHex(review.Version) !== rowVersion) throw staleReview(review, today);
      const state = review.State as RentReviewState;
      if (!canTransition(state, "SUBMIT")) {
        throw new RentReviewError("invalid_state", `This review is ${state.replace(/_/g, " ")} and can't be submitted`, { state });
      }
      const calc = parseCalc(review.Calc);
      if (!calc) throw new RentReviewError("not_calculated", "Calculate the review before submitting it", { state });

      const tenantId = Number(review.TenantId);
      const tenancy = await lockTenancyForReview(db, tenantId);
      if (!tenancy) throw new RentReviewError("not_found", "That review's tenancy doesn't exist");
      refuseClosedTenancy(tenancy);
      if (Number(tenancy.ScheduleVersion ?? 0) !== calc.scheduleVersion) {
        throw new RentReviewError("stale_schedule", "The schedule changed since this was calculated — calculate again");
      }
      if (!scheduleSignOffFromRow(tenancy)) {
        throw new RentReviewError("not_signed_off", "This tenancy's schedule isn't signed off yet — sign it off, then apply");
      }
      if (override && override.newAnnual === calc.newAnnual) {
        throw new RentReviewError("no_change", "That is the calculated rent; submit it without an override");
      }

      const chosen = override?.newAnnual ?? calc.newAnnual;
      const chosenPercent = override ? r4((chosen / calc.currentAnnual - 1) * 100) : calc.appliedPercent;
      const sanity = sanityOf(chosenPercent, sanityBandFromEnv());
      const basis = parseBasis(review.Basis) ?? {};
      const scheduledFor = sqlDateToIso(review.ScheduledFor) ?? "";

      // C9: a decrease where a ratchet forbids one.
      if (chosen < calc.currentAnnual) {
        if (isReviewRatchetOn(tenancy)) {
          throw new RentReviewError(
            "ratchet",
            "This lease has a ratchet, so its rent can't go down on review. To depart from the lease, a director turns the ratchet off in the lease's terms (a recorded change) and the review is calculated again.",
          );
        }
        if (basis.ratchet === true && !(override && caller.roles.includes(AppRole.DIRECTOR))) {
          throw new RentReviewError("ratchet", "This review's basis has a ratchet, so the rent can't go down unless a director overrides it with a reason.");
        }
      }

      const steps = parseSteps(tenancy.ScheduledRateSteps as string | null | undefined);
      const departures = calc.method === "other" ? [] : leaseDepartures(calc.method, basis, leaseTermsOf(tenancy, stepOnDate(steps, scheduledFor)));
      const reasons = [
        ...(override ? ["override"] : []),
        ...(sanity.inBand ? [] : ["out_of_band"]),
        ...(calc.method === "other" ? ["manual_method"] : []),
        ...(departures.length > 0 ? ["basis_departs_from_lease"] : []),
      ];
      const buildingId = Number(tenancy.BuildingId);
      const scope = { buildingId, correlationId, subject: { id: reviewId, type: "rent_review" as const }, tenantId };
      const differenceAnnual = override ? r2(override.newAnnual - calc.newAnnual) : 0;
      const submitted: RentReviewCalc = override
        ? { ...calc, departures, override: { differenceAnnual, newAnnual: override.newAnnual, reason: override.reason }, sanity }
        : { ...calc, departures, override: undefined, sanity };
      const chosenFigures = { appliedPercent: chosenPercent, currentAnnual: calc.currentAnnual, newAnnual: chosen };

      if (reasons.length === 0) {
        await ledger.record(db, {
          ...scope,
          action: "rent_review.submit",
          actor: caller.actor,
          after: { ...chosenFigures, sanity, state: "approved" },
          before: { state },
          ruleApplied: "auto_in_bounds",
        });
        const applied = await applyReview(db, {
          actor: caller.actor,
          actorOid: oidFromToken(token) ?? "unknown",
          approvalBasis: "auto_in_bounds",
          calc: submitted,
          chosenNewAnnual: chosen,
          chosenPercent,
          correlationId,
          from: "in_progress",
          newStepId: randomUUID(),
          review,
          today,
        });
        const after = await loadReview(db, reviewId);
        if (!after) throw new Error(`Review ${reviewId} vanished while being applied`);
        return { after, applied: true, buildingId: applied.buildingId, calc: submitted, chosenFigures, reasons, scheduledFor, tenantId };
      }

      if (!(await markSubmitted(db, reviewId, { name: caller.actor.name, userId: caller.actor.userId }, JSON.stringify(submitted)))) {
        throw new RentReviewError("invalid_state", "This review just moved on, so it wasn't submitted", { state });
      }
      await ledger.record(db, {
        ...scope,
        action: "rent_review.submit",
        actor: caller.actor,
        after: { ...chosenFigures, departures, reasons, sanity, state: "awaiting_approval" },
        before: { state },
        ruleApplied: reasons.join("+"),
      });
      if (override) {
        await ledger.record(db, {
          ...scope,
          action: "rent_review.override",
          actor: caller.actor,
          after: { appliedPercent: chosenPercent, newAnnual: override.newAnnual },
          computed: { appliedPercent: calc.appliedPercent, newAnnual: calc.newAnnual },
          // Annualised money forgone (positive) or gained (negative) against the calculated rent.
          financialImpact: r2(calc.newAnnual - override.newAnnual),
          reason: override.reason,
          ruleApplied: departures.length > 0 ? "override+basis_departs_from_lease" : "override",
        });
      }
      const after = await loadReview(db, reviewId);
      if (!after) throw new Error(`Review ${reviewId} vanished while being submitted`);
      return { after, applied: false, buildingId, calc: submitted, chosenFigures, reasons, scheduledFor, tenantId };
    });

    const review = toReviewDto(done.after, today);
    let nextReview: NextReviewRef | null = null;
    if (done.applied) {
      nextReview = await afterReviewDecision(db, {
        actor: caller.actor,
        buildingId: done.buildingId,
        code: REVIEW_DECISION_CODES.approved,
        log: (message) => context.warn(message),
        plannerResolve: true,
        reviewId,
        scheduleNext: true,
        scheduledFor: done.scheduledFor,
        state: review.state,
        tenantId: done.tenantId,
        today,
      });
      return { jsonBody: { applied: true, nextReview, review }, status: 200 };
    }

    invalidateTenantAndBuilding(done.tenantId, done.buildingId);
    await raiseApprovalEscalation(db, {
      actor: caller.actor,
      ...done.chosenFigures,
      excludeUserIds: separationOfDuties({ calc: done.calc, preparedById: caller.actor.userId }),
      log: (message) => context.warn(message),
      reasons: done.reasons,
      reviewId,
    });
    return { jsonBody: { applied: false, review }, status: 200 };
  } catch (error) {
    return rentReviewErrorResponse(error, context, "submitRentReview");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("submitRentReview", { authLevel: "anonymous", handler: submitRentReview, methods: ["POST"] });
