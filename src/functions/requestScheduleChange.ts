// POST /api/requestScheduleChange   (PLAN WP26c, D24)
//
//   { tenantId, kind: "relief", relief: { from, to, kind, value, scope }, reason, scheduleVersion }
//   201 { change: ScheduleChangeDto, forgone: { total, byCharge } }
//
// Staff ask for rent relief for a defined period; it reaches the schedule only
// when a director ratifies it (ratifyScheduleChange). Until then it is pending:
// stored here, on the schedule and in every read's warning, in no figure.
//
//   relief      from, to (its last day), kind percent | amount | fixed_rent,
//               value (percent: above 0 and at most 100; amount and fixed_rent:
//               dollars a year, the rent's only), scope rent | ahac | carparks |
//               misc_fees, one or more (scheduleCharges.ts validateReliefShape:
//               400 with what is wrong)
//   reason      required (400 reason_required)
//   kind        relief only (400 kind_not_requestable): a manual edit of the
//               schedule is guarded by its sign-off (D7), and a director lifts the
//               lease's ratchet for one review row while approving the review (C9)
//   scheduleVersion  the tenancy's, as the caller read it, else 409 stale_schedule
//   tenancy     404 not_found; archived 422 tenancy_archived; vacated 422
//               tenancy_vacated
//   the schedule (scheduleChange/relief.ts)  409 relief_overlap with a ratified
//               relief or another awaiting a director (same day and charge);
//               422 nothing_to_relieve, relief_too_large, not_a_reduction
//
// One transaction, under an update lock on the tenancy (two overlapping requests
// can't both slip in): the request, pending, and its ledger row,
// schedule.change_requested, with the reason and what the relief would forgo
// over its days. After the commit: the tenancy's cached register entry is
// dropped (the register warns about the pending change) and the ratification
// escalation (schedule.change_ratification) goes to the directors.
//
// Gate: the roles that may edit a tenancy (scheduleChange/http.ts
// CHANGE_REQUEST_ROLES; frontend capability requestScheduleChange). Asking
// changes nothing that is billed, so it is not behind the money gate; the
// director's decision is.

import { randomUUID } from "node:crypto";
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { clip } from "../digest/format";
import { closeConnection, createRequestConnection } from "../db";
import * as ledger from "../ledger";
import { readJsonObject, readReason, RentReviewError, resolveCaller } from "../rentReview/http";
import { inTransaction, totalOccupancySqm } from "../rentReview/store";
import { validateReliefShape } from "../scheduleCharges";
import { reliefOfRow, toChangeDto } from "../scheduleChange/dto";
import { raiseRatification } from "../scheduleChange/escalation";
import {
  CHANGE_REQUEST_ROLES,
  readScheduleVersion,
  readTenantId,
  recordChangeRefusal,
  refuseClosedTenancy,
  ScheduleChangeError,
  scheduleChangeErrorResponse,
  staleSchedule,
} from "../scheduleChange/http";
import { checkRelief, tenancySchedule } from "../scheduleChange/relief";
import { insertChange, loadChange, lockTenancyForChange, pendingReliefsOf } from "../scheduleChange/store";
import { SCHEDULE_CHANGE_SUBJECT } from "../scheduleChange/types";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";

export async function requestScheduleChange(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, CHANGE_REQUEST_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = await readJsonObject(request);
    const tenantId = readTenantId(body.tenantId);
    if (body.kind !== "relief") {
      throw new ScheduleChangeError(
        "kind_not_requestable",
        "Only rent relief can be asked for. A manual edit of the schedule is guarded by its sign-off, and a director overrides a lease's ratchet while approving the review.",
      );
    }
    const shape = validateReliefShape(body.relief);
    if (!shape.ok) throw new RentReviewError("bad_request", shape.error);
    const reason = readReason(body.reason, "Say why the relief is asked for (a reason is required)");
    const scheduleVersion = readScheduleVersion(body.scheduleVersion);

    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    const db = connection;
    const requestId = randomUUID();
    const correlationId = ledger.newCorrelationId();

    let done;
    try {
      done = await inTransaction(db, async () => {
        const tenancy = await lockTenancyForChange(db, tenantId);
        if (!tenancy) throw new ScheduleChangeError("not_found", "That tenancy doesn't exist");
        refuseClosedTenancy(tenancy);
        if (Number(tenancy.ScheduleVersion ?? 0) !== scheduleVersion) throw staleSchedule(tenancy);

        const pending = (await pendingReliefsOf(db, tenantId)).flatMap((row) => {
          const relief = reliefOfRow({ ...row, Kind: "relief" });
          return relief ? [{ relief, requestId: String(row.RequestId) }] : [];
        });
        const schedule = tenancySchedule(tenancy, await totalOccupancySqm(db, tenantId));
        const check = checkRelief({ ...shape.relief, id: requestId }, schedule, pending);
        if (!check.ok) throw new ScheduleChangeError(check.refusal.code, check.refusal.message, check.refusal.details ?? {});

        const buildingId = Number(tenancy.BuildingId);
        await insertChange(db, {
          kind: "relief",
          payload: { ...shape.relief },
          reason,
          requestedBy: { name: caller.actor.name, userId: caller.actor.userId },
          requestId,
          tenantId,
        });
        await ledger.record(db, {
          action: "schedule.change_requested",
          actor: caller.actor,
          after: { kind: "relief", relief: shape.relief, state: "pending" },
          buildingId,
          // What it would forgo over its own days, on the schedule as it stands now.
          computed: { forgone: check.forgone, scheduleVersion },
          correlationId,
          reason,
          ruleApplied: "awaits_director",
          subject: { id: requestId, type: SCHEDULE_CHANGE_SUBJECT },
          tenantId,
        });
        const row = await loadChange(db, requestId);
        if (!row) throw new Error(`Schedule change ${requestId} vanished while being asked for`);
        return { buildingId, forgone: check.forgone, row };
      });
    } catch (error) {
      await recordChangeRefusal(db, error);
      throw error;
    }

    invalidateTenantAndBuilding(tenantId, done.buildingId);
    const change = toChangeDto(done.row);
    await raiseRatification(db, {
      actor: caller.actor,
      headline: clip(`Asked by ${caller.actor.name}: ${reason}`, 200),
      log: (message) => context.warn(message),
      requestId,
    });
    return { jsonBody: { change, forgone: done.forgone }, status: 201 };
  } catch (error) {
    return scheduleChangeErrorResponse(error, context, "requestScheduleChange");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("requestScheduleChange", { authLevel: "anonymous", handler: requestScheduleChange, methods: ["POST"] });
