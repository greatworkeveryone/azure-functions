// GET /api/getScheduleChanges?requestId=&tenantId=&state=
//
// Schedule change requests (PLAN WP26c), newest first. Filters combine with
// AND; give at least one:
//   requestId one request (the director's page, /tenancy/changes/{requestId}):
//             read by its key, so an old link never depends on the list's limit
//   tenantId  one tenancy's requests, every state (the schedule panel's history)
//   state     one state, or several: state=pending,ratified or state=pending&state=ratified
// 200 { asOf, changes: ScheduleChangeDto[], pendingChanges: { count, items }, truncated? }:
// pendingChanges are everything awaiting a decision for the tenancy named (with
// requestId, the request's own tenancy; none when there is no such request),
// else every tenancy (reviews awaiting approval included).
//
// Gate: the roles that may read a tenancy (scheduleChange/http.ts CHANGE_VIEW_ROLES).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import { RentReviewError } from "../rentReview/http";
import { toChangeDto } from "../scheduleChange/dto";
import { CHANGE_VIEW_ROLES, scheduleChangeErrorResponse } from "../scheduleChange/http";
import { loadPendingChanges, pendingChangesOf } from "../scheduleChange/pending";
import { CHANGE_LIST_LIMIT, type ChangeFilters, loadChanges } from "../scheduleChange/store";
import { SCHEDULE_CHANGE_STATES, type ScheduleChangeState } from "../scheduleChange/types";

const INT_MAX = 2_147_483_647;
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

function readFilters(query: URLSearchParams): ChangeFilters {
  const rawRequestId = query.get("requestId");
  let requestId: string | undefined;
  if (rawRequestId !== null && rawRequestId.trim() !== "") {
    requestId = rawRequestId.trim();
    if (!REQUEST_ID_RE.test(requestId)) throw new RentReviewError("bad_request", "requestId must be a schedule change's id");
  }
  const raw = query.get("tenantId");
  let tenantId: number | undefined;
  if (raw !== null && raw.trim() !== "") {
    tenantId = /^\d{1,10}$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
    if (!(tenantId >= 1 && tenantId <= INT_MAX)) throw new RentReviewError("bad_request", "tenantId must be a whole number");
  }
  const requested = query
    .getAll("state")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter((value) => value !== "");
  const unknown = requested.find((value) => !(SCHEDULE_CHANGE_STATES as readonly string[]).includes(value));
  if (unknown !== undefined) throw new RentReviewError("bad_request", `state "${unknown}" isn't one of ${SCHEDULE_CHANGE_STATES.join(", ")}`);
  const states = requested.length > 0 ? ([...new Set(requested)] as ScheduleChangeState[]) : undefined;
  if (requestId === undefined && tenantId === undefined && states === undefined) {
    throw new RentReviewError("bad_request", "Give a requestId, a tenantId or a state to list schedule changes for");
  }
  return { requestId, states, tenantId };
}

export async function getScheduleChanges(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, CHANGE_VIEW_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const filters = readFilters(request.query);
    connection = await createRequestConnection(token);
    const rows = await loadChanges(connection, filters);
    // One request: the warnings of its own tenancy only, never the whole portfolio's.
    const scope = filters.requestId !== undefined ? (rows[0] ? Number(rows[0].TenantId) : null) : (filters.tenantId ?? "all");
    const pending = scope === null ? [] : await loadPendingChanges(connection, scope === "all" ? { all: true } : { tenantId: scope }, "full");
    return {
      jsonBody: {
        asOf: todayInDarwin(),
        changes: rows.map(toChangeDto),
        pendingChanges: pendingChangesOf(pending),
        ...(rows.length >= CHANGE_LIST_LIMIT ? { truncated: true } : {}),
      },
      status: 200,
    };
  } catch (error) {
    return scheduleChangeErrorResponse(error, context, "getScheduleChanges");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getScheduleChanges", { authLevel: "anonymous", handler: getScheduleChanges, methods: ["GET"] });
