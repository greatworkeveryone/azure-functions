// POST /api/commenceRentReview   (PLAN §3.1 COMMENCE: scheduled or due -> in_progress)
//
//   { reviewId, rowVersion }
//
// Starts a review: the caller becomes its owner, the basis is snapshotted from
// the lease (method, region, cap, floor, ratchet, interval, fixed %, and the
// market clause and deadlines, which nothing stores yet), and the review is
// linked to the schedule step dated on its date, if one exists. It does not
// create a step: WP26's APPLY writes the step when the rent is decided.
//
// Checks, in the transaction, under an update lock on the review:
//   rowVersion  must be the one the caller read, else 409 { code: "stale", current }
//   state       scheduled or due, else 409 { code: "invalid_state" }
//   C1          the tenancy isn't archived (422 tenancy_archived) or vacated (422
//               tenancy_vacated) and has no other open review (422 open_review_exists)
//   C2          the method resolves: the step's methodKind, else the tenancy's
//               review type read with mapMethodKind, else "other"
//
// Ledgered as rent_review.commence in the same transaction (no ledger row, no
// commence). 200 { review }. After the commit, the review's E1 (not commenced)
// ends with the code "commenced" (WP26); a failure there is logged and the
// escalation sweep ends it anyway once its condition has cleared.
//
// Gate: the roles that may edit a tenancy, as upsertRegisterTenant
// (frontend capability editTenancy; PLAN WP26 gives commenceRentReview the same).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import * as ledger from "../ledger";
import { canTransition, type RentReviewState } from "../rentReviewMachine";
import { parseSteps } from "../scheduledRateStepLogic";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { buildBasisSnapshot } from "../rentReview/basis";
import { toReviewDto } from "../rentReview/dto";
import { REVIEW_DECISION_CODES } from "../rentReview/escalationRules";
import { settleReviewEscalations } from "../rentReview/escalations";
import {
  readJsonObject,
  readReviewId,
  readRowVersion,
  RentReviewError,
  rentReviewErrorResponse,
  resolveCaller,
  staleReview,
  TENANCY_EDIT_ROLES,
  tenancyArchived,
} from "../rentReview/http";
import { METHOD_RULE_APPLIED, resolveReviewMethod, stepOnDate } from "../rentReview/method";
import {
  inTransaction,
  loadReview,
  loadTenancyForReview,
  markCommenced,
  otherOpenReview,
  reviewForUpdate,
} from "../rentReview/store";

const decimal = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

export async function commenceRentReview(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, TENANCY_EDIT_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = await readJsonObject(request);
    const reviewId = readReviewId(body.reviewId);
    const rowVersion = readRowVersion(body.rowVersion);

    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    const ownerUserId = caller.actor.userId;
    if (ownerUserId === null) {
      throw new RentReviewError("no_user", "Your Floorplan user couldn't be found, so you can't own a review");
    }
    const db = connection;
    const today = todayInDarwin();

    const done = await inTransaction(db, async () => {
      const review = await reviewForUpdate(db, reviewId);
      if (!review) throw new RentReviewError("not_found", "That review doesn't exist");
      if (rowVersionHex(review.Version) !== rowVersion) throw staleReview(review, today);

      const state = review.State as RentReviewState;
      if (!canTransition(state, "COMMENCE")) {
        throw new RentReviewError("invalid_state", `This review is ${state.replace(/_/g, " ")} and can't be commenced`, { state });
      }

      const tenantId = Number(review.TenantId);
      const tenancy = await loadTenancyForReview(db, tenantId);
      if (!tenancy) throw new RentReviewError("not_found", "That review's tenancy doesn't exist");

      // C1: the tenancy hasn't been archived or vacated, and no other review of it is open.
      if (tenancy.ArchivedAt !== null && tenancy.ArchivedAt !== undefined) throw tenancyArchived();
      if (tenancy.Status === "vacated") {
        throw new RentReviewError("tenancy_vacated", "This tenancy has been vacated, so its review can't be commenced");
      }
      const other = await otherOpenReview(db, tenantId, reviewId);
      if (other !== null) {
        throw new RentReviewError("open_review_exists", "This tenancy already has another open review", { reviewId: other });
      }

      // C2: the method, from the step on the review date, else the lease's review type, else "other".
      const scheduledFor = toReviewDto(review, today).scheduledFor;
      const step = stepOnDate(parseSteps(tenancy.ScheduledRateSteps as string | null | undefined), scheduledFor);
      const reviewType = typeof tenancy.ReviewType === "string" ? tenancy.ReviewType : null;
      const resolved = resolveReviewMethod({ reviewType, step });
      const basis = buildBasisSnapshot({
        cpiCapPercent: decimal(tenancy.CpiCapPercent),
        cpiFloorPercent: decimal(tenancy.CpiFloorPercent),
        cpiRegion: typeof tenancy.CpiRegion === "string" ? tenancy.CpiRegion : null,
        fixedReviewPercent: decimal(tenancy.FixedReviewPercent),
        intervalMonths: decimal(tenancy.ReviewIntervalMonths),
        method: resolved.method,
        ratchet: tenancy.ReviewRatchet === true || tenancy.ReviewRatchet === 1,
        reviewDate: scheduledFor,
        reviewType,
        step,
      });

      const buildingId = Number(tenancy.BuildingId);
      const stepId = step?.id ?? null;
      const moved = await markCommenced(db, {
        basisJson: JSON.stringify(basis),
        buildingId,
        method: resolved.method,
        ownerUserId,
        reviewId,
        stepId,
      });
      if (!moved) throw new RentReviewError("invalid_state", "This review was just commenced by someone else", { state });

      await ledger.record(db, {
        action: "rent_review.commence",
        actor: caller.actor,
        after: { basis, method: resolved.method, ownerUserId, state: "in_progress", stepId },
        before: {
          method: (review.Method as string | null) ?? null,
          ownerUserId: decimal(review.OwnerUserId),
          state,
          stepId: (review.StepId as string | null) ?? null,
        },
        buildingId,
        ruleApplied: METHOD_RULE_APPLIED[resolved.source],
        subject: { id: reviewId, type: "rent_review" },
        tenantId,
      });

      const after = await loadReview(db, reviewId);
      if (!after) throw new Error(`Review ${reviewId} vanished while being commenced`);
      return { after, buildingId, tenantId };
    });

    invalidateTenantAndBuilding(done.tenantId, done.buildingId);
    const review = toReviewDto(done.after, today);
    await settleReviewEscalations(db, {
      actor: caller.actor,
      code: REVIEW_DECISION_CODES.commenced,
      log: (message) => context.warn(message),
      reviewId,
      scheduledFor: review.scheduledFor,
      state: review.state,
      today,
    });
    return { jsonBody: { review }, status: 200 };
  } catch (error) {
    return rentReviewErrorResponse(error, context, "commenceRentReview");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("commenceRentReview", { authLevel: "anonymous", handler: commenceRentReview, methods: ["POST"] });
