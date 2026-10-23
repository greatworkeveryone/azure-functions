// POST /api/recordOptionNotice   (PLAN §3.5 RECORD_NOTICE; WP32)
//
//   { tenantId, noticeDate, noticeDocument?, startMethod, ongoingMethod?, fixedPercent?,
//     leaseEventId?, rowVersion?, reason? }
//   200 { event, late }
//
// Records the tenant's notice that they are exercising an option: the date it
// was given, the document it came in, and the term it asks for (the review on
// the option's first day, "market" when the lease says the option starts at
// market, and the reviews after it; the ongoing method defaults to the lease's).
// In one transaction, under update locks on the tenancy and the event:
//
//   tenancy   archived 422 tenancy_archived, vacated 422 tenancy_vacated,
//             no expiry 422 no_expiry
//   C10       an option left (422 no_options, also when the options can't be read)
//             and a notice period to date a window from (422 no_window)
//   event     the tenancy's open option event, else the one that lapsed for this
//             expiry, else a new one (lease_event.open); one whose notice is
//             already recorded is 409 invalid_state; a rowVersion sent must be
//             the event's (409 stale)
//   window    a notice dated inside the window goes for approval
//             (awaiting_approval, lease_event.notice_recorded); one dated
//             outside it is recorded with a warning (notice_received,
//             lease_event.late_notice, an exception that needs the recorder's
//             reason) and only a director can take it further (approve with a
//             reason, or reject). A notice dated after today is 400.
//
// After the commit the option's deadline and lapse escalations end
// ("notice_recorded"); a failure there is logged and the sweep ends them anyway.
//
// Gate: OPTION_RECORD_ROLES (the roles that may edit a tenancy; frontend
// capability recordOptionNotice).

import { randomUUID } from "node:crypto";
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { extractToken, requireRole, unauthorizedResponse } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, createRequestConnection, type SqlRow } from "../db";
import * as ledger from "../ledger";
import { type LeaseEventState, nextLeaseEventState } from "../leaseEventMachine";
import { isInsideOptionWindow, type OptionMethodKind, optionTermDates } from "../leaseOptions";
import { sqlDateToIso } from "../nextReviewDate";
import { resolveCaller } from "../rentReview/http";
import { inTransaction } from "../rentReview/store";
import { invalidateTenantAndBuilding } from "../tenant-register-cache";
import { rowVersionHex } from "../tenancyScheduleWrite";
import { refuseClosedTenancy } from "../leaseEvents/apply";
import { toLeaseEventDto, type OptionTerms } from "../leaseEvents/dto";
import { concludeLeaseEscalations, LEASE_POLICIES } from "../leaseEvents/escalations";
import {
  LeaseEventError,
  leaseEventErrorResponse,
  NOTICE_DOCUMENT_MAX_CHARS,
  OPTION_RECORD_ROLES,
  readBody,
  readIsoDate,
  readOptionalReason,
  readOptionalRowVersion,
  readOptionalText,
  readTenantId,
} from "../leaseEvents/http";
import { leaseFixedPercent, leaseIntervalMonths, leaseOptionsOf, leaseReviewMethod, optionWindowOf } from "../leaseEvents/options";
import { insertEvent, lapsedOptionForUpdate, loadEvent, lockTenancyForEvent, markNoticeRecorded, openEventForUpdate } from "../leaseEvents/store";

const METHODS: readonly OptionMethodKind[] = ["cpi", "fixed", "market", "other"];

export interface NoticeBody {
  fixedPercent: number | null;
  noticeDate: string;
  noticeDocument: string | null;
  ongoingMethod: OptionMethodKind | null;
  reason: string | null;
  rowVersion: string | null;
  startMethod: OptionMethodKind;
  tenantId: number;
}

function readMethod(value: unknown, field: string, optional: boolean): OptionMethodKind | null {
  if (optional && (value === undefined || value === null || value === "")) return null;
  if (!METHODS.includes(value as OptionMethodKind)) throw new LeaseEventError("bad_request", `${field} must be one of ${METHODS.join(", ")}`);
  return value as OptionMethodKind;
}

/** The request body, checked before anything touches the database. */
export function readNoticeBody(body: Record<string, unknown>): NoticeBody {
  const fixed = body.fixedPercent;
  if (fixed !== undefined && fixed !== null && (typeof fixed !== "number" || !Number.isFinite(fixed) || fixed < 0 || fixed > 100)) {
    throw new LeaseEventError("bad_request", "fixedPercent must be a percentage from 0 to 100");
  }
  return {
    fixedPercent: typeof fixed === "number" ? fixed : null,
    noticeDate: readIsoDate(body.noticeDate, "noticeDate"),
    noticeDocument: readOptionalText(body.noticeDocument, "noticeDocument", NOTICE_DOCUMENT_MAX_CHARS),
    ongoingMethod: readMethod(body.ongoingMethod, "ongoingMethod", true),
    reason: readOptionalReason(body.reason),
    rowVersion: readOptionalRowVersion(body.rowVersion),
    startMethod: readMethod(body.startMethod, "startMethod", false) as OptionMethodKind,
    tenantId: readTenantId(body.tenantId),
  };
}

/** The open (or lapsed-for-this-expiry) option event to record against, or null for a new one. */
async function eventToRecordOn(db: Parameters<typeof openEventForUpdate>[0], tenantId: number, expiry: string): Promise<SqlRow | null> {
  return (await openEventForUpdate(db, tenantId, "option_exercise")) ?? (await lapsedOptionForUpdate(db, tenantId, expiry));
}

export async function recordOptionNotice(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const token = extractToken(request);
  if (!token) return unauthorizedResponse();
  const roleCheck = await requireRole(request, OPTION_RECORD_ROLES);
  if (roleCheck) return roleCheck;

  let connection;
  try {
    const body = readNoticeBody(await readBody(request));
    connection = await createRequestConnection(token);
    const caller = await resolveCaller(request, connection);
    if (!caller) return unauthorizedResponse();
    const db = connection;
    const today = todayInDarwin();
    if (body.noticeDate > today) throw new LeaseEventError("bad_request", "The notice date can't be after today");
    const correlationId = ledger.newCorrelationId();

    const done = await inTransaction(db, async () => {
      const tenancy = await lockTenancyForEvent(db, body.tenantId);
      if (!tenancy) throw new LeaseEventError("not_found", "That tenancy doesn't exist");
      refuseClosedTenancy(tenancy);
      const tenantId = body.tenantId;
      const buildingId = tenancy.BuildingId === null || tenancy.BuildingId === undefined ? null : Number(tenancy.BuildingId);
      const expiry = sqlDateToIso(tenancy.Expiry);
      if (!expiry) throw new LeaseEventError("no_expiry", "This tenancy has no expiry date, so an option can't be exercised. Set the expiry first.");
      const options = leaseOptionsOf(tenancy);
      if (options.remaining === null || options.termMonths === null) {
        throw new LeaseEventError("no_options", "Floorplan can't read this lease's options. Set the option periods (for example \"2 x 5 years\") first.");
      }
      if (options.remaining < 1) throw new LeaseEventError("no_options", "This lease has no options left to exercise.");
      const window = optionWindowOf(tenancy, today);
      const dates = optionTermDates(expiry, options.termMonths);
      if (window.state === "none" || window.opensAt === null || window.deadline === null || !dates) {
        throw new LeaseEventError("no_window", "This tenancy has no option notice period, so the window can't be dated. Set it first.");
      }
      const inWindow = isInsideOptionWindow(window, body.noticeDate);
      if (!inWindow && body.reason === null) {
        throw new LeaseEventError(
          "reason_required",
          `The notice is dated outside the option window (${window.opensAt} to ${window.deadline}). Say why it is late or early; a director decides whether to accept it.`,
        );
      }

      let event = await eventToRecordOn(db, tenantId, expiry);
      if (event && body.rowVersion !== null && rowVersionHex(event.Version) !== body.rowVersion) {
        throw new LeaseEventError("stale", "Someone else changed this option since you opened it. Reload to see their change.", { current: toLeaseEventDto(event) });
      }
      if (!event) {
        const leaseEventId = randomUUID();
        const state = nextLeaseEventState("option_exercise", null, "OPEN_OPTION", { windowOpen: today >= window.opensAt }) as LeaseEventState;
        await insertEvent(db, { buildingId, deadlineOn: window.deadline, leaseEventId, leaseExpiry: expiry, state, tenantId, type: "option_exercise", windowOpensOn: window.opensAt });
        await ledger.record(db, {
          action: "lease_event.open",
          actor: caller.actor,
          after: { deadlineOn: window.deadline, leaseExpiry: expiry, state, type: "option_exercise", windowOpensOn: window.opensAt },
          buildingId,
          correlationId,
          ruleApplied: "opened_with_notice",
          subject: { id: leaseEventId, type: "lease_event" },
          tenantId,
        });
        event = { LeaseEventId: leaseEventId, State: state };
      }
      const from = String(event.State) as LeaseEventState;
      const to = nextLeaseEventState("option_exercise", from, "RECORD_NOTICE", { noticeInWindow: inWindow });
      if (to === null) {
        throw new LeaseEventError("invalid_state", `A notice is already recorded on this option (${from.replace(/_/g, " ")}).`, { state: from });
      }
      const terms: OptionTerms = {
        fixedPercent: body.fixedPercent ?? leaseFixedPercent(tenancy),
        intervalMonths: leaseIntervalMonths(tenancy),
        newExpiry: dates.newExpiry,
        ongoingMethod: body.ongoingMethod ?? leaseReviewMethod(tenancy),
        optionStart: dates.optionStart,
        startMethod: body.startMethod,
        termMonths: options.termMonths,
        // A notice outside the window carries the recorder's reason, so the
        // director deciding it reads it beside the notice (the ledger keeps it too).
        ...(inWindow ? {} : { lateReason: body.reason }),
      };
      const leaseEventId = String(event.LeaseEventId);
      const recorded = await markNoticeRecorded(db, leaseEventId, from, to, {
        lateNotice: !inWindow,
        noticeDate: body.noticeDate,
        noticeDocument: body.noticeDocument,
        recorder: { name: caller.actor.name, userId: caller.actor.userId },
        termsJson: JSON.stringify(terms),
      });
      if (!recorded) throw new LeaseEventError("invalid_state", "This option just moved on, so the notice wasn't recorded.");
      await ledger.record(db, {
        action: inWindow ? "lease_event.notice_recorded" : "lease_event.late_notice",
        actor: caller.actor,
        after: { noticeDate: body.noticeDate, noticeDocument: body.noticeDocument, state: to, terms, window: { deadline: window.deadline, opensAt: window.opensAt } },
        before: { state: from },
        buildingId,
        correlationId,
        reason: body.reason,
        ruleApplied: inWindow ? "notice_in_window" : "notice_outside_window",
        subject: { id: leaseEventId, type: "lease_event" },
        tenantId,
      });
      const after = await loadEvent(db, leaseEventId);
      if (!after) throw new Error(`Lease event ${leaseEventId} vanished while its notice was recorded`);
      return { after, buildingId, late: !inWindow, leaseEventId, tenantId };
    });

    if (done.buildingId !== null) invalidateTenantAndBuilding(done.tenantId, done.buildingId);
    await concludeLeaseEscalations(db, {
      actor: caller.actor,
      code: "notice_recorded",
      leaseEventId: done.leaseEventId,
      log: (message) => context.warn(message),
      policyKeys: [LEASE_POLICIES.optionDeadline, LEASE_POLICIES.optionLapsed],
    });
    return { jsonBody: { event: toLeaseEventDto(done.after), late: done.late }, status: 200 };
  } catch (error) {
    return leaseEventErrorResponse(error, context, "recordOptionNotice");
  } finally {
    if (connection) closeConnection(connection);
  }
}

app.http("recordOptionNotice", { authLevel: "anonymous", handler: recordOptionNotice, methods: ["POST"] });
