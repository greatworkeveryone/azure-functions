// POST /api/recordRenewalOutcome   (PLAN §3.6 DECIDE_RENEWAL; WP33)
//
//   { leaseEventId, rowVersion, outcome, note?,          (or { tenantId, outcome, ... } when no
//                                                        renewal is open: see "opened here")
//     renewed?: { commencement, expiry, baseRentPerAnnum, reviewIntervalMonths?, reviewMethod,
//                 fixedPercent?, optionsTotal?, optionTermMonths?, optionPeriods? },
//     holdoverTerms? }
//   200 { event }
//
// The directors' decision on a lease referred for renewal: renewed (a new term,
// with its commencement row, review cadence and options), vacating (a draft
// vacancy available from the expiry) or holdover (the terms, and the status once
// the lease has ended). leaseEvents/renewal.ts has the writes; one transaction,
// ledgered as lease_event.renewed / vacating / holdover.
//
//   rowVersion  the one the caller read, else 409 { code: "stale", current }
//   state       referred, else 409 invalid_state
//   role        director; admin only on a test tenancy (decision 4); anyone else
//               403 forbidden, ledgered as denied
//   input       400 for a missing or malformed field: renewed needs both dates
//               (expiry after commencement, commencement after the current
//               expiry), a starting rent and a method; holdover needs its terms
// Opened here: with no renewal event yet (the generator is off, or hasn't reached
// the lease), a director may decide from the tenancy: the request names the
// tenancy instead of an event, and in the same transaction a referred event is
// opened for the current expiry (lease_event.renewal_referred, by the director)
// and decided. Refused (409 open_event_exists) when a renewal is already open or
// decided for this expiry, or while an option exercise is open.
// After the commit the renewal escalation ends with the outcome as its code.
//
// Gates: LEASE_DIRECTOR_ROLES (frontend capability recordRenewalOutcome), then
// the money-action gate (S11): a renewal sets a new starting rent.

import { randomUUID } from "node:crypto";
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { extractToken, oidFromToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection } from "../db";
import * as ledger from "../ledger";
import { type LeaseEventState, nextLeaseEventState, RENEWAL_OUTCOMES, type RenewalOutcome } from "../leaseEventMachine";
import type { OptionMethodKind } from "../leaseOptions";
import { requireMoneyContext } from "../moneyGate";
import { holdsAdmin } from "../moneyRules";
import { sqlDateToIso } from "../nextReviewDate";
import { type Caller, resolveCaller } from "../rentReview/http";
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
  readIsoDate,
  readOptionalReason,
  readOptionalText,
  readReason,
  readRowVersion,
  readTenantId,
  recordLeaseEventRefusal,
} from "../leaseEvents/http";
import { refuseClosedTenancy } from "../leaseEvents/apply";
import { decideRenewal, type RenewalDecision } from "../leaseEvents/renewal";
import { eventForUpdate, insertEvent, loadEvent, loadEventsForTenancy, lockTenancyForEvent, openEventForUpdate } from "../leaseEvents/store";

const METHODS: readonly OptionMethodKind[] = ["cpi", "fixed", "market", "other"];

function integer(value: unknown, field: string, min: number, max: number, fallback: number | null): number | null {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new LeaseEventError("bad_request", `${field} must be a whole number from ${min} to ${max}`);
  }
  return value;
}

/** The decision in the request body, checked before anything touches the database. */
export function readRenewalDecision(body: Record<string, unknown>): RenewalDecision {
  const outcome = body.outcome as RenewalOutcome;
  if (!RENEWAL_OUTCOMES.includes(outcome)) throw new LeaseEventError("bad_request", `outcome must be one of ${RENEWAL_OUTCOMES.join(", ")}`);
  if (outcome === "vacating") return { outcome };
  if (outcome === "holdover") return { holdoverTerms: readReason(body.holdoverTerms, "Say on what terms the tenant holds over"), outcome };
  const raw = body.renewed;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new LeaseEventError("bad_request", "renewed must give the new lease's terms");
  const terms = raw as Record<string, unknown>;
  const commencement = readIsoDate(terms.commencement, "renewed.commencement");
  const expiry = readIsoDate(terms.expiry, "renewed.expiry");
  if (expiry <= commencement) throw new LeaseEventError("bad_request", "The new expiry must be after the new commencement");
  const rent = terms.baseRentPerAnnum;
  if (typeof rent !== "number" || !Number.isFinite(rent) || rent < 0 || rent > 100_000_000) {
    throw new LeaseEventError("bad_request", "renewed.baseRentPerAnnum must be the new lease's starting rent a year");
  }
  const method = terms.reviewMethod as OptionMethodKind;
  if (!METHODS.includes(method)) throw new LeaseEventError("bad_request", `renewed.reviewMethod must be one of ${METHODS.join(", ")}`);
  const fixed = terms.fixedPercent;
  if (method === "fixed" && (typeof fixed !== "number" || !Number.isFinite(fixed) || fixed < 0 || fixed > 100)) {
    throw new LeaseEventError("bad_request", "A fixed review needs renewed.fixedPercent, from 0 to 100");
  }
  const optionsTotal = integer(terms.optionsTotal, "renewed.optionsTotal", 0, 20, null);
  const optionTermMonths = integer(terms.optionTermMonths, "renewed.optionTermMonths", 1, 600, null);
  if (optionsTotal !== null && optionsTotal > 0 && optionTermMonths === null) {
    throw new LeaseEventError("bad_request", "Give the length of each option (renewed.optionTermMonths)");
  }
  return {
    outcome,
    renewed: {
      baseRentPerAnnum: Math.round(rent * 100) / 100,
      commencement,
      expiry,
      fixedPercent: method === "fixed" ? (fixed as number) : null,
      optionPeriods: readOptionalText(terms.optionPeriods, "renewed.optionPeriods", 500),
      optionsTotal,
      optionTermMonths: optionsTotal === null || optionsTotal === 0 ? null : optionTermMonths,
      reviewIntervalMonths: integer(terms.reviewIntervalMonths, "renewed.reviewIntervalMonths", 1, 120, 12) as number,
      reviewMethod: method,
    },
  };
}

/** "Opened here": a referred renewal for the tenancy's current expiry, when none is open or decided for it. */
async function openRenewalHere(db: Connection, caller: Caller, tenantId: number, leaseEventId: string, correlationId: string): Promise<string> {
  const tenancy = await lockTenancyForEvent(db, tenantId);
  if (!tenancy) throw new LeaseEventError("not_found", "That tenancy doesn't exist");
  refuseClosedTenancy(tenancy);
  const expiry = sqlDateToIso(tenancy.Expiry);
  if (!expiry) throw new LeaseEventError("no_expiry", "This tenancy has no expiry date, so there is no renewal to decide.");
  if (await openEventForUpdate(db, tenantId, "option_exercise")) {
    throw new LeaseEventError("open_event_exists", "An option exercise is open on this lease. Settle it before deciding a renewal.");
  }
  const existing = (await loadEventsForTenancy(db, tenantId)).find(
    (row) => row.Type === "renewal" && (row.State === "referred" || sqlDateToIso(row.LeaseExpiry) === expiry),
  );
  if (existing) {
    throw new LeaseEventError("open_event_exists", "A renewal is already open or decided for this expiry. Reload to see it.", { leaseEventId: String(existing.LeaseEventId) });
  }
  const buildingId = tenancy.BuildingId === null || tenancy.BuildingId === undefined ? null : Number(tenancy.BuildingId);
  await insertEvent(db, { buildingId, deadlineOn: null, leaseEventId, leaseExpiry: expiry, state: "referred", tenantId, type: "renewal", windowOpensOn: null });
  await ledger.record(db, {
    action: "lease_event.renewal_referred",
    actor: caller.actor,
    after: { leaseExpiry: expiry, state: "referred", type: "renewal" },
    buildingId,
    correlationId,
    ruleApplied: "opened_by_director",
    subject: { id: leaseEventId, type: "lease_event" },
    tenantId,
  });
  return leaseEventId;
}

export async function recordRenewalOutcome(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, LEASE_DIRECTOR_ROLES);
  if (roleCheck) return roleCheck;
  const gate = await requireMoneyContext(request);
  if (gate) return gate;

  let connection;
  try {
    const body = await readBody(request);
    const opening = body.leaseEventId === undefined || body.leaseEventId === null;
    const tenantIdToOpen = opening ? readTenantId(body.tenantId) : null;
    let leaseEventId = opening ? randomUUID() : readEventId(body.leaseEventId);
    const rowVersion = opening ? null : readRowVersion(body.rowVersion);
    const decision = readRenewalDecision(body);
    const note = readOptionalReason(body.note);

    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    const db = connection;
    const today = todayInDarwin();
    const correlationId = ledger.newCorrelationId();

    let done;
    try {
      done = await inTransaction(db, async () => {
        if (tenantIdToOpen !== null) leaseEventId = await openRenewalHere(db, caller, tenantIdToOpen, leaseEventId, correlationId);
        const event = await eventForUpdate(db, leaseEventId);
        if (!event || event.Type !== "renewal") throw new LeaseEventError("not_found", "That renewal doesn't exist");
        if (rowVersion !== null && rowVersionHex(event.Version) !== rowVersion) {
          throw new LeaseEventError("stale", "Someone else changed this renewal since you opened it. Reload to see their change.", { current: toLeaseEventDto(event) });
        }
        const state = String(event.State) as LeaseEventState;
        const tenantId = Number(event.TenantId);
        const ref = { buildingId: event.BuildingId === null ? null : Number(event.BuildingId), leaseEventId, state, tenantId };
        if (nextLeaseEventState("renewal", state, "DECIDE_RENEWAL", { outcome: decision.outcome }) === null) {
          throw new LeaseEventError("invalid_state", `This renewal is ${state.replace(/_/g, " ")}, so it has already been decided.`, { state });
        }
        const tenancy = await lockTenancyForEvent(db, tenantId);
        if (!tenancy) throw new LeaseEventError("not_found", "That renewal's tenancy doesn't exist");
        const adminRefused = adminOnTestOnly(caller, tenancy.IsTest === true || tenancy.IsTest === 1, ref, `lease_event.${decision.outcome}`);
        if (adminRefused) throw adminRefused;
        if (!isDirector(caller.roles) && !holdsAdmin(caller.roles)) {
          const message = "Only a director can decide a renewal";
          throw new LeaseEventError("forbidden", message, {}, deniedAttempt(caller, ref, `lease_event.${decision.outcome}`, "role_not_permitted", message));
        }
        if (decision.outcome === "renewed") {
          const current = sqlDateToIso(tenancy.Expiry);
          if (current && decision.renewed.commencement <= current) {
            throw new LeaseEventError("bad_request", `The new lease must start after the current one ends (${current})`);
          }
        }
        const result = await decideRenewal(db, {
          actor: caller.actor,
          actorOid: oidFromToken(token) ?? "unknown",
          correlationId,
          decision,
          event,
          note,
          tenancy,
          today,
        });
        const after = await loadEvent(db, leaseEventId);
        if (!after) throw new Error(`Lease event ${leaseEventId} vanished while it was decided`);
        return { after, result };
      });
    } catch (error) {
      await recordLeaseEventRefusal(db, error);
      throw error;
    }

    invalidateTenantAndBuilding(done.result.tenantId, done.result.buildingId);
    await concludeLeaseEscalations(db, { actor: caller.actor, code: decision.outcome, leaseEventId, log: (message) => context.warn(message), note });
    return { jsonBody: { event: toLeaseEventDto(done.after) }, status: 200 };
  } catch (error) {
    return leaseEventErrorResponse(error, context, "recordRenewalOutcome");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("recordRenewalOutcome", { authLevel: "anonymous", handler: recordRenewalOutcome, methods: ["POST"] });
