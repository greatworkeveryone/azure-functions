// POST /api/approveRentReview   (PLAN §3.1 APPROVE, C6, C7, WP26)
//
//   { reviewId, rowVersion }
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
//   C6          the approver isn't the preparer (nor whoever keyed a manual rent),
//               else 403 sod_blocked, ledgered as sod_blocked
//   C7          the approver holds the level E3 has reached (accounts_manager,
//               then cfo, then director; higher levels may approve lower), else
//               403 approval_level, ledgered as denied
//   C4, C3      as APPLY: 409 stale_schedule ("return it so it can be calculated
//               again"), 422 not_signed_off
// Ledgered as rent_review.approve and rent_review.apply in the same transaction.
// After the commit: caches, E2/E3 end as approved (the preparer is told), the next
// review is scheduled, and the rent_review Planner tasks complete while Planner is on.
//
// Gates: REVIEW_APPROVE_ROLES (rentReview/http.ts, frontend approveRentReview),
// then the money-action gate (S11).

import { randomUUID } from "node:crypto";
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, oidFromToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import * as ledger from "../ledger";
import { requireMoneyContext } from "../moneyGate";
import { sqlDateToIso } from "../nextReviewDate";
import { canTransition, type RentReviewState } from "../rentReviewMachine";
import { parseCalc } from "../rentReviewCalc";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { afterReviewDecision } from "../rentReview/afterDecision";
import { applyReview } from "../rentReview/apply";
import { toReviewDto } from "../rentReview/dto";
import { REVIEW_DECISION_CODES } from "../rentReview/escalationRules";
import { requiredApprovalRole, separationOfDuties } from "../rentReview/escalations";
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

const r4 = (n: number): number => Math.round(n * 10000) / 10000 || 0;

const ROLE_WORDS: Record<string, string> = { accounts_manager: "an accounts manager", cfo: "the CFO", director: "a director" };

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

        // C6: separation of duties.
        if (caller.actor.userId === null) {
          throw new RentReviewError("no_user", "Your Floorplan user couldn't be found, so your approval can't be checked against who prepared it");
        }
        const preparedById = review.PreparedById === null || review.PreparedById === undefined ? null : Number(review.PreparedById);
        if (separationOfDuties({ calc, preparedById }).includes(caller.actor.userId)) {
          const message = "You prepared this review, so someone else has to approve it";
          throw new RentReviewError("sod_blocked", message, {}, refusal("sod_blocked", "approver_is_preparer", message));
        }

        // C7: the level E3 has reached.
        const required = await requiredApprovalRole(db, reviewId);
        if (rank < (APPROVER_RANK[required] ?? APPROVER_RANK.director)) {
          const message = `This review now needs ${ROLE_WORDS[required] ?? "a director"} to approve it`;
          throw new RentReviewError("approval_level", message, { requiredRole: required }, refusal("denied", "approval_level", message));
        }

        const chosen = calc.override?.newAnnual ?? calc.newAnnual;
        const chosenPercent = calc.override ? r4((chosen / calc.currentAnnual - 1) * 100) : calc.appliedPercent;
        await ledger.record(db, {
          action: "rent_review.approve",
          actor: caller.actor,
          after: { appliedPercent: chosenPercent, newAnnual: chosen, requiredRole: required, state: "approved" },
          before: { preparedById, state },
          buildingId,
          correlationId,
          ruleApplied: `level_${required}`,
          subject: { id: reviewId, type: "rent_review" },
          tenantId,
        });
        const applied = await applyReview(db, {
          actor: caller.actor,
          actorOid: oidFromToken(token) ?? "unknown",
          approvalBasis: "approved",
          calc,
          chosenNewAnnual: chosen,
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
