// What the schedule change endpoints share: who may do what, the one error type
// that becomes a response, and the readers. The generic readers (a JSON body, a
// reason, a rowVersion, the caller) are the rent review endpoints' own.

import type { HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { AppRole, errorResponse } from "../auth";
import type { SqlRow } from "../db";
import type { LedgerEntryInput } from "../ledger";
import { recordApart } from "../ledger/refusals";
import { isDeadlockVictim, RentReviewError, rentReviewErrorResponse, TENANCY_EDIT_ROLES, TENANCY_VIEW_ROLES, type Caller } from "../rentReview/http";
import { ledgerRefusal } from "../tenancyScheduleWrite";
import { toChangeDto } from "./dto";
import { SCHEDULE_CHANGE_SUBJECT } from "./types";

/** Who may ask for a change: the roles that may edit a tenancy ("accounts and
 *  above"; frontend capability requestScheduleChange). The cfo passes through
 *  requireRole's hierarchy. */
export const CHANGE_REQUEST_ROLES: readonly AppRole[] = TENANCY_EDIT_ROLES;

/** Who may ratify or reject one: directors (D24). requireRole lets admin through
 *  every gate, so each of those handlers also asks isDirector: admin never
 *  decides (D20). Frontend capability ratifyScheduleChange. */
export const CHANGE_DECIDE_ROLES: readonly AppRole[] = [AppRole.DIRECTOR];

/** Who may read changes: the roles that may read a tenancy. */
export const CHANGE_VIEW_ROLES: readonly AppRole[] = TENANCY_VIEW_ROLES;

export const isDirector = (roles: readonly string[]): boolean => roles.includes(AppRole.DIRECTOR);

export type ScheduleChangeErrorCode =
  | "forbidden"
  | "invalid_state"
  | "kind_not_requestable"
  | "no_user"
  | "not_a_reduction"
  | "not_found"
  | "nothing_to_relieve"
  | "relief_overlap"
  | "relief_too_large"
  | "stale"
  | "stale_schedule"
  | "tenancy_archived"
  | "tenancy_vacated"
  | "unreadable_change";

const STATUS: Record<ScheduleChangeErrorCode, number> = {
  forbidden: 403,
  invalid_state: 409,
  kind_not_requestable: 400,
  no_user: 422,
  not_a_reduction: 422,
  not_found: 404,
  nothing_to_relieve: 422,
  relief_overlap: 409,
  relief_too_large: 422,
  stale: 409,
  stale_schedule: 409,
  tenancy_archived: 422,
  tenancy_vacated: 422,
  unreadable_change: 422,
};

export class ScheduleChangeError extends Error {
  readonly code: ScheduleChangeErrorCode;
  readonly details: Record<string, unknown>;
  /** A refused attempt the ledger records once the transaction has rolled back. Never part of the response. */
  readonly refusal: LedgerEntryInput | null;
  readonly status: number;

  constructor(code: ScheduleChangeErrorCode, message: string, details: Record<string, unknown> = {}, refusal: LedgerEntryInput | null = null) {
    super(message);
    this.name = "ScheduleChangeError";
    this.code = code;
    this.details = details;
    this.refusal = refusal;
    this.status = STATUS[code];
  }
}

/** An archived tenancy's schedule is history until it is restored, and a vacated
 *  one's rent isn't charged: neither takes a change (D4, WP25). */
export function refuseClosedTenancy(row: SqlRow): void {
  if (row.ArchivedAt !== null && row.ArchivedAt !== undefined) {
    throw new ScheduleChangeError("tenancy_archived", "This tenancy has been archived, so its schedule can't be changed.");
  }
  if (row.Status === "vacated") {
    throw new ScheduleChangeError("tenancy_vacated", "This tenancy has been vacated, so its schedule can't be changed.");
  }
}

/** The 409 for a change asked for against a schedule that has moved since it was read. */
export function staleSchedule(tenancy: SqlRow): ScheduleChangeError {
  const who = typeof tenancy.UpdatedByName === "string" && tenancy.UpdatedByName.trim() !== "" ? tenancy.UpdatedByName.trim() : "someone else";
  return new ScheduleChangeError("stale_schedule", `This tenancy's schedule was changed by ${who} since you opened it. Reload it and check the figures before asking again.`, {
    scheduleVersion: Number(tenancy.ScheduleVersion ?? 0),
  });
}

/** The 409 for a decision made on a stale read: the current request rides along. */
export function staleChange(row: SqlRow): ScheduleChangeError {
  return new ScheduleChangeError("stale", "Someone else changed this request since you opened it. Reload to see their change.", {
    current: toChangeDto(row),
  });
}

/** A refused attempt on a request, as the ledger records it (denied). */
export function deniedChange(caller: Caller, row: SqlRow, attempted: string, rule: string, message: string): LedgerEntryInput {
  return {
    action: "denied",
    actor: caller.actor,
    before: { attempted, state: row.State ?? null },
    buildingId: Number(row.BuildingId),
    reason: message,
    ruleApplied: rule,
    subject: { id: String(row.RequestId), type: SCHEDULE_CHANGE_SUBJECT },
    tenantId: Number(row.TenantId),
  };
}

/** Writes a refused attempt's ledger row after the decision rolled back. Never throws. */
export async function recordChangeRefusal(connection: Connection | undefined, error: unknown): Promise<void> {
  if (!connection || !(error instanceof ScheduleChangeError) || !error.refusal) return;
  await recordApart(connection, error.refusal, `refused ${error.code}`, "schedule-change-refusal");
}

const TRY_AGAIN =
  "Someone else was changing this tenancy at the same moment, so nothing was changed. Try again.";

/** A refusal as a response: this module's errors and the shared readers' (RentReviewError);
 *  a deadlock victim is a 409 try_again; anything else a 500 that goes to Sentry. */
export function scheduleChangeErrorResponse(error: unknown, context: InvocationContext, name: string): HttpResponseInit {
  if (error instanceof ScheduleChangeError) {
    return { jsonBody: { code: error.code, error: error.message, ...error.details }, status: error.status };
  }
  if (error instanceof RentReviewError) return rentReviewErrorResponse(error, context, name);
  if (isDeadlockVictim(error)) {
    context.warn(`${name}: deadlock victim, rolled back; the caller is asked to try again`);
    return { jsonBody: { code: "try_again", error: TRY_AGAIN }, status: 409 };
  }
  const refusal = ledgerRefusal(error);
  if (refusal) return refusal;
  context.error(`${name} failed:`, error instanceof Error ? error.message : String(error));
  return errorResponse(`${name} failed`, error);
}

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

export function readRequestId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!REQUEST_ID_RE.test(id)) throw new RentReviewError("bad_request", "requestId is required");
  return id;
}

const INT_MAX = 2_147_483_647;

export function readTenantId(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > INT_MAX) {
    throw new RentReviewError("bad_request", "tenantId must be the tenancy's id");
  }
  return value;
}

/** The ScheduleVersion the caller read: required, so a change is asked for against the schedule they saw. */
export function readScheduleVersion(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RentReviewError("bad_request", "scheduleVersion is required: send back the tenancy's scheduleVersion you were given");
  }
  return value;
}

/** An optional note: trimmed, at most 2000 characters, null when blank. */
export function readNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new RentReviewError("bad_request", "note must be text");
  const note = value.trim();
  if (note.length > 2000) throw new RentReviewError("bad_request", "note can be at most 2000 characters");
  return note === "" ? null : note;
}
