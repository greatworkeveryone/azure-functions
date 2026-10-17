// POST /api/ratifyScheduleChange   (PLAN WP26c, D23, D24)
//
//   { requestId, rowVersion, note? }
//   200 { change: ScheduleChangeDto, forgone: { total, byCharge }, scheduleVersion }
//
// A director confers a pending change on the tenancy's schedule. In one
// transaction:
//   1. the tenancy is locked (UPDLOCK), then the request (the same order every
//      schedule change takes); rowVersion is the one the caller read, else
//      409 stale with the request as it is now; it is still pending, else
//      409 invalid_state
//   2. the relief is checked against the schedule as it stands now
//      (scheduleChange/relief.ts): it may have moved since it was asked for
//      (409 relief_overlap; 422 nothing_to_relieve, relief_too_large,
//      not_a_reduction)
//   3. the overlay is written onto the schedule (Tenants.RentReliefs, an overlay,
//      never a row), ScheduleVersion + 1 (a review calculated before it is stale,
//      C4), sign-off kept (D7: a ratified change is a decision on the verified
//      schedule, not a manual edit of it; as WP26's APPLY keeps it)
//   4. the request -> ratified, with who and when and the director's note
//   5. schedule.change_ratified in the ledger: an exception, the reason (the
//      director's note, else why it was asked for), before and after, and
//      financialImpact = the charge forgone over the relief's own days (positive
//      = money forgone), how it was worked out in `computed`
// A failure anywhere rolls all of it back. After the commit: the tenancy's
// cached register entry is dropped and the ratification escalation ends as
// "ratified".
//
//   role     a director. requireRole lets admin through, but admin never decides
//            (D20): 403 forbidden, ledgered as denied, for anyone else. A
//            director ratifying their own request is allowed (D23: directors are
//            never blocked by separation of duties); its rule says so
//   409 try_again when SQL Server chose this as a deadlock's victim; nothing was written
//
// Gates: CHANGE_DECIDE_ROLES (scheduleChange/http.ts; frontend
// ratifyScheduleChange), then the money-action gate (S11): ratifying changes what
// the tenant is billed.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, oidFromToken, requireRole, unauthorizedResponse } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import * as ledger from "../ledger";
import { requireMoneyContext } from "../moneyGate";
import { readJsonObject, readRowVersion, resolveCaller } from "../rentReview/http";
import { inTransaction, totalOccupancySqm } from "../rentReview/store";
import { reliefOfRow, toChangeDto } from "../scheduleChange/dto";
import { settleRatification } from "../scheduleChange/escalation";
import {
  CHANGE_DECIDE_ROLES,
  deniedChange,
  isDirector,
  readNote,
  readRequestId,
  recordChangeRefusal,
  refuseClosedTenancy,
  ScheduleChangeError,
  scheduleChangeErrorResponse,
  staleChange,
} from "../scheduleChange/http";
import { checkRelief, tenancySchedule } from "../scheduleChange/relief";
import { changeForUpdate, loadChange, lockTenancyForChange, markDecided, writeReliefs } from "../scheduleChange/store";
import { CHANGE_DECISION_CODES, SCHEDULE_CHANGE_SUBJECT } from "../scheduleChange/types";
import type { RentRelief } from "../scheduleCharges";
import { scheduleSignOffFromRow } from "../scheduleSignOff";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";

export async function ratifyScheduleChange(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
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
    const note = readNote(body.note);

    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    const db = connection;
    const correlationId = ledger.newCorrelationId();

    let done;
    try {
      done = await inTransaction(db, async () => {
        const seen = await loadChange(db, requestId);
        if (!seen) throw new ScheduleChangeError("not_found", "That schedule change doesn't exist");
        if (!isDirector(caller.roles)) {
          const message = "Only a director can ratify a schedule change";
          throw new ScheduleChangeError("forbidden", message, {}, deniedChange(caller, seen, "schedule.change_ratified", "not_director", message));
        }
        const tenantId = Number(seen.TenantId);
        const tenancy = await lockTenancyForChange(db, tenantId);
        if (!tenancy) throw new ScheduleChangeError("not_found", "That schedule change's tenancy doesn't exist");
        const row = await changeForUpdate(db, requestId);
        if (!row) throw new ScheduleChangeError("not_found", "That schedule change doesn't exist");
        if (rowVersionHex(row.Version) !== rowVersion) throw staleChange(row);
        if (row.State !== "pending") {
          throw new ScheduleChangeError("invalid_state", `This change has been ${String(row.State)}, so it can't be ratified`, { state: row.State });
        }
        refuseClosedTenancy(tenancy);
        const relief = reliefOfRow(row);
        if (!relief) throw new ScheduleChangeError("unreadable_change", "This change's details can't be read, so it can't be ratified. Reject it and ask again.");

        const schedule = tenancySchedule(tenancy, await totalOccupancySqm(db, tenantId));
        const check = checkRelief({ ...relief, id: requestId }, schedule, []);
        if (!check.ok) {
          throw new ScheduleChangeError(check.refusal.code, `The schedule has changed since this was asked for. ${check.refusal.message}`, check.refusal.details ?? {});
        }

        const ratifiedAt = new Date().toISOString();
        const overlay: RentRelief = { ...relief, id: requestId, ratifiedAt, ratifiedByName: caller.actor.name, reason: String(row.Reason) };
        const priorVersion = Number(tenancy.ScheduleVersion ?? 0);
        const scheduleVersion = await writeReliefs(db, {
          actorName: caller.actor.name,
          actorOid: oidFromToken(token) ?? "unknown",
          reliefsJson: JSON.stringify([...schedule.ratified, overlay]),
          tenantId,
        });
        const by = { name: caller.actor.name, userId: caller.actor.userId };
        if (!(await markDecided(db, requestId, { by, note, state: "ratified" }))) {
          throw new ScheduleChangeError("invalid_state", "This change just moved on, so it wasn't ratified");
        }
        const buildingId = Number(tenancy.BuildingId);
        const signOff = scheduleSignOffFromRow(tenancy);
        const ownRequest = row.RequestedById !== null && row.RequestedById !== undefined && Number(row.RequestedById) === caller.actor.userId;
        await ledger.record(db, {
          action: "schedule.change_ratified",
          actor: caller.actor,
          after: {
            relief: overlay,
            scheduleVersion,
            signOff: signOff ? { at: signOff.at, by: signOff.by, kept: true } : { signedOff: false },
            state: "ratified",
          },
          before: { rentReliefs: schedule.ratified.map((other) => other.id), scheduleVersion: priorVersion, state: "pending" },
          buildingId,
          computed: {
            forgone: check.forgone,
            requestedBy: row.RequestedByName ?? null,
            workedOn: "the schedule as it stood when ratified: a review applied later inside the relief changes the charge, not this figure",
          },
          correlationId,
          financialImpact: check.forgone.total,
          reason: note ?? String(row.Reason),
          ruleApplied: ownRequest ? "director_own_request" : "director_ratified",
          subject: { id: requestId, type: SCHEDULE_CHANGE_SUBJECT },
          tenantId,
        });
        const after = await loadChange(db, requestId);
        if (!after) throw new Error(`Schedule change ${requestId} vanished while being ratified`);
        return { after, buildingId, forgone: check.forgone, scheduleVersion, tenantId };
      });
    } catch (error) {
      await recordChangeRefusal(db, error);
      throw error;
    }

    invalidateTenantAndBuilding(done.tenantId, done.buildingId);
    await settleRatification(db, {
      actor: caller.actor,
      code: CHANGE_DECISION_CODES.ratified,
      log: (message) => context.warn(message),
      note,
      requestId,
    });
    return { jsonBody: { change: toChangeDto(done.after), forgone: done.forgone, scheduleVersion: done.scheduleVersion }, status: 200 };
  } catch (error) {
    return scheduleChangeErrorResponse(error, context, "ratifyScheduleChange");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("ratifyScheduleChange", { authLevel: "anonymous", handler: ratifyScheduleChange, methods: ["POST"] });
