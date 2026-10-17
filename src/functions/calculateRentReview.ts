// POST /api/calculateRentReview   (PLAN §3.2, WP26)
//
//   { reviewId, rowVersion, manual?: { newAnnual, explanation } }
//
// Works out an in-progress review on the server (rentReviewCalc.ts) and stores
// the receipt as the review's calc:
//   CPI     both index values read from CpiIndex now, on one base; the
//           reference quarter is the quarter ending immediately before the
//           review date (Q5), the earlier one a review interval before it;
//           ratio → clamp(1 + floor, 1 + cap) → ratchet; the cascade to car
//           parks, misc fees and AHAC; arrears to today
//   fixed   old × (1 + the basis's %)
//   other   `manual` is required: the new annual rent and how it was reached
//   market  422 method_not_supported (directors record market reviews; that
//           workflow arrives later)
// A CPI review whose quarter isn't published yet goes to awaiting_index
// (INDEX_PENDING) with ExpectedIndexAt = the quarter's end + 30 days and no
// calc: a 200, not an error. The CPI timer brings it back (INDEX_AVAILABLE).
//
//   rowVersion  the one the caller read, else 409 { code: "stale", current }
//   who         the review's owner, or an accounts manager and up (directors
//               always), else 403 forbidden, ledgered as denied (L5)
//   state       in_progress, else 409 invalid_state
//   tenancy     archived 422 tenancy_archived, vacated 422 tenancy_vacated
//   refusals    422 basis_incomplete, cpi_base_mismatch, earlier_review_pending,
//               no_current_rent; 409 step_settled; 400 manual_required
//
// Ledgered as rent_review.calculate (not an exception) or rent_review.index_pending,
// in the same transaction. 200 { review }.
//
// Gate: the roles that may edit a tenancy, as commence (rentReview/http.ts).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import * as ledger from "../ledger";
import { canTransition, type RentReviewState } from "../rentReviewMachine";
import type { CalcMethod } from "../rentReviewCalc";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { workOutReview } from "../rentReview/calculate";
import { toReviewDto } from "../rentReview/dto";
import {
  deniedAttempt,
  ownsOrManages,
  readJsonObject,
  readReviewId,
  readRowVersion,
  recordReviewRefusal,
  RentReviewError,
  rentReviewErrorResponse,
  resolveCaller,
  staleReview,
  TENANCY_EDIT_ROLES,
} from "../rentReview/http";
import { refuseClosedTenancy } from "../rentReview/reviewTenancy";
import { inTransaction, loadReview, loadTenancyForReview, reviewForUpdate } from "../rentReview/store";
import { markAwaitingIndex, saveCalc } from "../rentReview/transitions";

/** `manual` as sent: only an `other` review takes one. */
function readManual(raw: unknown): { explanation: string; newAnnual: number } | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) throw new RentReviewError("bad_request", "manual must be { newAnnual, explanation }");
  const { explanation, newAnnual } = raw as Record<string, unknown>;
  return {
    explanation: typeof explanation === "string" ? explanation : "",
    newAnnual: typeof newAnnual === "number" ? newAnnual : Number.NaN,
  };
}

const CALC_METHODS: readonly string[] = ["cpi", "fixed", "other"];

export async function calculateRentReview(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, TENANCY_EDIT_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = await readJsonObject(request);
    const reviewId = readReviewId(body.reviewId);
    const rowVersion = readRowVersion(body.rowVersion);
    const manual = readManual(body.manual);

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
        if (rowVersionHex(review.Version) !== rowVersion) throw staleReview(review, today);
        if (!ownsOrManages(review, caller)) {
          const message = "Only the review's owner, or an accounts manager or above, can calculate it";
          throw new RentReviewError("forbidden", message, {}, deniedAttempt(caller, review, "rent_review.calculate", "not_owner_or_manager", message));
        }
        const state = review.State as RentReviewState;
        if (state !== "in_progress") {
          throw new RentReviewError(
            "invalid_state",
            state === "awaiting_index"
              ? "This review is waiting for the CPI index; it comes back to be calculated once the index is published"
              : `This review is ${state.replace(/_/g, " ")}; only a review in progress can be calculated`,
            { state },
          );
        }
        const method = String(review.Method);
        if (method === "market") {
          throw new RentReviewError("method_not_supported", "Market reviews are recorded by directors; that workflow arrives later");
        }
        if (!CALC_METHODS.includes(method)) throw new RentReviewError("invalid_state", "This review has no method to calculate by", { state });
        if (manual && method !== "other") throw new RentReviewError("bad_request", "A new rent is keyed by hand only on an `other` review");

        const tenantId = Number(review.TenantId);
        const tenancy = await loadTenancyForReview(db, tenantId);
        if (!tenancy) throw new RentReviewError("not_found", "That review's tenancy doesn't exist");
        refuseClosedTenancy(tenancy);

        const result = await workOutReview(db, {
          computedBy: { name: caller.actor.name, userId: caller.actor.userId },
          manual,
          method: method as CalcMethod,
          review,
          tenancy,
          today,
        });
        if (result.kind === "refused") throw new RentReviewError(result.code, result.message);

        const buildingId = Number(tenancy.BuildingId);
        const scope = { buildingId, subject: { id: reviewId, type: "rent_review" as const }, tenantId };
        if (result.kind === "index_pending") {
          if (!canTransition(state, "INDEX_PENDING", { method: "cpi" }) || !(await markAwaitingIndex(db, reviewId, result.expectedIndexAt))) {
            throw new RentReviewError("invalid_state", "This review just moved on, so it wasn't calculated", { state });
          }
          await ledger.record(db, {
            ...scope,
            action: "rent_review.index_pending",
            actor: caller.actor,
            after: {
              expectedIndexAt: result.expectedIndexAt,
              missing: result.missing,
              previousQuarter: result.previousQuarter,
              referenceQuarter: result.referenceQuarter,
              region: result.region,
              state: "awaiting_index",
            },
            before: { state },
            ruleApplied: "reference_quarter_unpublished",
          });
        } else {
          if (!(await saveCalc(db, reviewId, JSON.stringify(result.calc)))) {
            throw new RentReviewError("invalid_state", "This review just moved on, so it wasn't calculated", { state });
          }
          await ledger.record(db, {
            ...scope,
            action: "rent_review.calculate",
            actor: caller.actor,
            after: result.calc,
            ruleApplied: method === "cpi" ? "cpi_quarter_before_review_date" : method === "fixed" ? "fixed_lease_percent" : "manual",
          });
        }

        const after = await loadReview(db, reviewId);
        if (!after) throw new Error(`Review ${reviewId} vanished while being calculated`);
        return { after, buildingId, tenantId };
      });
    } catch (error) {
      await recordReviewRefusal(db, error);
      throw error;
    }

    invalidateTenantAndBuilding(done.tenantId, done.buildingId);
    return { jsonBody: { review: toReviewDto(done.after, today) }, status: 200 };
  } catch (error) {
    return rentReviewErrorResponse(error, context, "calculateRentReview");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("calculateRentReview", { authLevel: "anonymous", handler: calculateRentReview, methods: ["POST"] });
