// POST /api/withdrawScheduleChange   (PLAN WP26c, D24)
//
//   { requestId, rowVersion, reason }
//   200 { change: ScheduleChangeDto }
//
// The person who asked for a change takes it back while it waits for a
// director; the schedule is untouched. In one transaction, under an update lock
// on the request: only the requester (403 forbidden, ledgered as denied; a
// director turns someone else's down with rejectScheduleChange), rowVersion as
// read (409 stale), still pending (409 invalid_state), a reason (400
// reason_required); the request -> withdrawn, and schedule.change_withdrawn in
// the ledger with the reason. After the commit: the tenancy's cached register
// entry is dropped and the ratification escalation is withdrawn (or resolved as
// "withdrawn" if a director had picked it up).
//
// Gate: the roles that may ask for a change (scheduleChange/http.ts
// CHANGE_REQUEST_ROLES; frontend withdrawScheduleChange). Nothing billed changes.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import * as ledger from "../ledger";
import { readJsonObject, readReason, readRowVersion, resolveCaller } from "../rentReview/http";
import { inTransaction } from "../rentReview/store";
import { reliefOfRow, toChangeDto } from "../scheduleChange/dto";
import { settleRatification } from "../scheduleChange/escalation";
import {
  CHANGE_REQUEST_ROLES,
  deniedChange,
  readRequestId,
  recordChangeRefusal,
  ScheduleChangeError,
  scheduleChangeErrorResponse,
  staleChange,
  stateWords,
} from "../scheduleChange/http";
import { changeForUpdate, loadChange, markDecided } from "../scheduleChange/store";
import { CHANGE_DECISION_CODES, SCHEDULE_CHANGE_SUBJECT } from "../scheduleChange/types";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";

export async function withdrawScheduleChange(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, CHANGE_REQUEST_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = await readJsonObject(request);
    const requestId = readRequestId(body.requestId);
    const rowVersion = readRowVersion(body.rowVersion);
    const reason = readReason(body.reason, "Say why you are withdrawing it (a reason is required)");

    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    const db = connection;

    let done;
    try {
      done = await inTransaction(db, async () => {
        const row = await changeForUpdate(db, requestId);
        if (!row) throw new ScheduleChangeError("not_found", "That schedule change doesn't exist");
        const userId = caller.actor.userId;
        if (userId === null) {
          throw new ScheduleChangeError("no_user", "Your Floorplan user couldn't be found, so we can't tell whether you asked for this change");
        }
        const requester = row.RequestedById === null || row.RequestedById === undefined ? null : Number(row.RequestedById);
        if (requester !== userId) {
          const message = "Only the person who asked for this change can withdraw it; a director can reject it";
          throw new ScheduleChangeError("forbidden", message, {}, deniedChange(caller, row, "schedule.change_withdrawn", "not_requester", message));
        }
        if (rowVersionHex(row.Version) !== rowVersion) throw staleChange(row);
        if (row.State !== "pending") {
          throw new ScheduleChangeError("invalid_state", `This change has been ${stateWords(row.State)}, so it can't be withdrawn`, { state: row.State });
        }
        if (!(await markDecided(db, requestId, { by: { name: caller.actor.name, userId }, note: reason, state: "withdrawn" }))) {
          throw new ScheduleChangeError("invalid_state", "This change just moved on, so it wasn't withdrawn");
        }
        await ledger.record(db, {
          action: "schedule.change_withdrawn",
          actor: caller.actor,
          after: { relief: reliefOfRow(row), state: "withdrawn" },
          before: { state: "pending" },
          buildingId: Number(row.BuildingId),
          reason,
          ruleApplied: "requester_withdrew",
          subject: { id: requestId, type: SCHEDULE_CHANGE_SUBJECT },
          tenantId: Number(row.TenantId),
        });
        const after = await loadChange(db, requestId);
        if (!after) throw new Error(`Schedule change ${requestId} vanished while being withdrawn`);
        return after;
      });
    } catch (error) {
      await recordChangeRefusal(db, error);
      throw error;
    }

    invalidateTenantAndBuilding(Number(done.TenantId), Number(done.BuildingId));
    await settleRatification(db, {
      actor: caller.actor,
      code: CHANGE_DECISION_CODES.withdrawn,
      log: (message) => context.warn(message),
      note: reason,
      requestId,
      withdrawn: true,
    });
    return { jsonBody: { change: toChangeDto(done) }, status: 200 };
  } catch (error) {
    return scheduleChangeErrorResponse(error, context, "withdrawScheduleChange");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("withdrawScheduleChange", { authLevel: "anonymous", handler: withdrawScheduleChange, methods: ["POST"] });
