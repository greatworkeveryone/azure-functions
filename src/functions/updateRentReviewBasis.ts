// POST /api/updateRentReviewBasis
//
//   { reviewId, rowVersion, reason, basis: { <the fields to change> } }
//
// Corrects the basis a review is being decided on (PLAN §3.2): the CPI region,
// cap, floor and reference-quarter rule; the fixed %; the market clause and
// deadlines; the description of an "other" review; the interval and the
// ratchet. Only the fields named change; null clears one. The method, the
// review date and the lease's review type are the snapshot's facts and can't be
// edited here (rentReview/basis.ts lists the keys per method).
//
//   state      in_progress or awaiting_index, else 409 { code: "invalid_state" }
//   who        the review's owner, or an accounts manager and up (cfo, director,
//              admin), else 403 { code: "forbidden" }
//   reason     required: a plain sentence on why, ledgered
//   rowVersion must be the one the caller read, else 409 { code: "stale", current }
//
// Ledgered as rent_review.basis_update in the same transaction, with the old
// and new values of the fields that changed. 200 { review }.
//
// Gate: the roles that may edit a tenancy (rentReview/http.ts); the owner or
// manager check on top of it is made against the review.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import * as ledger from "../ledger";
import type { RentReviewMethod, RentReviewState } from "../rentReviewMachine";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { applyBasisPatch, parseBasis, validateBasisPatch } from "../rentReview/basis";
import { toReviewDto } from "../rentReview/dto";
import {
  isManagerOrAbove,
  readJsonObject,
  readReason,
  readReviewId,
  readRowVersion,
  RentReviewError,
  rentReviewErrorResponse,
  resolveCaller,
  staleReview,
  TENANCY_EDIT_ROLES,
} from "../rentReview/http";
import { inTransaction, loadReview, reviewForUpdate, saveBasis } from "../rentReview/store";

/** The states a review's basis can still be corrected in. */
const BASIS_EDITABLE_STATES: readonly RentReviewState[] = ["in_progress", "awaiting_index"];

const METHODS: readonly string[] = ["cpi", "fixed", "market", "other"];

export async function updateRentReviewBasis(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, TENANCY_EDIT_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = await readJsonObject(request);
    const reviewId = readReviewId(body.reviewId);
    const rowVersion = readRowVersion(body.rowVersion);
    const reason = readReason(body.reason);

    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    const db = connection;
    const today = todayInDarwin();

    const done = await inTransaction(db, async () => {
      const review = await reviewForUpdate(db, reviewId);
      if (!review) throw new RentReviewError("not_found", "That review doesn't exist");
      if (rowVersionHex(review.Version) !== rowVersion) throw staleReview(review, today);

      const state = review.State as RentReviewState;
      if (!BASIS_EDITABLE_STATES.includes(state)) {
        throw new RentReviewError(
          "invalid_state",
          `The basis can only be changed while a review is in progress or waiting for the index; this one is ${state.replace(/_/g, " ")}`,
          { state },
        );
      }

      const ownerUserId = review.OwnerUserId === null || review.OwnerUserId === undefined ? null : Number(review.OwnerUserId);
      const isOwner = ownerUserId !== null && ownerUserId === caller.actor.userId;
      if (!isOwner && !isManagerOrAbove(caller.roles)) {
        throw new RentReviewError("forbidden", "Only the review's owner, or an accounts manager or above, can change its basis");
      }

      const method = String(review.Method);
      if (!METHODS.includes(method)) {
        throw new RentReviewError("invalid_state", "This review has no method yet, so it has no basis to change", { state });
      }
      const patch = validateBasisPatch(method as RentReviewMethod, body.basis);
      if (!patch.ok) throw new RentReviewError("bad_request", patch.error);
      const applied = applyBasisPatch(parseBasis(review.Basis) ?? {}, patch.patch);
      if (!applied.ok) throw new RentReviewError(applied.kind === "no_change" ? "no_change" : "bad_request", applied.error);

      if (!(await saveBasis(db, reviewId, JSON.stringify(applied.change.basis)))) {
        throw new RentReviewError("invalid_state", "This review just moved on, so its basis can't be changed", { state });
      }

      const tenantId = Number(review.TenantId);
      const buildingId = Number(review.TenantBuildingId);
      await ledger.record(db, {
        action: "rent_review.basis_update",
        actor: caller.actor,
        after: applied.change.after,
        before: applied.change.before,
        buildingId,
        reason,
        subject: { id: reviewId, type: "rent_review" },
        tenantId,
      });

      const after = await loadReview(db, reviewId);
      if (!after) throw new Error(`Review ${reviewId} vanished while its basis was being changed`);
      return { after, buildingId, tenantId };
    });

    invalidateTenantAndBuilding(done.tenantId, done.buildingId);
    return { jsonBody: { review: toReviewDto(done.after, today) }, status: 200 };
  } catch (error) {
    return rentReviewErrorResponse(error, context, "updateRentReviewBasis");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("updateRentReviewBasis", { authLevel: "anonymous", handler: updateRentReviewBasis, methods: ["POST"] });
