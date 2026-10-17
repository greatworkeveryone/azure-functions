// POST /api/revertRentReview   (PLAN §3.1 REVERT, WP26)
//
//   { reviewId, rowVersion, reason }
//   200 { review }
//
// Takes back an applied review before it is completed: approved -> in_progress,
// and the schedule as it was before (rentReview/revert.ts): the next review
// APPLY scheduled is cancelled first (ledgered), the steps APPLY wrote are
// restored from the change log, LastReviewDate, LastReviewIncreasePercent and
// the RentPerAnnum cache go back, NextReviewDate is re-derived, the arrears line
// is unbilled again. All in one transaction.
//
//   rowVersion  the one the caller read, else 409 { code: "stale", current }
//   state       approved, else 409 invalid_state (a completed review stays)
//   reason      required (400 reason_required)
//   role        accounts_manager, cfo or director; admin is never an approver
//               (403 forbidden, ledgered as denied)
//   tenancy     archived 422 tenancy_archived, vacated 422 tenancy_vacated
//   409 changed_since_apply   the schedule row or review fields were edited since
//   409 next_review_in_progress   the next review has been started
//   409 not_revertible        APPLY's record can't be found
//   409 try_again             another review was opened on the tenancy at the same
//                             moment (the one-open-review index), or SQL Server chose
//                             this revert as a deadlock's victim; nothing was written
// Ledgered as rent_review.revert (an exception, with the reason) and, for the
// next review, rent_review.cancel. After the commit: caches, and the cancelled
// next review's escalations are withdrawn. The reverted review is open again, so
// the generator raises its E2 again if it is overdue.
//
// Gates: REVIEW_APPROVE_ROLES (rentReview/http.ts, frontend revertRentReview),
// then the money-action gate (S11).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, oidFromToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import * as ledger from "../ledger";
import { requireMoneyContext } from "../moneyGate";
import { isUniqueViolation } from "../escalation/errors";
import { canTransition, type RentReviewState } from "../rentReviewMachine";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { afterReviewDecision } from "../rentReview/afterDecision";
import { toReviewDto } from "../rentReview/dto";
import { REVIEW_DECISION_CODES } from "../rentReview/escalationRules";
import { settleReviewEscalations } from "../rentReview/escalations";
import {
  deniedAttempt,
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
import { revertReview } from "../rentReview/revert";
import { inTransaction, loadReview, reviewForUpdate } from "../rentReview/store";

export async function revertRentReview(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    const reason = readReason(body.reason, "Say why the review is reverted (a reason is required)");

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
        // Admin passes requireRole but is never an approver (D20); the attempt is ledgered (L4).
        if (!holdsApproverRole(caller.roles)) {
          const message = "Only an accounts manager, the CFO or a director can revert a rent review";
          throw new RentReviewError("forbidden", message, {}, deniedAttempt(caller, review, "rent_review.revert", "role_not_permitted", message));
        }
        if (rowVersionHex(review.Version) !== rowVersion) throw staleReview(review, today);
        const state = review.State as RentReviewState;
        if (!canTransition(state, "REVERT")) {
          throw new RentReviewError(
            "invalid_state",
            state === "completed"
              ? "This review has been completed, so it can't be reverted"
              : `This review is ${state.replace(/_/g, " ")}; only an applied review can be reverted`,
            { state },
          );
        }
        const reverted = await revertReview(db, {
          actor: caller.actor,
          actorOid: oidFromToken(token) ?? "unknown",
          correlationId,
          reason,
          review,
          today,
        });
        const after = await loadReview(db, reviewId);
        if (!after) throw new Error(`Review ${reviewId} vanished while being reverted`);
        return { after, ...reverted };
      });
    } catch (error) {
      await recordReviewRefusal(db, error);
      // L1: a review opened on the tenancy between the next-review check and this
      // one going back to in progress (the one-open-review index): nothing was written.
      if (isUniqueViolation(error)) {
        throw new RentReviewError(
          "try_again",
          "Another review was opened on this tenancy at the same moment, so this one wasn't reverted. Try again.",
        );
      }
      throw error;
    }

    const review = toReviewDto(done.after, today);
    await afterReviewDecision(db, {
      actor: caller.actor,
      buildingId: done.buildingId,
      code: REVIEW_DECISION_CODES.reverted,
      log: (message) => context.warn(message),
      note: reason,
      reviewId,
      scheduledFor: review.scheduledFor,
      state: review.state,
      tenantId: done.tenantId,
      today,
    });
    if (done.cancelledNext) {
      await settleReviewEscalations(db, {
        actor: caller.actor,
        code: REVIEW_DECISION_CODES.cancelled,
        log: (message) => context.warn(message),
        note: `The review before it was reverted: ${reason}`.slice(0, 2000),
        reviewId: done.cancelledNext.reviewId,
        scheduledFor: done.cancelledNext.scheduledFor,
        state: "cancelled",
        today,
      });
    }
    return { jsonBody: { review }, status: 200 };
  } catch (error) {
    return rentReviewErrorResponse(error, context, "revertRentReview");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("revertRentReview", { authLevel: "anonymous", handler: revertRentReview, methods: ["POST"] });
