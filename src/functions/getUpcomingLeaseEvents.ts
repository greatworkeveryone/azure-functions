// GET /api/getUpcomingLeaseEvents?days=90&buildingId=
//
// What happens to leases in the next `days` days (default 90, at most 365), for
// the dashboard's lease alerts and the Next 90 days list (PLAN WP25, F18c):
//
//   200 { asOf, days, events: LeaseEvent[] }
//   LeaseEvent  { kind: "review" | "expiry" | "option_deadline",
//                 tenantId, buildingId, tenantName, date, overdue,
//                 review rows also: state, reviewId, method, ownerUserId, ownerName }
//
//   review           every open review dated inside the window or already past
//   expiry           every active tenancy's expiry, not only those with a review due
//   option_deadline  the last day to give notice of an option (leaseOptions.ts)
//
// Overdue rows come first, then by date. Rows carry names and dates and nothing
// else: no rent, ABN, contacts or notes. That is the fix for the leak
// LAUNCH-READINESS §4.4 notes in getReviewsDue, which sends whole tenancies to
// anyone signed in. See rentReview/leaseEvents.ts for the rules.
//
// Gate: the roles that may read a tenancy (rentReview/http.ts); the frontend
// shows lease alerts to the same roles.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { addDaysIso, todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection, executeQuery, type SqlParam } from "../db";
import { sqlDateToIso } from "../nextReviewDate";
import { OPEN_RENT_REVIEW_STATES, type RentReviewMethod, type RentReviewState } from "../rentReviewMachine";
import { tenantDisplayName } from "../rentReview/dto";
import { RentReviewError, rentReviewErrorResponse, TENANCY_VIEW_ROLES } from "../rentReview/http";
import {
  buildLeaseEvents,
  DEFAULT_LEASE_EVENT_DAYS,
  MAX_LEASE_EVENT_DAYS,
  type LeaseEventReview,
  type LeaseEventTenancy,
} from "../rentReview/leaseEvents";

const INT_MAX = 2_147_483_647;
const METHODS: readonly string[] = ["cpi", "fixed", "market", "other"];
const OPEN_STATE_LIST = OPEN_RENT_REVIEW_STATES.map((state) => `'${state}'`).join(", ");

// Names and dates only: this list is the whole of what the feed reads about a tenancy.
const TENANCIES_SQL = `SELECT t.TenantId, t.BuildingId, t.LegalName, t.TradingName, t.Expiry,
    t.OptionPeriods, t.OptionNoticeMonths
  FROM dbo.Tenants t
  WHERE t.Status <> 'vacated' AND t.Expiry IS NOT NULL`;

const REVIEWS_SQL = `SELECT r.ReviewId, r.TenantId, r.ScheduledFor, r.State, r.Method, r.OwnerUserId,
    t.BuildingId, t.LegalName, t.TradingName, u.DisplayName AS OwnerName
  FROM dbo.RentReviews r
  INNER JOIN dbo.Tenants t ON t.TenantId = r.TenantId
  LEFT JOIN dbo.AppUsers u ON u.UserID = r.OwnerUserId
  WHERE r.State IN (${OPEN_STATE_LIST}) AND r.ScheduledFor <= @Until AND t.Status <> 'vacated'`;

const BUILDING_FILTER = " AND t.BuildingId = @BuildingId";

function readDays(query: URLSearchParams): number {
  const raw = query.get("days");
  if (raw === null || raw.trim() === "") return DEFAULT_LEASE_EVENT_DAYS;
  const days = /^\d{1,4}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!(days >= 1 && days <= MAX_LEASE_EVENT_DAYS)) {
    throw new RentReviewError("bad_request", `days must be a whole number from 1 to ${MAX_LEASE_EVENT_DAYS}`);
  }
  return days;
}

function readBuildingId(query: URLSearchParams): number | null {
  const raw = query.get("buildingId");
  if (raw === null || raw.trim() === "") return null;
  const id = /^\d{1,10}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!(id >= 1 && id <= INT_MAX)) throw new RentReviewError("bad_request", "buildingId must be a whole number");
  return id;
}

export async function getUpcomingLeaseEvents(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, TENANCY_VIEW_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const days = readDays(request.query);
    const buildingId = readBuildingId(request.query);
    const today = todayInDarwin();

    const tenancyParams: SqlParam[] = [];
    const reviewParams: SqlParam[] = [{ name: "Until", type: TYPES.Date, value: addDaysIso(today, days) }];
    if (buildingId !== null) {
      tenancyParams.push({ name: "BuildingId", type: TYPES.Int, value: buildingId });
      reviewParams.push({ name: "BuildingId", type: TYPES.Int, value: buildingId });
    }

    connection = await createRequestConnection(token);
    const tenancyRows = await executeQuery(
      connection,
      buildingId === null ? TENANCIES_SQL : `${TENANCIES_SQL}${BUILDING_FILTER}`,
      tenancyParams,
    );
    const reviewRows = await executeQuery(
      connection,
      buildingId === null ? REVIEWS_SQL : `${REVIEWS_SQL}${BUILDING_FILTER}`,
      reviewParams,
    );

    const tenancies: LeaseEventTenancy[] = tenancyRows.map((row) => ({
      buildingId: Number(row.BuildingId),
      expiry: sqlDateToIso(row.Expiry),
      optionNoticeMonths: row.OptionNoticeMonths === null || row.OptionNoticeMonths === undefined ? null : Number(row.OptionNoticeMonths),
      optionPeriods: typeof row.OptionPeriods === "string" ? row.OptionPeriods : null,
      tenantId: Number(row.TenantId),
      tenantName: tenantDisplayName(row),
    }));
    const reviews: LeaseEventReview[] = reviewRows.map((row) => ({
      buildingId: Number(row.BuildingId),
      method: METHODS.includes(String(row.Method)) ? (row.Method as RentReviewMethod) : null,
      ownerName: typeof row.OwnerName === "string" ? row.OwnerName : null,
      ownerUserId: row.OwnerUserId === null || row.OwnerUserId === undefined ? null : Number(row.OwnerUserId),
      reviewId: String(row.ReviewId),
      scheduledFor: sqlDateToIso(row.ScheduledFor) ?? "",
      state: row.State as RentReviewState,
      tenantId: Number(row.TenantId),
      tenantName: tenantDisplayName(row),
    }));

    return { jsonBody: { asOf: today, days, events: buildLeaseEvents({ days, reviews, tenancies, today }) }, status: 200 };
  } catch (error) {
    return rentReviewErrorResponse(error, context, "getUpcomingLeaseEvents");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getUpcomingLeaseEvents", { authLevel: "anonymous", handler: getUpcomingLeaseEvents, methods: ["GET"] });
