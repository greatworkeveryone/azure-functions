// Who is calling, for the comms routes: the verified token's identity (name, email, oid),
// the role from AppUsers, and the standing checks every route here shares. A route calls
// authorizeActor first; nothing below it reads an identity from the request body.

import type { HttpRequest, HttpResponseInit } from "@azure/functions";
import { AppRole, extractToken, forbiddenResponse, requireRole, rolesForRequest, unauthorizedResponse, verifiedIdentityFromRequest } from "../auth";
import { primaryRole } from "../ledger/actor";
import type { JobActor } from "./types";

export interface CommsActor extends JobActor {
  roles: string[];
}

export type ActorResult = { actor: CommsActor; ok: true; token: string } | { ok: false; response: HttpResponseInit };

/** Roles that may approve or cancel another person's send: the managers, the CFO and directors. Never admin. */
export const SEND_MANAGER_ROLES: readonly AppRole[] = [AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR, AppRole.FACILITIES_APPROVAL];

export const isSendManager = (roles: readonly string[]): boolean => roles.some((role) => (SEND_MANAGER_ROLES as readonly string[]).includes(role));

/**
 * Token present (401), role allowed (403, or 503 when the role lookup failed) and the identity verified.
 * `refused` roles pass the gate but are turned away here, with the reason a person can read.
 */
export async function authorizeActor(request: HttpRequest, gate: readonly AppRole[], refused: readonly AppRole[] = []): Promise<ActorResult> {
  const token = extractToken(request);
  if (!token) return { ok: false, response: unauthorizedResponse() };
  const denied = await requireRole(request, gate);
  if (denied) return { ok: false, response: denied };
  const identity = await verifiedIdentityFromRequest(request);
  if (!identity) return { ok: false, response: unauthorizedResponse() };
  const roles = await rolesForRequest(request);
  if (refused.length > 0 && roles.length > 0 && roles.every((role) => (refused as readonly string[]).includes(role))) {
    return { ok: false, response: forbiddenResponse("Admin accounts don't send or approve real email; use a staff account") };
  }
  return { actor: { email: identity.email, name: identity.name, oid: identity.oid, role: primaryRole(roles), roles }, ok: true, token };
}

export const badRequest = (error: string): HttpResponseInit => ({ jsonBody: { error }, status: 400 });
export const notFound = (error: string): HttpResponseInit => ({ jsonBody: { error }, status: 404 });
export const conflict = (error: string, extra: Record<string, unknown> = {}): HttpResponseInit => ({ jsonBody: { error, ...extra }, status: 409 });
export const forbidden = (error: string): HttpResponseInit => ({ jsonBody: { error }, status: 403 });
export const noStore = { "Cache-Control": "no-store" } as const;
