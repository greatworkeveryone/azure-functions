// GET /api/getRentReviews?tenantId=&buildingId=&state=
//
// Review instances (PLAN WP25), newest review date first. Filters combine with
// AND; give at least one:
//   tenantId    one tenancy's reviews, history included, archived tenancy or not
//   buildingId  every review in a building
//   state       one state, or several: state=due,in_progress or state=due&state=in_progress
// A list by building or state leaves out the reviews of archived tenancies (D4);
// name the tenancy with tenantId and its reviews come back, so its page can show
// the history. getRentReview returns any review.
// 200 { asOf, reviews: RentReviewDto[], pendingChanges: { count, items }, truncated? }:
// pendingChanges (WP26c) are the changes awaiting a decision for the tenancy
// named, else the building, else every tenancy. `asOf` is the Darwin date
// `overdue` was worked out for. Rows written before the workflow (no State) are
// not reviews and are not listed; the tenancy's own reviews list still has them.
//
// Gate: the roles that may read a tenancy (rentReview/http.ts).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import { RENT_REVIEW_STATES, type RentReviewState } from "../rentReviewMachine";
import { toReviewDto } from "../rentReview/dto";
import { RentReviewError, rentReviewErrorResponse, TENANCY_VIEW_ROLES } from "../rentReview/http";
import { loadReviews, REVIEW_LIST_LIMIT, type ReviewFilters } from "../rentReview/store";
import { loadPendingChanges, pendingChangesOf } from "../scheduleChange/pending";
import { showTestParam } from "../test-data";

const INT_MAX = 2_147_483_647;

function readId(query: URLSearchParams, name: string): number | undefined {
  const raw = query.get(name);
  if (raw === null || raw.trim() === "") return undefined;
  const id = /^\d{1,10}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!(id >= 1 && id <= INT_MAX)) throw new RentReviewError("bad_request", `${name} must be a whole number`);
  return id;
}

function readStates(query: URLSearchParams): RentReviewState[] | undefined {
  const requested = query
    .getAll("state")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  if (requested.length === 0) return undefined;
  const unknown = requested.find((value) => !(RENT_REVIEW_STATES as readonly string[]).includes(value));
  if (unknown !== undefined) {
    throw new RentReviewError("bad_request", `state "${unknown}" isn't one of ${RENT_REVIEW_STATES.join(", ")}`);
  }
  return [...new Set(requested)] as RentReviewState[];
}

export async function getRentReviews(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, TENANCY_VIEW_ROLES);
  if (roleCheck) return roleCheck;

  let filters: ReviewFilters;
  try {
    filters = {
      buildingId: readId(request.query, "buildingId"),
      showTest: (await showTestParam(request)).value,
      states: readStates(request.query),
      tenantId: readId(request.query, "tenantId"),
    };
    if (filters.buildingId === undefined && filters.tenantId === undefined && filters.states === undefined) {
      throw new RentReviewError("bad_request", "Give a tenantId, a buildingId or a state to list reviews for");
    }
  } catch (error) {
    return rentReviewErrorResponse(error, context, "getRentReviews");
  }

  let connection;
  try {
    connection = await createRequestConnection(token);
    const rows = await loadReviews(connection, filters);
    const today = todayInDarwin();
    const scope = filters.tenantId !== undefined ? { tenantId: filters.tenantId } : filters.buildingId !== undefined ? { buildingId: filters.buildingId } : { all: true as const };
    const pending = await loadPendingChanges(connection, scope, "full");
    return {
      jsonBody: {
        asOf: today,
        pendingChanges: pendingChangesOf(pending),
        reviews: rows.map((row) => toReviewDto(row, today)),
        ...(rows.length >= REVIEW_LIST_LIMIT ? { truncated: true } : {}),
      },
      status: 200,
    };
  } catch (error) {
    return rentReviewErrorResponse(error, context, "getRentReviews");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getRentReviews", { authLevel: "anonymous", handler: getRentReviews, methods: ["GET"] });
