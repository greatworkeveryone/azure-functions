// What the rent review endpoints share: the role lists, the request readers and
// the one error type that becomes a response.
//
// Responses are camelCase JSON, like the escalation endpoints. Writes are POSTs
// with a JSON body; reads are GETs.

import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { AppRole, errorResponse, rolesForRequest } from "../auth";
import type { SqlRow } from "../db";
import type { LedgerActor } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
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

export const REASON_MAX_CHARS = 2000;
const REVIEW_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const ROW_VERSION_RE = /^[0-9a-f]{16}$/i;

export type RentReviewErrorCode =
  | "bad_request"
  | "forbidden"
  | "invalid_state"
  | "no_change"
  | "no_user"
  | "not_found"
  | "open_review_exists"
  | "reason_required"
  | "stale"
  | "tenancy_vacated";

const STATUS: Record<RentReviewErrorCode, number> = {
  bad_request: 400,
  forbidden: 403,
  invalid_state: 409,
  no_change: 400,
  no_user: 422,
  not_found: 404,
  open_review_exists: 422,
  reason_required: 400,
  stale: 409,
  tenancy_vacated: 422,
};

export class RentReviewError extends Error {
  readonly code: RentReviewErrorCode;
  /** Extra fields for the response body: the current review on a stale write. */
  readonly details: Record<string, unknown>;
  readonly status: number;

  constructor(code: RentReviewErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "RentReviewError";
    this.code = code;
    this.details = details;
    this.status = STATUS[code];
  }
}

/** The 409 for a write made on a stale read: the current review rides along so the screen can refresh. */
export function staleReview(row: SqlRow, today: string): RentReviewError {
  return new RentReviewError(
    "stale",
    "Someone else changed this review since you opened it. Reload to see their change.",
    { current: toReviewDto(row, today) },
  );
}

/** A refusal as a response; a ledger refusal is a 400, anything else a 500 that goes to Sentry. */
export function rentReviewErrorResponse(
  error: unknown,
  context: InvocationContext,
  name: string,
): HttpResponseInit {
  if (error instanceof RentReviewError) {
    return { jsonBody: { code: error.code, error: error.message, ...error.details }, status: error.status };
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

export function readReason(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new RentReviewError("reason_required", "Say why (a reason is required)");
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
