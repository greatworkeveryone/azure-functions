// GET /api/getRentReview?reviewId=
//
// One review for the review workspace (route /tenancy/reviews/[reviewId]):
//
//   200 {
//     asOf,                 the Darwin date `overdue` was worked out for
//     review,               RentReviewDto, including rowVersion for the writes
//     tenancy,              TenancySummaryDto: names, the lease terms, today's rent
//     step,                 the schedule step the review is linked to (set when it is
//                           commenced), or null
//     cpiSuggestion,        CPI reviews only, else null:
//                             { region, rule, referenceQuarter, previousQuarter,
//                               values: { current, previous, referenceBase } | null,
//                               expectedRelease: ISO date | null }
//                           `values` is the two index values for the reference quarter
//                           (PLAN Q5: the quarter ending immediately before the review
//                           date) from CpiIndex on one base; null until both are
//                           published, and then expectedRelease says when ABS is expected
//                           to publish the reference quarter (quarter end + 30 days)
//   }
//   404 no such review (rows written before the workflow aren't reviews)
//
// The review's decision history is getDecisionHistory?subjectType=rent_review&subjectId=.
// Gate: the roles that may read a tenancy (rentReview/http.ts).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import { parseSteps } from "../scheduledRateStepLogic";
import { parseBasis } from "../rentReview/basis";
import { buildCpiSuggestion, previousQuarter, referenceQuarter } from "../rentReview/cpi";
import { toReviewDto, toTenancySummary } from "../rentReview/dto";
import { readReviewId, RentReviewError, rentReviewErrorResponse, TENANCY_VIEW_ROLES } from "../rentReview/http";
import { loadCpiRows, loadReview, loadTenancyForReview, totalOccupancySqm } from "../rentReview/store";

const REGIONS: readonly string[] = ["AUS", "DARWIN"];

export async function getRentReview(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, TENANCY_VIEW_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const reviewId = readReviewId(request.query.get("reviewId"));
    connection = await createRequestConnection(token);
    const row = await loadReview(connection, reviewId);
    if (!row) throw new RentReviewError("not_found", "That review doesn't exist");

    const today = todayInDarwin();
    const review = toReviewDto(row, today);
    const tenancyRow = await loadTenancyForReview(connection, review.tenantId);
    if (!tenancyRow) throw new RentReviewError("not_found", "That review's tenancy doesn't exist");
    const tenancy = toTenancySummary(tenancyRow, await totalOccupancySqm(connection, review.tenantId), today);

    const steps = parseSteps(tenancyRow.ScheduledRateSteps as string | null | undefined);
    const step = review.stepId === null ? null : (steps.find((candidate) => candidate.id === review.stepId) ?? null);

    // Once commenced the basis is what the review is decided on; before that, the lease.
    const basis = parseBasis(row.Basis);
    const regionText = String(basis?.region ?? tenancy.cpiRegion ?? "").toUpperCase();
    const interval = typeof basis?.intervalMonths === "number" ? basis.intervalMonths : tenancy.reviewIntervalMonths;
    let cpiSuggestion = null;
    if (review.method === "cpi" && REGIONS.includes(regionText)) {
      const reference = referenceQuarter(review.scheduledFor);
      const rows = await loadCpiRows(connection, regionText, [reference, previousQuarter(reference, interval)]);
      cpiSuggestion = buildCpiSuggestion({ intervalMonths: interval, region: regionText, reviewDate: review.scheduledFor, rows });
    }

    return { jsonBody: { asOf: today, cpiSuggestion, review, step, tenancy }, status: 200 };
  } catch (error) {
    return rentReviewErrorResponse(error, context, "getRentReview");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getRentReview", { authLevel: "anonymous", handler: getRentReview, methods: ["GET"] });
