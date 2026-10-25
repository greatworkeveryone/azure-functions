// POST /api/returnRentReview   (PLAN §3.1 RETURN, WP26)
//
//   { reviewId, rowVersion, note }
//   200 { review }
//
// An approver sends a review waiting for approval back to its preparer, saying
// why: awaiting_approval -> in_progress. The calc stays (with any override) for
// the preparer to revise or recalculate; the submission is cleared.
//
//   rowVersion  the one the caller read, else 409 { code: "stale", current }
//   state       awaiting_approval, else 409 invalid_state
//   note        required (400 reason_required)
//   role        accounts_manager, cfo or director; admin is never an approver
//               (403 forbidden, ledgered as denied)
//   tenancy     archived 422 tenancy_archived, vacated 422 tenancy_vacated
// Ledgered as rent_review.return with the note. After the commit E3 ends as
// "returned" and its raiser, the preparer, is told.
//
// Gate: REVIEW_APPROVE_ROLES (rentReview/http.ts; return is the approvers' action).

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
  tenancyArchived,
} from "../rentReview/http";
import { inTransaction, loadReview, reviewForUpdate } from "../rentReview/store";
import { markReturned } from "../rentReview/transitions";

export async function returnRentReview(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, REVIEW_APPROVE_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = await readJsonObject(request);
    const reviewId = readReviewId(body.reviewId);
    const rowVersion = readRowVersion(body.rowVersion);
    const note = readReason(body.note, "Say what needs changing (a note is required)");

    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    const db = connection;
    const today = todayInDarwin();

    let done;
    try {
      done = await inTransaction(db, async () => {
        const review = await reviewForUpdate(db, reviewId);
        if (!review) throw new RentReviewError("not_found", "That review doesn't exist");
        // Admin passes requireRole but is never an approver (D20); the attempt is ledgered (L4).
        if (!holdsApproverRole(caller.roles)) {
          const message = "Only an accounts manager, the CFO or a director can return a rent review";
          throw new RentReviewError("forbidden", message, {}, deniedAttempt(caller, review, "rent_review.return", "role_not_permitted", message));
        }
        if (rowVersionHex(review.Version) !== rowVersion) throw staleReview(review, today);
        const state = review.State as RentReviewState;
        if (!canTransition(state, "RETURN")) {
          throw new RentReviewError("invalid_state", `This review is ${state.replace(/_/g, " ")}; only one waiting for approval can be returned`, { state });
        }
        if (review.TenantArchivedAt !== null && review.TenantArchivedAt !== undefined) throw tenancyArchived();
        if (review.TenantStatus === "vacated") {
          throw new RentReviewError("tenancy_vacated", "This tenancy has been vacated, so its rent review can't be changed.");
        }
        if (!(await markReturned(db, reviewId))) {
          throw new RentReviewError("invalid_state", "This review just moved on, so it wasn't returned", { state });
        }
        const tenantId = Number(review.TenantId);
        const buildingId = Number(review.TenantBuildingId);
        await ledger.record(db, {
          action: "rent_review.return",
          actor: caller.actor,
          after: { state: "in_progress" },
          before: { preparedById: review.PreparedById ?? null, state },
          buildingId,
          reason: note,
          subject: { id: reviewId, type: "rent_review" },
          tenantId,
        });
        const after = await loadReview(db, reviewId);
        if (!after) throw new Error(`Review ${reviewId} vanished while being returned`);
        return { after, buildingId, tenantId };
      });
    } catch (error) {
      await recordReviewRefusal(db, error);
      throw error;
    }

    const review = toReviewDto(done.after, today);
    await afterReviewDecision(db, {
      actor: caller.actor,
      buildingId: done.buildingId,
      code: REVIEW_DECISION_CODES.returned,
      log: (message) => context.warn(message),
      note,
      reviewId,
      scheduledFor: review.scheduledFor,
      state: review.state,
      tenantId: done.tenantId,
      today,
    });
    return { jsonBody: { review }, status: 200 };
  } catch (error) {
    return rentReviewErrorResponse(error, context, "returnRentReview");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("returnRentReview", { authLevel: "anonymous", handler: returnRentReview, methods: ["POST"] });
