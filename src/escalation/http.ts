// What the escalation endpoints share: who is asking, which roles may call what,
// reading request bodies, and turning engine errors into responses.
//
// The role lists mirror the frontend capabilities in command-centre
// src/constants/roles.ts (WP20): viewEscalations, raiseEscalation,
// viewTeamEscalations, viewAllEscalations. Change them together. They are the
// gate only; what a caller may do with a given escalation is permissions.ts.

import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { AppRole, errorResponse, rolesForRequest } from "../auth";
import { LedgerValidationError, type LedgerActor } from "../ledger";
import { resolveLedgerActor } from "../ledger/actor";
import { getAdapter } from "./adapters/registry";
import { toDto } from "./dto";
import { EscalationError } from "./errors";
import { canSee } from "./permissions";
import { getEscalationRow, listActiveUsers } from "./store";
import type { DirectoryUser, EscalationRow, Viewer } from "./types";

/** Anyone who works jobs or accounts: list, read, acknowledge, resolve, raise. */
export const ESCALATION_ROLES = [
  AppRole.ADMIN,
  AppRole.DIRECTOR,
  AppRole.CFO,
  AppRole.ACCOUNTS_APPROVAL,
  AppRole.ACCOUNTS,
  AppRole.FACILITIES_APPROVAL,
  AppRole.FACILITIES,
] as const;

/** The team view: managers and the CFO (director and admin pass through the hierarchy). */
export const TEAM_ESCALATION_ROLES = [AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO] as const;

/** Everything: directors (admin passes through the hierarchy). */
export const ALL_ESCALATION_ROLES = [AppRole.DIRECTOR] as const;

export interface Caller {
  actor: Extract<LedgerActor, { kind: "user" }>;
  viewer: Viewer;
}

/** The signed-in caller as a ledger actor and a viewer; null when the token doesn't verify. */
export async function resolveCaller(request: HttpRequest, connection: Connection): Promise<Caller | null> {
  const actor = await resolveLedgerActor(request, connection);
  if (!actor || actor.kind !== "user") return null;
  const roles = await rolesForRequest(request);
  return { actor, viewer: { name: actor.name, roles, userId: actor.userId } };
}

/** A JSON object body, or an EscalationError(bad_request). */
export async function readBody(request: HttpRequest): Promise<Record<string, unknown>> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new EscalationError("bad_request", "The request body must be JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new EscalationError("bad_request", "The request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

export function readEscalationId(source: unknown): number {
  const id = typeof source === "string" && /^\d{1,15}$/.test(source) ? Number(source) : source;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw new EscalationError("bad_request", "escalationId is required");
  }
  return id;
}

export function readRowVersion(body: Record<string, unknown>): string {
  const version = body.rowVersion;
  if (typeof version !== "string" || version.trim() === "") {
    throw new EscalationError("bad_request", "rowVersion is required: send back the one you were given");
  }
  return version.trim();
}

export function readOptionalText(value: unknown, field: string, maxChars: number): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new EscalationError("bad_request", `${field} must be text`);
  const text = value.trim();
  if (text.length > maxChars) throw new EscalationError("bad_request", `${field} can be at most ${maxChars} characters`);
  return text === "" ? null : text;
}

export function readOptionalUserId(value: unknown, field: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const id = typeof value === "string" && /^\d{1,10}$/.test(value) ? Number(value) : value;
  if (typeof id !== "number" || !Number.isSafeInteger(id) || id < 1) {
    throw new EscalationError("bad_request", `${field} must be a user id`);
  }
  return id;
}

/** The escalation, if it exists and the caller may see it. Anything else is a 404,
 *  so an escalation the caller may not see doesn't reveal itself. */
export async function loadVisibleRow(
  connection: Connection,
  caller: Caller,
  escalationId: number,
): Promise<{ directory: DirectoryUser[]; row: EscalationRow }> {
  const row = await getEscalationRow(connection, escalationId);
  const directory = await listActiveUsers(connection);
  if (!row) throw new EscalationError("not_found", "That escalation doesn't exist");
  const raiserRole = directory.find((user) => user.userId === row.raisedByUserId)?.role ?? null;
  const adapter = getAdapter(row.subjectType);
  if (!canSee(caller.viewer, row, raiserRole) || (adapter && !adapter.visibleTo(caller.viewer, row))) {
    throw new EscalationError("not_found", "That escalation doesn't exist");
  }
  return { directory, row };
}

/**
 * An engine error as a response: its status, its message, a stable `code`, and
 * any detail (a stale write carries the current escalation so the screen can
 * show what changed). Ledger refusals are 400; anything else is a 500 that goes
 * to Sentry.
 */
export function escalationErrorResponse(
  error: unknown,
  context: InvocationContext,
  name: string,
  caller?: Caller,
  directory: readonly DirectoryUser[] = [],
): HttpResponseInit {
  if (error instanceof EscalationError) {
    const { current, ...details } = error.details;
    return {
      status: error.status,
      jsonBody: {
        code: error.code,
        error: error.message,
        ...details,
        ...(current && caller ? { current: toDto(current as EscalationRow, caller.viewer, new Date(), directory) } : {}),
      },
    };
  }
  if (error instanceof LedgerValidationError) {
    return { status: 400, jsonBody: { error: error.message } };
  }
  const message = error instanceof Error ? error.message : String(error);
  context.error(`${name} failed:`, message);
  return errorResponse(`${name} failed`, error);
}
