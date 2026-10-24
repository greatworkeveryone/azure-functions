// Reply-to identities and who may use them (EB1, PLAN §13).
//
// Mail goes out from the one shared sender; the reply-to is chosen per send. A person may
// choose an active identity whose allowed roles include one of theirs, or their own
// address when it is on the company domain. Anything else is refused. Pure: the caller
// loads the identity the request names and passes it in.

import { AppRole, rolesPassGate } from "../auth";
import { ORG_DOMAIN } from "./config";
import type { Signature } from "./signature";

export interface CommsIdentity {
  address: string;
  allowedRoles: AppRole[];
  archivedAt: string | null;
  displayName: string;
  identityId: number;
  isActive: boolean;
  signature: Signature;
  teamLabel: string | null;
}

/** Roles an identity may name. `user` is the baseline everybody holds and `admin` approves and sends nothing real. */
export const IDENTITY_ROLES: readonly AppRole[] = [
  AppRole.ACCOUNTS,
  AppRole.ACCOUNTS_APPROVAL,
  AppRole.CFO,
  AppRole.DIRECTOR,
  AppRole.FACILITIES,
  AppRole.FACILITIES_APPROVAL,
];

export type ReplyToChoice = { identityId: number; kind: "identity" } | { kind: "own" };

export interface ReplyToActor {
  email: string;
  name: string;
  roles: readonly string[];
}

export interface ResolvedReplyTo {
  address: string;
  identity: CommsIdentity | null;
  name: string;
}

export type Resolved = { ok: true; value: ResolvedReplyTo } | { error: string; ok: false; status: 403 | 404 };

/** An address on the company domain: one `@`, a plain local part, the domain exactly. */
export function isOrgAddress(address: string): boolean {
  const lower = address.trim().toLowerCase();
  const at = lower.lastIndexOf("@");
  if (at <= 0 || lower.indexOf("@") !== at) return false;
  return lower.slice(at + 1) === ORG_DOMAIN && /^[^\s,;:<>()"\\[\]]+$/.test(lower.slice(0, at));
}

/**
 * True when one of these roles is allowed to send as the identity. A manager counts as
 * the team they manage and a director as any operational role, as everywhere else
 * (rolesPassGate); admin counts only when the identity names it, and an identity cannot.
 */
export function mayUseIdentity(roles: readonly string[], identity: Pick<CommsIdentity, "allowedRoles">): boolean {
  const withoutAdmin = roles.filter((role) => role !== AppRole.ADMIN);
  return withoutAdmin.length > 0 && rolesPassGate(withoutAdmin, identity.allowedRoles);
}

export function resolveReplyTo(actor: ReplyToActor, choice: ReplyToChoice, identity: CommsIdentity | null): Resolved {
  if (choice.kind === "own") {
    if (!isOrgAddress(actor.email)) {
      return { error: `Your own address can only be used when it ends in @${ORG_DOMAIN}; choose a team address`, ok: false, status: 403 };
    }
    return { ok: true, value: { address: actor.email.trim().toLowerCase(), identity: null, name: actor.name } };
  }
  if (identity === null || identity.identityId !== choice.identityId) return { error: "That reply-to address isn't available", ok: false, status: 404 };
  if (!identity.isActive || identity.archivedAt !== null) return { error: "That reply-to address isn't available", ok: false, status: 403 };
  if (!mayUseIdentity(actor.roles, identity)) return { error: "You can't send on behalf of that address", ok: false, status: 403 };
  return { ok: true, value: { address: identity.address, identity, name: identity.displayName } };
}
