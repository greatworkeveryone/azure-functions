// POST /api/cancelRentReview   (PLAN §3.1 CANCEL, WP26)
//
//   { reviewId, rowVersion, reason }
//   200 { review, nextReview }
//
// Withdraws an open review, with a reason: any open state -> cancelled. Nothing
// on the schedule changes. What it does to the review date (decided here):
//   superseded  the tenancy is live: the date is NOT settled (a cancelled review
//               never settles its date, nextReviewDate.ts), so the date still
//               needs a review and one is scheduled for it at once, after the
//               commit, by the generator's own function (nextReview). Cancel is
//               how a review is started afresh; a review that should change
//               nothing is waived, which does settle its date.
//   vacated     the tenancy has been vacated: nothing more is scheduled, so the
//               tenancy is left with no review, as it must be. Cancelling is how a
//               vacated tenancy's open review is closed, so it is allowed here
//               (every other review write refuses a vacated tenancy).
//
//   rowVersion  the one the caller read, else 409 { code: "stale", current }
//   state       an open one, else 409 invalid_state
//   reason      required (400 reason_required)
//   tenancy     archived 422 tenancy_archived (an archived tenancy's reviews are
//               history until it is restored)
// Ledgered as rent_review.cancel (an exception, with the reason; ruleApplied
// cancel_superseded or cancel_vacated). After the commit the review's
// escalations are withdrawn with the reason (one somebody had acknowledged is
// resolved as cancelled).
//
// Gate: REVIEW_CANCEL_ROLES (rentReview/http.ts): an accounts manager and up,
// as isManagerOrAbove; frontend capability editAnyRentReview.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import * as ledger from "../ledger";
import { canTransition, type RentReviewState } from "../rentReviewMachine";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { afterReviewDecision } from "../rentReview/afterDecision";
import { toReviewDto } from "../rentReview/dto";
import { REVIEW_DECISION_CODES } from "../rentReview/escalationRules";
import {
  isManagerOrAbove,
  readJsonObject,
  readReason,
  readReviewId,
  readRowVersion,
  REVIEW_CANCEL_ROLES,
  RentReviewError,
  rentReviewErrorResponse,
  resolveCaller,
  staleReview,
  tenancyArchived,
} from "../rentReview/http";
import { inTransaction, loadReview, reviewForUpdate } from "../rentReview/store";
import { markCancelled } from "../rentReview/transitions";

export async function cancelRentReview(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, REVIEW_CANCEL_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = await readJsonObject(request);
    const reviewId = readReviewId(body.reviewId);
    const rowVersion = readRowVersion(body.rowVersion);
    const reason = readReason(body.reason, "Say why the review is cancelled (a reason is required)");

    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    if (!isManagerOrAbove(caller.roles)) {
      throw new RentReviewError("forbidden", "Only an accounts manager or above can cancel a rent review");
    }
    const db = connection;
    const today = todayInDarwin();

    const done = await inTransaction(db, async () => {
      const review = await reviewForUpdate(db, reviewId);
      if (!review) throw new RentReviewError("not_found", "That review doesn't exist");
      if (rowVersionHex(review.Version) !== rowVersion) throw staleReview(review, today);
      const state = review.State as RentReviewState;
      if (!canTransition(state, "CANCEL")) {
        throw new RentReviewError("invalid_state", `This review is ${state.replace(/_/g, " ")}; only an open review can be cancelled`, { state });
      }
      if (review.TenantArchivedAt !== null && review.TenantArchivedAt !== undefined) throw tenancyArchived();
      const kind = review.TenantStatus === "vacated" ? "vacated" : "superseded";
      if (!(await markCancelled(db, reviewId))) {
        throw new RentReviewError("invalid_state", "This review just moved on, so it wasn't cancelled", { state });
      }
      const tenantId = Number(review.TenantId);
      const buildingId = Number(review.TenantBuildingId);
      await ledger.record(db, {
        action: "rent_review.cancel",
        actor: caller.actor,
        after: { kind, replacement: kind === "superseded" ? "a review for the date the schedule derives is scheduled" : "none: the tenancy has been vacated", state: "cancelled" },
        before: { state },
        buildingId,
        reason,
        ruleApplied: `cancel_${kind}`,
        subject: { id: reviewId, type: "rent_review" },
        tenantId,
      });
      const after = await loadReview(db, reviewId);
      if (!after) throw new Error(`Review ${reviewId} vanished while being cancelled`);
      return { after, buildingId, kind, tenantId };
    });

    const review = toReviewDto(done.after, today);
    const nextReview = await afterReviewDecision(db, {
      actor: caller.actor,
      buildingId: done.buildingId,
      code: REVIEW_DECISION_CODES.cancelled,
      log: (message) => context.warn(message),
      note: reason,
      reviewId,
      scheduleNext: done.kind === "superseded",
      scheduledFor: review.scheduledFor,
      state: review.state,
      tenantId: done.tenantId,
      today,
    });
    return { jsonBody: { nextReview, review }, status: 200 };
  } catch (error) {
    return rentReviewErrorResponse(error, context, "cancelRentReview");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("cancelRentReview", { authLevel: "anonymous", handler: cancelRentReview, methods: ["POST"] });
