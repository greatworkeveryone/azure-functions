// POST /api/approveRentReview   (PLAN §3.1 APPROVE, C6, C7, WP26)
//
//   { reviewId, rowVersion, directorOverride?: { checks: ["not_signed_off"], reason } }
//   200 { review, nextReview }
//
// A second person approves a review waiting for approval, and it is applied
// (rentReview/apply.ts: C4 and C3 again, the step, the change log, the tenancy,
// the outcome) in the same transaction as the approval.
//
//   rowVersion  the one the caller read, else 409 { code: "stale", current }
//   state       awaiting_approval, else 409 invalid_state
//   role        accounts_manager, cfo or director; admin is never an approver
//               (D20), so it is refused here though requireRole lets it through
//   C6          the approver isn't the preparer, whoever keyed a manual rent, nor
//               anyone who changed the basis since commence, else 403 sod_blocked,
//               ledgered as sod_blocked. Directors are never blocked (sprint
//               decision 17): a director approving their own preparation passes
//               the money gate's step-up like any approval and the approval is
//               ledgered with rule director_own_preparation
//   C7          the approver holds the level E3 has reached (accounts_manager,
//               then cfo, then director; higher levels may approve lower), else
//               403 approval_level, ledgered as denied. A new rent below the
//               current one needs a director whatever the rung (A3); an override
//               below the computed rent that is still above the current one
//               stays on the normal ladder
//   C4, C3      as APPLY: 409 stale_schedule ("return it so it can be calculated
//               again"), 422 not_signed_off (with directorCanOverride for a
//               director). A director may override C3 with
//               directorOverride: { checks: ["not_signed_off"], reason }, ledgered as
//               rent_review.director_override with the sign-off facts; a C3
//               override made at submit already rides in the calc
// 409 try_again when SQL Server chose this approval as a deadlock's victim (an
// approve and a revert on one tenancy at once); nothing was written.
// Ledgered as rent_review.approve and rent_review.apply in the same transaction.
// After the commit: caches, E2/E3 end as approved (the preparer is told), the next
// review is scheduled, and the rent_review Planner tasks complete while Planner is on.
//
// Gates: REVIEW_APPROVE_ROLES (rentReview/http.ts, frontend approveRentReview),
// then the money-action gate (S11).

import { randomUUID } from "node:crypto";
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { AppRole, extractToken, oidFromToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import * as ledger from "../ledger";
import { requireMoneyContext } from "../moneyGate";
import { sqlDateToIso } from "../nextReviewDate";
import { canTransition, type RentReviewState } from "../rentReviewMachine";
import { chosenFigures, isReduction, parseCalc } from "../rentReviewCalc";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { afterReviewDecision } from "../rentReview/afterDecision";
import { applyReview } from "../rentReview/apply";
import { readDirectorOverride } from "../rentReview/directorOverride";
import { toReviewDto } from "../rentReview/dto";
import { REVIEW_DECISION_CODES } from "../rentReview/escalationRules";
import { requiredApprovalRoleOf } from "../rentReview/approvalLevel";
import { basisEditorsSinceCommence, dutiesOf } from "../rentReview/escalations";
import {
  APPROVER_RANK,
  approverRank,
  readJsonObject,
  readReviewId,
  readRowVersion,
  recordReviewRefusal,
  REVIEW_APPROVE_ROLES,
  RentReviewError,
  rentReviewErrorResponse,
  resolveCaller,
  staleReview,
} from "../rentReview/http";
import { inTransaction, loadReview, reviewForUpdate } from "../rentReview/store";

const ROLE_WORDS: Record<string, string> = { accounts_manager: "an accounts manager", cfo: "the CFO", director: "a director" };

type SodPart = "basis" | "keyed" | "prepared";

const SOD_WORDS: Record<SodPart, { message: string; rule: string }> = {
  basis: { message: "You changed this review's basis, so someone else has to approve it", rule: "approver_edited_basis" },
  keyed: { message: "You keyed this review's rent by hand, so someone else has to approve it", rule: "approver_keyed_rent" },
  prepared: { message: "You prepared this review, so someone else has to approve it", rule: "approver_is_preparer" },
};

export async function approveRentReview(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    const directorOverride = readDirectorOverride(body.directorOverride, ["not_signed_off"]);

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
        if (!canTransition(state, "APPROVE")) {
          throw new RentReviewError("invalid_state", `This review is ${state.replace(/_/g, " ")}; only one waiting for approval can be approved`, { state });
        }
        const tenantId = Number(review.TenantId);
        const buildingId = Number(review.TenantBuildingId);
        const refusal = (action: "denied" | "sod_blocked", rule: string, message: string) => ({
          action,
          actor: caller.actor,
          before: { attempted: "rent_review.approve", state },
          buildingId,
          reason: message,
          ruleApplied: rule,
          subject: { id: reviewId, type: "rent_review" as const },
          tenantId,
        });

        const rank = approverRank(caller.roles);
        if (rank === 0) {
          const message = "Only an accounts manager, the CFO or a director can approve a rent review";
          throw new RentReviewError("forbidden", message, {}, refusal("denied", "role_not_permitted", message));
        }
        const calc = parseCalc(review.Calc);
        if (!calc) throw new RentReviewError("not_calculated", "This review has no calculation to approve; return it to be calculated", { state });

        // C6: separation of duties. Directors are never blocked (sprint decision 17):
        // a director approving their own preparation goes through the money gate's
        // step-up like any approval and is ledgered as director_own_preparation.
        const userId = caller.actor.userId;
        if (userId === null) {
          throw new RentReviewError("no_user", "Your Floorplan user couldn't be found, so your approval can't be checked against who prepared it");
        }
        const preparedById = review.PreparedById === null || review.PreparedById === undefined ? null : Number(review.PreparedById);
        const duties = dutiesOf({ basisEditorIds: await basisEditorsSinceCommence(db, reviewId), calc, preparedById });
        const part: SodPart | null =
          duties.preparedBy === userId ? "prepared" : duties.keyedBy === userId ? "keyed" : duties.basisEditors.includes(userId) ? "basis" : null;
        const director = caller.roles.includes(AppRole.DIRECTOR);
        if (directorOverride && !director) {
          const message = "Only a director can override a rent review's checks";
          throw new RentReviewError("forbidden", message, {}, refusal("denied", "director_override_not_director", message));
        }
        if (part && !director) {
          const { message, rule } = SOD_WORDS[part];
          throw new RentReviewError("sod_blocked", message, {}, refusal("sod_blocked", rule, message));
        }

        // C7: the level E3 has reached; a director, whatever the rung, for a lower rent (A3).
        const reduction = isReduction(calc);
        const required = requiredApprovalRoleOf(review, calc);
        if (rank < (APPROVER_RANK[required] ?? APPROVER_RANK.director)) {
          const message = reduction
            ? "This review lowers the rent, so a director has to approve it"
            : `This review now needs ${ROLE_WORDS[required] ?? "a director"} to approve it`;
          throw new RentReviewError(
            "approval_level",
            message,
            { requiredRole: required },
            refusal("denied", reduction ? "reduction_needs_director" : "approval_level", message),
          );
        }

        const { appliedPercent: chosenPercent, newAnnual: chosen } = chosenFigures(calc);
        await ledger.record(db, {
          action: "rent_review.approve",
          actor: caller.actor,
          after: { appliedPercent: chosenPercent, newAnnual: chosen, requiredRole: required, state: "approved" },
          before: { preparedById, state },
          buildingId,
          ...(part ? { computed: { ownPart: part, separationOfDuties: duties, stepUp: "money gate (S11)" } } : {}),
          correlationId,
          ruleApplied: part ? "director_own_preparation" : reduction ? "reduction_director" : `level_${required}`,
          subject: { id: reviewId, type: "rent_review" },
          tenantId,
        });
        const applied = await applyReview(db, {
          actor: caller.actor,
          actorOid: oidFromToken(token) ?? "unknown",
          approvalBasis: "approved",
          calc,
          chosenNewAnnual: chosen,
          director,
          directorOverride,
          chosenPercent,
          correlationId,
          from: "awaiting_approval",
          newStepId: randomUUID(),
          review,
          today,
        });
        const after = await loadReview(db, reviewId);
        if (!after) throw new Error(`Review ${reviewId} vanished while being approved`);
        return { after, buildingId: applied.buildingId, scheduledFor: sqlDateToIso(review.ScheduledFor) ?? "", tenantId };
      });
    } catch (error) {
      await recordReviewRefusal(db, error);
      throw error;
    }

    const review = toReviewDto(done.after, today);
    const nextReview = await afterReviewDecision(db, {
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
    return { jsonBody: { nextReview, review }, status: 200 };
  } catch (error) {
    return rentReviewErrorResponse(error, context, "approveRentReview");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("approveRentReview", { authLevel: "anonymous", handler: approveRentReview, methods: ["POST"] });
