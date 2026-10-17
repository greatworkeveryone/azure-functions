// POST /api/rejectScheduleChange   (PLAN WP26c, D24)
//
//   { requestId, rowVersion, note }
//   200 { change: ScheduleChangeDto }
//
// A director turns a pending change down; the schedule is untouched. In one
// transaction, under an update lock on the request: rowVersion is the one the
// caller read (409 stale, with the request as it is now), it is still pending
// (409 invalid_state), the note is required (400 reason_required); the request
// -> rejected with who and when and the note, and schedule.change_rejected in
// the ledger with the note as its reason. After the commit: the tenancy's cached
// register entry is dropped (its warning goes) and the ratification escalation
// ends as "rejected".
//
//   role   a director; admin never decides (D20): 403 forbidden, ledgered as denied
//
// Gates: CHANGE_DECIDE_ROLES (scheduleChange/http.ts; frontend
// rejectScheduleChange), then the money-action gate (S11, WP26c: only a director
// can ratify or reject, at the step-up).

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import * as ledger from "../ledger";
import { requireMoneyContext } from "../moneyGate";
import { readJsonObject, readReason, readRowVersion, resolveCaller } from "../rentReview/http";
import { inTransaction } from "../rentReview/store";
import { reliefOfRow, toChangeDto } from "../scheduleChange/dto";
import { settleRatification } from "../scheduleChange/escalation";
import {
  CHANGE_DECIDE_ROLES,
  deniedChange,
  isDirector,
  readRequestId,
  recordChangeRefusal,
  ScheduleChangeError,
  scheduleChangeErrorResponse,
  staleChange,
} from "../scheduleChange/http";
import { changeForUpdate, loadChange, markDecided } from "../scheduleChange/store";
import { CHANGE_DECISION_CODES, SCHEDULE_CHANGE_SUBJECT } from "../scheduleChange/types";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";

export async function rejectScheduleChange(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, CHANGE_DECIDE_ROLES);
  if (roleCheck) return roleCheck;
  const gate = await requireMoneyContext(request);
  if (gate) return gate;

  let connection;
  try {
    const body = await readJsonObject(request);
    const requestId = readRequestId(body.requestId);
    const rowVersion = readRowVersion(body.rowVersion);
    const note = readReason(body.note, "Say why the change is turned down (a note is required)");

    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    const db = connection;

    let done;
    try {
      done = await inTransaction(db, async () => {
        const row = await changeForUpdate(db, requestId);
        if (!row) throw new ScheduleChangeError("not_found", "That schedule change doesn't exist");
        if (!isDirector(caller.roles)) {
          const message = "Only a director can reject a schedule change";
          throw new ScheduleChangeError("forbidden", message, {}, deniedChange(caller, row, "schedule.change_rejected", "not_director", message));
        }
        if (rowVersionHex(row.Version) !== rowVersion) throw staleChange(row);
        if (row.State !== "pending") {
          throw new ScheduleChangeError("invalid_state", `This change has been ${String(row.State)}, so it can't be rejected`, { state: row.State });
        }
        if (!(await markDecided(db, requestId, { by: { name: caller.actor.name, userId: caller.actor.userId }, note, state: "rejected" }))) {
          throw new ScheduleChangeError("invalid_state", "This change just moved on, so it wasn't rejected");
        }
        const ownRequest = row.RequestedById !== null && row.RequestedById !== undefined && Number(row.RequestedById) === caller.actor.userId;
        await ledger.record(db, {
          action: "schedule.change_rejected",
          actor: caller.actor,
          after: { relief: reliefOfRow(row), state: "rejected" },
          before: { requestedBy: row.RequestedByName ?? null, state: "pending" },
          buildingId: Number(row.BuildingId),
          reason: note,
          ruleApplied: ownRequest ? "director_own_request" : "director_rejected",
          subject: { id: requestId, type: SCHEDULE_CHANGE_SUBJECT },
          tenantId: Number(row.TenantId),
        });
        const after = await loadChange(db, requestId);
        if (!after) throw new Error(`Schedule change ${requestId} vanished while being rejected`);
        return after;
      });
    } catch (error) {
      await recordChangeRefusal(db, error);
      throw error;
    }

    invalidateTenantAndBuilding(Number(done.TenantId), Number(done.BuildingId));
    await settleRatification(db, { actor: caller.actor, code: CHANGE_DECISION_CODES.rejected, log: (message) => context.warn(message), note, requestId });
    return { jsonBody: { change: toChangeDto(done) }, status: 200 };
  } catch (error) {
    return scheduleChangeErrorResponse(error, context, "rejectScheduleChange");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("rejectScheduleChange", { authLevel: "anonymous", handler: rejectScheduleChange, methods: ["POST"] });
