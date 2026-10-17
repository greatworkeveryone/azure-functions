// POST /api/submitRentReview   (PLAN §3.1 SUBMIT, D3, WP26)
//
//   { reviewId, rowVersion, override?: { newAnnual, reason },
//     directorOverride?: { checks: ["not_signed_off" | "out_of_band"], reason } }
//   200 { review, applied, nextReview? }
//
// Sends a calculated review on. In one transaction, under update locks on the
// review and its tenancy:
//   rowVersion  the one the caller read, else 409 { code: "stale", current }
//   state       in_progress, else 409 invalid_state; a calc, else 409 not_calculated
//   tenancy     archived 422 tenancy_archived, vacated 422 tenancy_vacated
//   C4          the schedule hasn't changed since the calc (ScheduleVersion), else
//               409 stale_schedule "The schedule changed since this was calculated — calculate again"
//   C3          the schedule is signed off, else 422 not_signed_off (with
//               directorCanOverride for a director)
//   C5          the applied % is inside REVIEW_SANITY_MIN/MAX_PERCENT (−5 / +15)
//   A2          a director may override C3 and C5 with directorOverride and a
//               reason: C3 lets it apply though the schedule isn't signed off (the
//               override rides in the calc to APPROVE), C5 stops the band alone
//               sending it to a second person (one step, approval basis
//               director_override). Each check overridden is its own
//               rent_review.director_override row, an exception with its facts.
//               Anyone else sending one is 403 forbidden, ledgered as denied
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
//               that departs from the lease, a lower rent): awaiting_approval, the
//               preparer stamped, and after the commit E3 (rent_review.approval) to
//               an accounts manager who isn't the preparer, or for a lower rent to
//               the directors at once (A3). applied: false.
// The receipt is read off the schedule as APPLY will write the rent being
// submitted (rentReview/written.ts): the cascade to AHAC, car parks and misc
// fees and the arrears for every charge that changes, so the approver sees the
// schedule after APPLY (H1). A rent the schedule can't hold is refused here
// (422 not_representable, or ratchet), not first at APPLY (L6). An override
// carries its own receipt in calc.override (the top level stays the computed
// result) and its own ledger row, rent_review.override (an exception, reason
// required), computed vs chosen; financialImpact is the annual money forgone
// against the computed result, the rent and every charge that follows it.
//
// A basis that departs from the lease is worked again on the lease's own terms
// (rentReview/leaseTerms.ts), stored as calc.leaseTerms and ledgered as
// rent_review.basis_departure (an exception): the lease's result beside the rent
// submitted, financialImpact the annual money forgone against the lease (M3).
//
// Ledgered as rent_review.submit (+ rent_review.override, + rent_review.basis_departure,
// + rent_review.apply on the one-step path), all in the same transaction.
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
import {
  LEASE_RATCHET_MESSAGE,
  leaseDepartures,
  parseCalc,
  sanityBandFromEnv,
  sanityOf,
  type RentReviewCalc,
  unrepresentableRent,
} from "../rentReviewCalc";
import { parseSteps } from "../scheduledRateStepLogic";
import { scheduleSignOffFromRow } from "../scheduleSignOff";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { afterReviewDecision, type NextReviewRef } from "../rentReview/afterDecision";
import { applyReview } from "../rentReview/apply";
import { parseBasis } from "../rentReview/basis";
import { toReviewDto } from "../rentReview/dto";
import { REVIEW_DECISION_CODES } from "../rentReview/escalationRules";
import { basisEditorsSinceCommence, raiseApprovalEscalation, separationOfDuties } from "../rentReview/escalations";
import { readDirectorOverride, recordDirectorOverride, signOffFacts } from "../rentReview/directorOverride";
import {
  readJsonObject,
  readReason,
  readReviewId,
  readRowVersion,
  recordReviewRefusal,
  REVIEW_APPLY_ROLES,
  RentReviewError,
  rentReviewErrorResponse,
  resolveCaller,
  staleReview,
} from "../rentReview/http";
import { stepOnDate } from "../rentReview/method";
import { isReviewRatchetOn, leaseTermsOf, refuseClosedTenancy, scheduleOf } from "../rentReview/reviewTenancy";
import { inTransaction, loadReview, lockTenancyForReview, reviewForUpdate, totalOccupancySqm } from "../rentReview/store";
import { markSubmitted } from "../rentReview/transitions";
import { rentOnLeaseTerms } from "../rentReview/leaseTerms";
import { ancillaryAnnual, writtenFromCalc } from "../rentReview/written";
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
    const directorOverride = readDirectorOverride(body.directorOverride, ["not_signed_off", "out_of_band"]);

    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    const db = connection;
    const today = todayInDarwin();
    const correlationId = ledger.newCorrelationId();
    const director = caller.roles.includes(AppRole.DIRECTOR);

    let done;
    try {
      done = await inTransaction(db, async () => {
        const review = await reviewForUpdate(db, reviewId);
        if (!review) throw new RentReviewError("not_found", "That review doesn't exist");
        if (rowVersionHex(review.Version) !== rowVersion) throw staleReview(review, today);
        const state = review.State as RentReviewState;
        if (!canTransition(state, "SUBMIT")) {
          throw new RentReviewError("invalid_state", `This review is ${state.replace(/_/g, " ")} and can't be submitted`, { state });
        }
        const refusal = (rule: string, message: string) => ({
          action: "denied" as const,
          actor: caller.actor,
          before: { attempted: "rent_review.submit", state },
          buildingId: Number(review.TenantBuildingId),
          reason: message,
          ruleApplied: rule,
          subject: { id: reviewId, type: "rent_review" as const },
          tenantId: Number(review.TenantId),
        });
        if (directorOverride && !director) {
          const message = "Only a director can override a rent review's checks";
          throw new RentReviewError("forbidden", message, {}, refusal("director_override_not_director", message));
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
        // C3, unless a director overrides it with a reason (A2).
        const signOffOverridden = !scheduleSignOffFromRow(tenancy) && directorOverride?.checks.has("not_signed_off") === true;
        if (!scheduleSignOffFromRow(tenancy) && !signOffOverridden) {
          throw new RentReviewError(
            "not_signed_off",
            "This tenancy's schedule isn't signed off yet — sign it off, then apply",
            director ? { directorCanOverride: true } : {},
          );
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
          if (isReviewRatchetOn(tenancy)) throw new RentReviewError("ratchet", LEASE_RATCHET_MESSAGE);
          if (basis.ratchet === true && !(override && caller.roles.includes(AppRole.DIRECTOR))) {
            throw new RentReviewError("ratchet", "This review's basis has a ratchet, so the rent can't go down unless a director overrides it with a reason.");
          }
        }

        const steps = parseSteps(tenancy.ScheduledRateSteps as string | null | undefined);
        const lease = leaseTermsOf(tenancy, stepOnDate(steps, scheduledFor));
        const departures = calc.method === "other" ? [] : leaseDepartures(calc.method, basis, lease);
        const schedule = scheduleOf(tenancy, steps, await totalOccupancySqm(db, tenantId));

        // H1: the receipt for the rent being submitted is read off the schedule as
        // APPLY will write it, so the approver sees what the schedule will say.
        const worked = writtenFromCalc({
          calc,
          departs: override !== null || departures.length > 0,
          newStepId: randomUUID(),
          reviewId,
          schedule,
          scheduledFor,
          stepId: typeof review.StepId === "string" ? review.StepId : null,
          target: chosen,
          today,
        });
        if (worked.kind === "step_settled") {
          throw new RentReviewError("step_settled", "The schedule row on this review's date is already settled by another review.");
        }
        if (worked.kind === "stale") throw new RentReviewError("stale_schedule", "The schedule changed since this was calculated — calculate again");
        if (worked.kind === "unrepresentable") {
          const why = unrepresentableRent(chosen, calc.currentAnnual, isReviewRatchetOn(tenancy));
          throw new RentReviewError(why.code, why.message);
        }
        const receipt = worked.written;
        // C5 sends an out-of-band result to a second person, unless a director overrides it (A2).
        const bandOverridden = !sanity.inBand && directorOverride?.checks.has("out_of_band") === true;
        const reasons = [
          ...(override ? ["override"] : []),
          ...(sanity.inBand || bandOverridden ? [] : ["out_of_band"]),
          ...(calc.method === "other" ? ["manual_method"] : []),
          ...(departures.length > 0 ? ["basis_departs_from_lease"] : []),
          // A3: a new rent below the current one is never applied in one step.
          ...(chosen < calc.currentAnnual ? ["reduction"] : []),
        ];
        const buildingId = Number(tenancy.BuildingId);
        const scope = { buildingId, correlationId, subject: { id: reviewId, type: "rent_review" as const }, tenantId };
        // M3: a basis that departs from the lease is set beside the lease's own result.
        const leaseTerms =
          departures.length > 0 && calc.method !== "other"
            ? await rentOnLeaseTerms(db, {
                lease,
                method: calc.method,
                newStepId: randomUUID(),
                reviewId,
                schedule,
                scheduledFor,
                scheduleVersion: calc.scheduleVersion,
                stepId: typeof review.StepId === "string" ? review.StepId : null,
                today,
              })
            : null;
        const differenceAnnual = override ? r2(override.newAnnual - calc.newAnnual) : 0;
        const ancillaryDifferenceAnnual = r2(ancillaryAnnual(receipt.cascade) - ancillaryAnnual(calc.cascade));
        const area = receipt.row.areaMissing ? 0 : receipt.row.sqm;
        const submitted: RentReviewCalc = override
          ? {
              ...calc,
              departures,
              override: {
                ancillaryDifferenceAnnual,
                appliedPercent: chosenPercent,
                arrears: receipt.arrears,
                cascade: receipt.cascade,
                differenceAnnual,
                newAnnual: override.newAnnual,
                perMonth: r2(override.newAnnual / 12),
                perSqm: area > 0 ? r2(override.newAnnual / area) : null,
                reason: override.reason,
              },
              sanity,
              ...(leaseTerms ? { leaseTerms } : {}),
            }
          : // The computed rent's receipt again, its arrears to today.
            { ...calc, arrears: receipt.arrears, cascade: receipt.cascade, departures, override: undefined, sanity, ...(leaseTerms ? { leaseTerms } : {}) };
        if (signOffOverridden && directorOverride) {
          submitted.directorOverrides = [
            { at: new Date().toISOString(), by: { name: caller.actor.name, userId: caller.actor.userId }, check: "not_signed_off", reason: directorOverride.reason },
          ];
        }
        const chosenFigures = { appliedPercent: chosenPercent, currentAnnual: calc.currentAnnual, newAnnual: chosen };
        // The checks a director overrode, each its own exception with its facts.
        const recordOverrides = async (): Promise<void> => {
          if (!directorOverride) return;
          const base = { actor: caller.actor, buildingId, correlationId, reason: directorOverride.reason, reviewId, tenantId };
          if (signOffOverridden) await recordDirectorOverride(db, { ...base, check: "not_signed_off", facts: await signOffFacts(db, tenancy) });
          if (bandOverridden) {
            await recordDirectorOverride(db, {
              ...base,
              check: "out_of_band",
              facts: { appliedPercent: chosenPercent, band: { maxPercent: sanity.maxPercent, minPercent: sanity.minPercent } },
            });
          }
        };

        if (reasons.length === 0) {
          const basisOfApply = bandOverridden ? "director_override" : "auto_in_bounds";
          await ledger.record(db, {
            ...scope,
            action: "rent_review.submit",
            actor: caller.actor,
            after: { ...chosenFigures, sanity, state: "approved" },
            before: { state },
            ruleApplied: basisOfApply,
          });
          await recordOverrides();
          const applied = await applyReview(db, {
            actor: caller.actor,
            actorOid: oidFromToken(token) ?? "unknown",
            approvalBasis: basisOfApply,
            calc: submitted,
            director,
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
          return { after, applied: true, basisEditors: [], buildingId: applied.buildingId, calc: submitted, chosenFigures, reasons, scheduledFor, tenantId };
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
        await recordOverrides();
        if (override) {
          await ledger.record(db, {
            ...scope,
            action: "rent_review.override",
            actor: caller.actor,
            after: { ancillaryAnnual: ancillaryAnnual(receipt.cascade), appliedPercent: chosenPercent, newAnnual: override.newAnnual },
            computed: { ancillaryAnnual: ancillaryAnnual(calc.cascade), appliedPercent: calc.appliedPercent, newAnnual: calc.newAnnual },
            // Annualised money forgone (positive) or gained (negative) against the
            // calculated result: the rent and every charge that follows it.
            financialImpact: r2(-(differenceAnnual + ancillaryDifferenceAnnual)),
            reason: override.reason,
            ruleApplied: departures.length > 0 ? "override+basis_departs_from_lease" : "override",
          });
        }
        if (leaseTerms) {
          const chosenTotal = chosen + ancillaryAnnual(receipt.cascade);
          await ledger.record(db, {
            ...scope,
            action: "rent_review.basis_departure",
            actor: caller.actor,
            after: { ancillaryAnnual: ancillaryAnnual(receipt.cascade), appliedPercent: chosenPercent, departures, newAnnual: chosen },
            computed: { onLeaseTerms: leaseTerms },
            // Annual money forgone (positive) or gained (negative) against the lease's own terms.
            financialImpact: "unavailable" in leaseTerms ? null : r2(leaseTerms.newAnnual + leaseTerms.ancillaryAnnual - chosenTotal),
            ruleApplied: `departs:${departures.join("+")}`.slice(0, 100),
          });
        }
        const after = await loadReview(db, reviewId);
        if (!after) throw new Error(`Review ${reviewId} vanished while being submitted`);
        const basisEditors = await basisEditorsSinceCommence(db, reviewId);
        return { after, applied: false, basisEditors, buildingId, calc: submitted, chosenFigures, reasons, scheduledFor, tenantId };
      });
    } catch (error) {
      await recordReviewRefusal(db, error);
      throw error;
    }

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
      excludeUserIds: separationOfDuties({ basisEditorIds: done.basisEditors, calc: done.calc, preparedById: caller.actor.userId }),
      log: (message) => context.warn(message),
      reasons: done.reasons,
      reviewId,
      startAtRole: done.reasons.includes("reduction") ? "director" : null,
    });
    return { jsonBody: { applied: false, review }, status: 200 };
  } catch (error) {
    return rentReviewErrorResponse(error, context, "submitRentReview");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("submitRentReview", { authLevel: "anonymous", handler: submitRentReview, methods: ["POST"] });
