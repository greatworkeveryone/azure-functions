// What the rent review endpoints share: the role lists, the request readers and
// the one error type that becomes a response.
//
// Responses are camelCase JSON, like the escalation endpoints. Writes are POSTs
// with a JSON body; reads are GETs.

import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { AppRole, errorResponse, rolesForRequest } from "../auth";
import type { SqlRow } from "../db";
import type { LedgerActor, LedgerEntryInput } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { recordApart } from "../ledger/refusals";
import { ledgerRefusal } from "../tenancyScheduleWrite";
import { toReviewDto } from "./dto";

/**
 * Who may read reviews and the lease-events feed: the roles that may read a
 * tenancy, as getRegisterTenant in functions/tenancy.ts (frontend capability
 * viewTenancy). Change them together. requireRole's hierarchy adds the cfo (it
 * satisfies an accounts_manager check).
 */
export const TENANCY_VIEW_ROLES: readonly AppRole[] = [
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
  AppRole.ADMIN,
  AppRole.DIRECTOR,
];

/**
 * Who may commence a review: the roles that may edit a tenancy, as
 * upsertRegisterTenant in functions/tenancy.ts (frontend capability editTenancy;
 * PLAN WP26 gives commenceRentReview the editTenancy roles). Change them
 * together. The cfo passes through the hierarchy, as above.
 */
export const TENANCY_EDIT_ROLES: readonly AppRole[] = [
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
  AppRole.ADMIN,
  AppRole.DIRECTOR,
];

/**
 * Who may submit (and so apply, when the result keeps to the lease) a review:
 * accounts, accounts_manager, cfo, director, admin (PLAN WP26's apply
 * capability; the frontend mirrors it). The same list as TENANCY_EDIT_ROLES;
 * the cfo passes through requireRole's hierarchy. Change them together.
 */
export const REVIEW_APPLY_ROLES: readonly AppRole[] = [
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
  AppRole.ADMIN,
  AppRole.DIRECTOR,
];

/**
 * Who may approve, return, waive and revert a review: accounts_manager, cfo,
 * director (PLAN WP26; frontend capabilities approveRentReview, waiveRentReview,
 * revertRentReview). requireRole lets admin through every gate, so each of
 * those handlers also asks holdsApproverRole: admin is never an approver (D20).
 * A market review's waive is a director's alone. Change the frontend with these.
 */
export const REVIEW_APPROVE_ROLES: readonly AppRole[] = [AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR];

/**
 * Who may cancel a review: an accounts manager and up, the roles that may change
 * a review they don't own (isManagerOrAbove; frontend capability
 * editAnyRentReview): accounts_manager, cfo, director, admin.
 */
export const REVIEW_CANCEL_ROLES: readonly AppRole[] = [AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR];

/** The approval ladder's levels, lowest first (E3: accounts_manager -> cfo -> director). */
export const APPROVER_RANK: Readonly<Record<string, number>> = {
  [AppRole.ACCOUNTS_APPROVAL]: 1,
  [AppRole.CFO]: 2,
  [AppRole.DIRECTOR]: 3,
};

/** The highest approval level among the caller's roles; 0 for none (admin included). */
export function approverRank(roles: readonly string[]): number {
  return roles.reduce((best, role) => Math.max(best, APPROVER_RANK[role] ?? 0), 0);
}

export function holdsApproverRole(roles: readonly string[]): boolean {
  return approverRank(roles) > 0;
}

// accounts_manager and up: the roles that may change a review they don't own.
const MANAGER_AND_UP: ReadonlySet<string> = new Set([
  AppRole.ACCOUNTS_APPROVAL,
  AppRole.ADMIN,
  AppRole.CFO,
  AppRole.DIRECTOR,
]);

export function isManagerOrAbove(roles: readonly string[]): boolean {
  return roles.some((role) => MANAGER_AND_UP.has(role));
}

/** The review's owner, or an accounts manager and up (directors always). */
export function ownsOrManages(review: SqlRow, caller: Caller): boolean {
  const owner = review.OwnerUserId === null || review.OwnerUserId === undefined ? null : Number(review.OwnerUserId);
  return (owner !== null && owner === caller.actor.userId) || isManagerOrAbove(caller.roles);
}

/** A refused attempt on a review, as the ledger records it (denied) once the transaction has rolled back. */
export function deniedAttempt(caller: Caller, review: SqlRow, attempted: string, rule: string, message: string): LedgerEntryInput {
  return {
    action: "denied",
    actor: caller.actor,
    before: { attempted, state: review.State ?? null },
    buildingId: Number(review.TenantBuildingId),
    reason: message,
    ruleApplied: rule,
    subject: { id: String(review.ReviewId), type: "rent_review" },
    tenantId: Number(review.TenantId),
  };
}

export const REASON_MAX_CHARS = 2000;
const REVIEW_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ROW_VERSION_RE = /^[0-9a-f]{16}$/i;

export type RentReviewErrorCode =
  | "approval_level"
  | "bad_request"
  | "basis_incomplete"
  | "changed_since_apply"
  | "cpi_base_mismatch"
  | "earlier_review_pending"
  | "forbidden"
  | "invalid_state"
  | "manual_required"
  | "method_not_supported"
  | "next_review_in_progress"
  | "no_change"
  | "no_current_rent"
  | "no_user"
  | "not_calculated"
  | "not_found"
  | "not_representable"
  | "not_revertible"
  | "not_signed_off"
  | "open_review_exists"
  | "ratchet"
  | "reason_required"
  | "sod_blocked"
  | "stale"
  | "stale_schedule"
  | "step_settled"
  | "tenancy_archived"
  | "tenancy_vacated"
  | "try_again";

const STATUS: Record<RentReviewErrorCode, number> = {
  approval_level: 403,
  bad_request: 400,
  basis_incomplete: 422,
  changed_since_apply: 409,
  cpi_base_mismatch: 422,
  earlier_review_pending: 422,
  forbidden: 403,
  invalid_state: 409,
  manual_required: 400,
  method_not_supported: 422,
  next_review_in_progress: 409,
  no_change: 400,
  no_current_rent: 422,
  no_user: 422,
  not_calculated: 409,
  not_found: 404,
  not_representable: 422,
  not_revertible: 409,
  not_signed_off: 422,
  open_review_exists: 422,
  ratchet: 422,
  reason_required: 400,
  sod_blocked: 403,
  stale: 409,
  stale_schedule: 409,
  step_settled: 409,
  tenancy_archived: 422,
  tenancy_vacated: 422,
  try_again: 409,
};

export class RentReviewError extends Error {
  readonly code: RentReviewErrorCode;
  /** Extra fields for the response body: the current review on a stale write. */
  readonly details: Record<string, unknown>;
  /** A refused decision attempt the ledger records (sod_blocked, denied) once
   *  the transaction has rolled back. Never part of the response. */
  readonly refusal: LedgerEntryInput | null;
  readonly status: number;

  constructor(code: RentReviewErrorCode, message: string, details: Record<string, unknown> = {}, refusal: LedgerEntryInput | null = null) {
    super(message);
    this.name = "RentReviewError";
    this.code = code;
    this.details = details;
    this.refusal = refusal;
    this.status = STATUS[code];
  }
}

/** The 422 for a change to a review of an archived tenancy (D4): its reviews are
 *  history until the tenancy is restored. */
export function tenancyArchived(): RentReviewError {
  return new RentReviewError("tenancy_archived", "This tenancy has been archived, so its rent review can't be changed.");
}

/** The 409 for a write made on a stale read: the current review rides along so the screen can refresh. */
export function staleReview(row: SqlRow, today: string): RentReviewError {
  return new RentReviewError(
    "stale",
    "Someone else changed this review since you opened it. Reload to see their change.",
    { current: toReviewDto(row, today) },
  );
}

/** Writes a refused attempt's ledger row (sod_blocked, denied) after the
 *  decision's transaction rolled back, in a transaction of its own. Never throws. */
export async function recordReviewRefusal(connection: Connection | undefined, error: unknown): Promise<void> {
  if (!connection || !(error instanceof RentReviewError) || !error.refusal) return;
  await recordApart(connection, error.refusal, `refused ${error.code}`, "rent-review-refusal");
}

/** SQL Server chose this request as a deadlock's victim (1205) and rolled it back. */
export function isDeadlockVictim(error: unknown): boolean {
  return (error as { number?: unknown } | null)?.number === 1205;
}

const TRY_AGAIN_DEADLOCK =
  "Someone else was changing this tenancy at the same moment, so nothing was changed. Try again.";

/** A refusal as a response; a ledger refusal is a 400; a deadlock victim (two
 *  decisions on one tenancy at once: SQL Server rolled this one back whole) is a
 *  409 try_again; anything else a 500 that goes to Sentry. */
export function rentReviewErrorResponse(
  error: unknown,
  context: InvocationContext,
  name: string,
): HttpResponseInit {
  if (error instanceof RentReviewError) {
    return { jsonBody: { code: error.code, error: error.message, ...error.details }, status: error.status };
  }
  if (isDeadlockVictim(error)) {
    context.warn(`${name}: deadlock victim, rolled back; the caller is asked to try again`);
    return { jsonBody: { code: "try_again", error: TRY_AGAIN_DEADLOCK }, status: 409 };
  }
  const refusal = ledgerRefusal(error);
  if (refusal) return refusal;
  const message = error instanceof Error ? error.message : String(error);
  context.error(`${name} failed:`, message);
  return errorResponse(`${name} failed`, error);
}

/** A JSON object body, or a bad_request. */
export async function readJsonObject(request: HttpRequest): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new RentReviewError("bad_request", "The request body must be JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RentReviewError("bad_request", "The request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function readReviewId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!REVIEW_ID_RE.test(id)) throw new RentReviewError("bad_request", "reviewId is required");
  return id;
}

/** The RowVersion the caller read, lower-cased. */
export function readRowVersion(value: unknown): string {
  if (typeof value !== "string" || !ROW_VERSION_RE.test(value.trim())) {
    throw new RentReviewError("bad_request", "rowVersion is required: send back the one you were given");
  }
  return value.trim().toLowerCase();
}

export function readReason(value: unknown, missing = "Say why (a reason is required)"): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RentReviewError("reason_required", missing);
  }
  const reason = value.trim();
  if (reason.length > REASON_MAX_CHARS) {
    throw new RentReviewError("bad_request", `reason can be at most ${REASON_MAX_CHARS} characters`);
  }
  return reason;
}

export interface Caller {
  actor: Extract<LedgerActor, { kind: "user" }>;
  roles: string[];
}

/** The signed-in caller as a ledger actor and their roles; null when the token doesn't verify. */
export async function resolveCaller(request: HttpRequest, connection: Connection): Promise<Caller | null> {
  const actor = await resolveLedgerActor(request, connection);
  if (!actor || actor.kind !== "user") return null;
  return { actor, roles: await rolesForRequest(request) };
}
