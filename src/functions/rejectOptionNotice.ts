// POST /api/rejectOptionNotice   (PLAN §3.5 REJECT; WP32)
//
//   { leaseEventId, rowVersion, reason }
//   200 { event }
//
// A director rejects a recorded option notice (one that went for approval, or
// one dated outside the window), with a reason. Nothing on the lease changes;
// the event closes as rejected, ledgered as lease_event.option_rejected (an
// exception). A fresh notice can still be recorded while the window is open,
// and once the deadline passes the expiry goes to the directors as a renewal.
//
//   rowVersion  the one the caller read, else 409 { code: "stale", current }
//   state       notice_received or awaiting_approval, else 409 invalid_state
//   reason      required (400 reason_required)
//   role        director; admin only on a test tenancy (decision 4); anyone
//               else 403 forbidden, ledgered as denied
// After the commit the event's escalations end as "rejected".
//
// Gate: LEASE_DIRECTOR_ROLES (frontend capability rejectOptionNotice).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import * as ledger from "../ledger";
import { type LeaseEventState, nextLeaseEventState } from "../leaseEventMachine";
import { holdsAdmin } from "../moneyRules";
import { resolveCaller } from "../rentReview/http";
import { inTransaction } from "../rentReview/store";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { toLeaseEventDto } from "../leaseEvents/dto";
import { concludeLeaseEscalations } from "../leaseEvents/escalations";
import {
  adminOnTestOnly,
  deniedAttempt,
  isDirector,
  LEASE_DIRECTOR_ROLES,
  LeaseEventError,
  leaseEventErrorResponse,
  readBody,
  readEventId,
  readReason,
  readRowVersion,
  recordLeaseEventRefusal,
} from "../leaseEvents/http";
import { eventForUpdate, loadEvent, lockTenancyForEvent, markDecided } from "../leaseEvents/store";

export async function rejectOptionNotice(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, LEASE_DIRECTOR_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = await readBody(request);
    const leaseEventId = readEventId(body.leaseEventId);
    const rowVersion = readRowVersion(body.rowVersion);
    const reason = readReason(body.reason, "Say why the notice is rejected (a reason is required)");

    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    const db = connection;
    const correlationId = ledger.newCorrelationId();

    let done;
    try {
      done = await inTransaction(db, async () => {
        const event = await eventForUpdate(db, leaseEventId);
        if (!event || event.Type !== "option_exercise") throw new LeaseEventError("not_found", "That option exercise doesn't exist");
        if (rowVersionHex(event.Version) !== rowVersion) {
          throw new LeaseEventError("stale", "Someone else changed this option since you opened it. Reload to see their change.", { current: toLeaseEventDto(event) });
        }
        const state = String(event.State) as LeaseEventState;
        const tenantId = Number(event.TenantId);
        const buildingId = event.BuildingId === null || event.BuildingId === undefined ? null : Number(event.BuildingId);
        const ref = { buildingId, leaseEventId, state, tenantId };
        if (nextLeaseEventState("option_exercise", state, "REJECT") === null) {
          throw new LeaseEventError("invalid_state", `This option is ${state.replace(/_/g, " ")}, so there is no notice to reject.`, { state });
        }
        const tenancy = await lockTenancyForEvent(db, tenantId);
        const isTest = tenancy?.IsTest === true || tenancy?.IsTest === 1;
        const adminRefused = adminOnTestOnly(caller, isTest, ref, "lease_event.option_rejected");
        if (adminRefused) throw adminRefused;
        if (!isDirector(caller.roles) && !holdsAdmin(caller.roles)) {
          const message = "Only a director can reject an option notice";
          throw new LeaseEventError("forbidden", message, {}, deniedAttempt(caller, ref, "lease_event.option_rejected", "role_not_permitted", message));
        }
        const moved = await markDecided(db, leaseEventId, [state], "rejected", {
          decider: { name: caller.actor.name, userId: caller.actor.userId },
          details: { noticeDate: event.NoticeDate ?? null },
          outcome: "rejected",
          reason,
        });
        if (!moved) throw new LeaseEventError("invalid_state", "This option just moved on, so the notice wasn't rejected.", { state });
        await ledger.record(db, {
          action: "lease_event.option_rejected",
          actor: caller.actor,
          after: { state: "rejected" },
          before: { state },
          buildingId,
          correlationId,
          reason,
          ruleApplied: "director_rejected_notice",
          subject: { id: leaseEventId, type: "lease_event" },
          tenantId,
        });
        const after = await loadEvent(db, leaseEventId);
        if (!after) throw new Error(`Lease event ${leaseEventId} vanished while it was rejected`);
        return { after, buildingId, tenantId };
      });
    } catch (error) {
      await recordLeaseEventRefusal(db, error);
      throw error;
    }

    if (done.buildingId !== null) invalidateTenantAndBuilding(done.tenantId, done.buildingId);
    await concludeLeaseEscalations(db, { actor: caller.actor, code: "rejected", leaseEventId, log: (message) => context.warn(message), note: reason });
    return { jsonBody: { event: toLeaseEventDto(done.after) }, status: 200 };
  } catch (error) {
    return leaseEventErrorResponse(error, context, "rejectOptionNotice");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("rejectOptionNotice", { authLevel: "anonymous", handler: rejectOptionNotice, methods: ["POST"] });
