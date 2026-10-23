// What the lease event endpoints share (WP32, WP33): the role lists, the error
// type that becomes a response, and the request readers. Responses are camelCase
// JSON like the rent review endpoints; writes are POSTs with a JSON body.

import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { AppRole, errorResponse } from "../auth";
import { isIsoDate } from "../darwinDate";
import type { LedgerEntryInput } from "../ledger";
import { recordApart } from "../ledger/refusals";
import { adminRefusal } from "../moneyRules";
import { isDeadlockVictim, REVIEW_APPROVE_ROLES, TENANCY_EDIT_ROLES, TENANCY_VIEW_ROLES, type Caller } from "../rentReview/http";
import { ledgerRefusal } from "../tenancyScheduleWrite";

/** Who may read a tenancy's lease events: whoever may read a tenancy (frontend viewLeaseEvents). */
export const LEASE_EVENT_VIEW_ROLES: readonly AppRole[] = TENANCY_VIEW_ROLES;

/** Who may record a tenant's option notice: the roles that may edit a tenancy
 *  (frontend recordOptionNotice; the same list as commenceRentReview). */
export const OPTION_RECORD_ROLES: readonly AppRole[] = TENANCY_EDIT_ROLES;

/** Who may approve an option exercise: accounts_manager, cfo, director, as a
 *  rent review's approver (frontend approveOptionExercise). requireRole lets
 *  admin through; the handler then refuses admin on a real tenancy (decision 4). */
export const OPTION_APPROVE_ROLES: readonly AppRole[] = REVIEW_APPROVE_ROLES;

/** Rejecting a notice and deciding a renewal are a director's (PLAN §3.5, §3.6;
 *  frontend rejectOptionNotice, recordRenewalOutcome). Admin passes the gate and
 *  is refused on a real tenancy. */
export const LEASE_DIRECTOR_ROLES: readonly AppRole[] = [AppRole.DIRECTOR];

export function isDirector(roles: readonly string[]): boolean {
  return roles.some((role) => role.trim().toLowerCase() === AppRole.DIRECTOR);
}

export const REASON_MAX_CHARS = 2000;
export const NOTICE_DOCUMENT_MAX_CHARS = 500;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ROW_VERSION_RE = /^[0-9a-f]{16}$/i;

export type LeaseEventErrorCode =
  | "admin_test_records_only"
  | "bad_request"
  | "expiry_changed"
  | "forbidden"
  | "invalid_state"
  | "late_notice"
  | "no_expiry"
  | "no_options"
  | "no_window"
  | "not_found"
  | "not_signed_off"
  | "open_event_exists"
  | "reason_required"
  | "schedule_conflict"
  | "schedule_empty"
  | "sod_blocked"
  | "stale"
  | "tenancy_archived"
  | "tenancy_vacated"
  | "try_again";

const STATUS: Record<LeaseEventErrorCode, number> = {
  admin_test_records_only: 403,
  bad_request: 400,
  expiry_changed: 409,
  forbidden: 403,
  invalid_state: 409,
  late_notice: 422,
  no_expiry: 422,
  no_options: 422,
  no_window: 422,
  not_found: 404,
  not_signed_off: 422,
  open_event_exists: 409,
  reason_required: 400,
  schedule_conflict: 422,
  schedule_empty: 422,
  sod_blocked: 403,
  stale: 409,
  tenancy_archived: 422,
  tenancy_vacated: 422,
  try_again: 409,
};

export class LeaseEventError extends Error {
  readonly code: LeaseEventErrorCode;
  /** Extra fields for the response body (the current event on a stale write). */
  readonly details: Record<string, unknown>;
  /** A refused decision attempt the ledger records once the transaction has rolled back. Never part of the response. */
  readonly refusal: LedgerEntryInput | null;
  readonly status: number;

  constructor(code: LeaseEventErrorCode, message: string, details: Record<string, unknown> = {}, refusal: LedgerEntryInput | null = null) {
    super(message);
    this.name = "LeaseEventError";
    this.code = code;
    this.details = details;
    this.refusal = refusal;
    this.status = STATUS[code];
  }
}

/** A refused attempt on an event, as the ledger records it once the transaction has rolled back. */
export function deniedAttempt(
  caller: Caller,
  event: { buildingId: number | null; leaseEventId: string; state: string; tenantId: number },
  attempted: string,
  rule: string,
  message: string,
  action: "denied" | "sod_blocked" = "denied",
): LedgerEntryInput {
  return {
    action,
    actor: caller.actor,
    before: { attempted, state: event.state },
    buildingId: event.buildingId,
    reason: message,
    ruleApplied: rule,
    subject: { id: event.leaseEventId, type: "lease_event" },
    tenantId: event.tenantId,
  };
}

/** Decision 4: admin decides only on test tenancies. The refusal, ledgered, or null. */
export function adminOnTestOnly(
  caller: Caller,
  isTest: boolean,
  event: { buildingId: number | null; leaseEventId: string; state: string; tenantId: number },
  attempted: string,
): LeaseEventError | null {
  const refused = adminRefusal(caller.roles, isTest);
  if (!refused) return null;
  return new LeaseEventError(
    "admin_test_records_only",
    refused.message,
    {},
    deniedAttempt(caller, event, attempted, "admin_test_records_only", refused.message),
  );
}

/** Writes a refused attempt's ledger row after the decision rolled back, in a transaction of its own. Never throws. */
export async function recordLeaseEventRefusal(connection: Connection | undefined, error: unknown): Promise<void> {
  if (!connection || !(error instanceof LeaseEventError) || !error.refusal) return;
  await recordApart(connection, error.refusal, `refused ${error.code}`, "lease-event-refusal");
}

const TRY_AGAIN =
  "Someone else was changing this tenancy at the same moment, so nothing was changed. Try again.";

/** A refusal as a response; a deadlock victim or a unique-index race a 409 try_again; anything else a 500. */
export function leaseEventErrorResponse(error: unknown, context: InvocationContext, name: string): HttpResponseInit {
  if (error instanceof LeaseEventError) {
    return { jsonBody: { code: error.code, error: error.message, ...error.details }, status: error.status };
  }
  if (isDeadlockVictim(error)) {
    context.warn(`${name}: deadlock victim, rolled back; the caller is asked to try again`);
    return { jsonBody: { code: "try_again", error: TRY_AGAIN }, status: 409 };
  }
  const refusal = ledgerRefusal(error);
  if (refusal) return refusal;
  const message = error instanceof Error ? error.message : String(error);
  context.error(`${name} failed:`, message);
  return errorResponse(`${name} failed`, error);
}

export function readEventId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!EVENT_ID_RE.test(id)) throw new LeaseEventError("bad_request", "leaseEventId is required");
  return id;
}

export function readTenantId(value: unknown): number {
  const id = typeof value === "number" ? value : typeof value === "string" && /^\d{1,10}$/.test(value.trim()) ? Number(value) : Number.NaN;
  if (!Number.isInteger(id) || id <= 0) throw new LeaseEventError("bad_request", "tenantId is required");
  return id;
}

/** The Version the caller read, lower-cased. */
export function readRowVersion(value: unknown): string {
  if (typeof value !== "string" || !ROW_VERSION_RE.test(value.trim())) {
    throw new LeaseEventError("bad_request", "rowVersion is required: send back the one you were given");
  }
  return value.trim().toLowerCase();
}

/** An optional Version: absent when the caller saw no event yet. */
export function readOptionalRowVersion(value: unknown): string | null {
  return value === undefined || value === null || value === "" ? null : readRowVersion(value);
}

export function readIsoDate(value: unknown, field: string): string {
  if (!isIsoDate(value)) throw new LeaseEventError("bad_request", `${field} must be a date (YYYY-MM-DD)`);
  return value;
}

export function readReason(value: unknown, missing: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new LeaseEventError("reason_required", missing);
  const reason = value.trim();
  if (reason.length > REASON_MAX_CHARS) throw new LeaseEventError("bad_request", `reason can be at most ${REASON_MAX_CHARS} characters`);
  return reason;
}

/** An optional reason: null when absent or blank. */
export function readOptionalReason(value: unknown): string | null {
  if (value === undefined || value === null || (typeof value === "string" && value.trim() === "")) return null;
  return readReason(value, "Say why");
}

export function readOptionalText(value: unknown, field: string, max: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new LeaseEventError("bad_request", `${field} must be text`);
  const text = value.trim();
  if (text.length > max) throw new LeaseEventError("bad_request", `${field} can be at most ${max} characters`);
  return text === "" ? null : text;
}

/** A JSON object body, or a bad_request. */
export async function readBody(request: HttpRequest): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new LeaseEventError("bad_request", "The request body must be JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new LeaseEventError("bad_request", "The request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}
