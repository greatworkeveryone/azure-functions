// POST /api/approveOptionExercise   (PLAN §3.5 APPROVE + APPLY; WP32)
//
//   { leaseEventId, rowVersion, overrideReason? }
//   200 { event, outcome: { newExpiry, optionsRemaining, marketReview } }
//
// Approves a recorded option notice and applies it in one transaction
// (leaseEvents/apply.ts): expiry extended by the option term, options remaining
// down by one, the term's schedule rows written through the schedule engine, a
// market review spawned when the option starts at market, the decision ledgered.
//
//   rowVersion  the one the caller read, else 409 { code: "stale", current }
//   state       awaiting_approval, or notice_received (a notice dated outside the
//               window) for a director overriding C10 with overrideReason
//               (422 late_notice otherwise; directorCanOverride for a director)
//   role        accounts_manager, cfo or director; admin only on a test tenancy
//               (decision 4, 403 admin_test_records_only); the rest 403 forbidden
//   SoD         the approver isn't the notice's recorder (403 sod_blocked,
//               ledgered); directors are exempt (D23)
//   C3          the schedule is signed off, or a director overrides it with
//               overrideReason (422 not_signed_off)
//   409 expiry_changed when the lease's expiry moved since the notice was
//   recorded; 422 schedule_conflict when the schedule already runs past the
//   expiry; 422 no_options when nothing is left to exercise.
// A director's override writes lease_event.director_override (the reason, the
// check and its facts), an exception. After the commit: the tenancy caches go,
// the event's escalations end as "exercised", and a renewal referral the
// exercise superseded ends as "superseded".
//
// Gates: OPTION_APPROVE_ROLES (frontend approveOptionExercise), then the
// money-action gate (S11): an exercise changes what the tenant is billed.

import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, oidFromToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import * as ledger from "../ledger";
import { type LeaseEventState, nextLeaseEventState } from "../leaseEventMachine";
import { requireMoneyContext } from "../moneyGate";
import { holdsApproverRole, resolveCaller } from "../rentReview/http";
import { inTransaction } from "../rentReview/store";
import { scheduleSignOffFromRow } from "../scheduleSignOff";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { holdsAdmin } from "../moneyRules";
import { applyOptionExercise, type OverridableCheck } from "../leaseEvents/apply";
import { toLeaseEventDto } from "../leaseEvents/dto";
import { concludeLeaseEscalations } from "../leaseEvents/escalations";
import {
  adminOnTestOnly,
  deniedAttempt,
  isDirector,
  LeaseEventError,
  leaseEventErrorResponse,
  OPTION_APPROVE_ROLES,
  readBody,
  readEventId,
  readOptionalReason,
  readRowVersion,
  recordLeaseEventRefusal,
} from "../leaseEvents/http";
import { eventForUpdate, loadEvent, lockTenancyForEvent } from "../leaseEvents/store";

/** Same person: by AppUsers id when both have one, else by name. */
export function isRecorder(event: { RecordedById?: unknown; RecordedByName?: unknown }, actor: { name: string; userId: number | null }): boolean {
  const recorderId = event.RecordedById === null || event.RecordedById === undefined ? null : Number(event.RecordedById);
  if (recorderId !== null && actor.userId !== null) return recorderId === actor.userId;
  const name = typeof event.RecordedByName === "string" ? event.RecordedByName.trim().toLowerCase() : "";
  return name !== "" && name === actor.name.trim().toLowerCase();
}

export async function approveOptionExercise(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, OPTION_APPROVE_ROLES);
  if (roleCheck) return roleCheck;
  const gate = await requireMoneyContext(request);
  if (gate) return gate;

  let connection;
  try {
    const body = await readBody(request);
    const leaseEventId = readEventId(body.leaseEventId);
    const rowVersion = readRowVersion(body.rowVersion);
    const overrideReason = readOptionalReason(body.overrideReason);

    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    const db = connection;
    const today = todayInDarwin();
    const correlationId = ledger.newCorrelationId();
    const director = isDirector(caller.roles);

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
        const ref = { buildingId: event.BuildingId === null ? null : Number(event.BuildingId), leaseEventId, state, tenantId };
        if (state !== "awaiting_approval" && state !== "notice_received") {
          throw new LeaseEventError("invalid_state", `This option is ${state.replace(/_/g, " ")}, so there is nothing to approve.`, { state });
        }
        const tenancy = await lockTenancyForEvent(db, tenantId);
        if (!tenancy) throw new LeaseEventError("not_found", "That option's tenancy doesn't exist");
        const isTest = tenancy.IsTest === true || tenancy.IsTest === 1;
        const adminRefused = adminOnTestOnly(caller, isTest, ref, "lease_event.option_exercised");
        if (adminRefused) throw adminRefused;
        if (!holdsApproverRole(caller.roles) && !holdsAdmin(caller.roles)) {
          const message = "Only an accounts manager, the CFO or a director can approve an option exercise";
          throw new LeaseEventError("forbidden", message, {}, deniedAttempt(caller, ref, "lease_event.option_exercised", "role_not_permitted", message));
        }
        if (!director && isRecorder(event, caller.actor)) {
          const message = "You recorded this notice, so someone else has to approve it";
          throw new LeaseEventError("sod_blocked", message, {}, deniedAttempt(caller, ref, "lease_event.option_exercised", "approver_is_recorder", message, "sod_blocked"));
        }

        const checks = new Set<OverridableCheck>();
        if (state === "notice_received") {
          if (!director || overrideReason === null) {
            throw new LeaseEventError(
              "late_notice",
              director
                ? "The notice is dated outside the option window. To accept it anyway, say why."
                : "The notice is dated outside the option window, so only a director can accept it.",
              director ? { directorCanOverride: true } : {},
            );
          }
          checks.add("option_window");
        }
        if (!scheduleSignOffFromRow(tenancy)) {
          if (!director || overrideReason === null) {
            throw new LeaseEventError("not_signed_off", "This tenancy's schedule isn't signed off yet. Sign it off, then approve.", director ? { directorCanOverride: true } : {});
          }
          checks.add("not_signed_off");
        }
        if (nextLeaseEventState("option_exercise", state, "APPROVE", { directorOverride: checks.has("option_window") }) !== "exercised") {
          throw new LeaseEventError("invalid_state", "This option can't be approved from where it is.", { state });
        }

        const result = await applyOptionExercise(db, {
          actor: caller.actor,
          actorOid: oidFromToken(token) ?? "unknown",
          correlationId,
          directorOverride: checks.size > 0 && overrideReason !== null ? { checks, reason: overrideReason } : null,
          event,
          tenancy,
          today,
        });
        for (const check of checks) {
          await ledger.record(db, {
            action: "lease_event.director_override",
            actor: caller.actor,
            after: {
              check,
              facts:
                check === "option_window"
                  ? { deadlineOn: event.DeadlineOn ?? null, noticeDate: event.NoticeDate ?? null, windowOpensOn: event.WindowOpensOn ?? null }
                  : { scheduleSignedOff: false },
            },
            buildingId: result.buildingId,
            correlationId,
            reason: overrideReason,
            ruleApplied: check,
            subject: { id: leaseEventId, type: "lease_event" },
            tenantId,
          });
        }
        const after = await loadEvent(db, leaseEventId);
        if (!after) throw new Error(`Lease event ${leaseEventId} vanished while it was approved`);
        return { after, result };
      });
    } catch (error) {
      await recordLeaseEventRefusal(db, error);
      throw error;
    }

    const { result } = done;
    invalidateTenantAndBuilding(result.tenantId, result.buildingId);
    const log = (message: string) => context.warn(message);
    await concludeLeaseEscalations(db, { actor: caller.actor, code: "exercised", leaseEventId, log });
    if (result.supersededRenewal) {
      await concludeLeaseEscalations(db, {
        actor: caller.actor,
        code: "superseded",
        leaseEventId: result.supersededRenewal,
        log,
        note: "The tenant exercised an option, so the lease runs on",
      });
    }
    return {
      jsonBody: {
        event: toLeaseEventDto(done.after),
        outcome: { marketReview: result.marketReview, newExpiry: result.newExpiry, optionsRemaining: result.optionsRemaining },
      },
      status: 200,
    };
  } catch (error) {
    return leaseEventErrorResponse(error, context, "approveOptionExercise");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("approveOptionExercise", { authLevel: "anonymous", handler: approveOptionExercise, methods: ["POST"] });
