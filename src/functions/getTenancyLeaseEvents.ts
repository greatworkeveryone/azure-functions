// GET /api/getTenancyLeaseEvents?tenantId=7   (PLAN §3.5, §3.6; WP32, WP33)
//
//   200 { events, options, window, optionTerm, defaults, today }
//
// One tenancy's lease events (option exercises and renewals), newest first,
// with what the option exercise stepper needs to explain itself: the options
// left (structured columns, else the parse of OptionPeriods), where today sits
// in the notice window, the term an exercise would add (first day, new expiry)
// and the lease's own review method, fixed % and interval as the defaults for
// the term's reviews. Read-only.
//
// Gate: LEASE_EVENT_VIEW_ROLES (the roles that may read a tenancy; frontend
// capability viewLeaseEvents).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import { optionTermDates } from "../leaseOptions";
import { sqlDateToIso } from "../nextReviewDate";
import { toLeaseEventDto } from "../leaseEvents/dto";
import { LEASE_EVENT_VIEW_ROLES, LeaseEventError, leaseEventErrorResponse, readTenantId } from "../leaseEvents/http";
import { leaseFixedPercent, leaseIntervalMonths, leaseOptionsOf, leaseReviewMethod, optionWindowOf } from "../leaseEvents/options";
import { loadEventsForTenancy, loadTenancyForEvent } from "../leaseEvents/store";

export async function getTenancyLeaseEvents(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, LEASE_EVENT_VIEW_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const tenantId = readTenantId(request.query.get("tenantId"));
    connection = await createRequestConnection(token);
    const tenancy = await loadTenancyForEvent(connection, tenantId);
    if (!tenancy) throw new LeaseEventError("not_found", "That tenancy doesn't exist");
    const today = todayInDarwin();
    const options = leaseOptionsOf(tenancy);
    const window = optionWindowOf(tenancy, today);
    const events = (await loadEventsForTenancy(connection, tenantId)).map(toLeaseEventDto);
    return {
      jsonBody: {
        defaults: {
          fixedPercent: leaseFixedPercent(tenancy),
          intervalMonths: leaseIntervalMonths(tenancy),
          ongoingMethod: leaseReviewMethod(tenancy),
        },
        events,
        optionTerm: optionTermDates(sqlDateToIso(tenancy.Expiry), options.termMonths),
        options,
        today,
        window,
      },
      status: 200,
    };
  } catch (error) {
    return leaseEventErrorResponse(error, context, "getTenancyLeaseEvents");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("getTenancyLeaseEvents", { authLevel: "anonymous", handler: getTenancyLeaseEvents, methods: ["GET"] });
