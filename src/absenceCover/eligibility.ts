// Whether a person may be the cover for an item. Pure. A cover must hold the
// capability the item needs, must not be away themselves, and must be someone
// the item may go to at all:
//
//   - never admin for a real record (decision 4; the same adminRefusal the money
//     handlers use, so this follows it if it changes);
//   - never whoever raised or asked for it (separation of duties), and never the
//     person who added a quote (creatorRefusal; a director is exempt, decision 17);
//   - for money, only someone whose approval limit covers the amount, by the
//     approval-authority core (canApprove), so a cover is never asked to approve
//     what they could not.
//
// The reason comes back as a code, so the ledger and the manager's screen can say
// why a nominated cover was passed over.

import { ACTION_ROLES, rolesFor, type Capability } from "../action-roles";
import { canApprove } from "../approvalAuthority";
import { isAbove, normaliseRole } from "../escalation/roles";
import type { DirectoryUser } from "../escalation/types";
import { adminRefusal, creatorRefusal } from "../moneyRules";
import type { CoverContext, CoverItem } from "./types";

export type Ineligible =
  | "absent"
  | "admin"
  | "capability"
  | "creator"
  | "dormant"
  | "money_limit"
  | "owner"
  | "raiser";

export const INELIGIBLE_TEXT: Record<Ineligible, string> = {
  absent: "is away too",
  admin: "is admin, who approves nothing real",
  capability: "cannot do this kind of work",
  creator: "added it",
  dormant: "has not been seen signing in for weeks",
  money_limit: "has no authority for that amount",
  owner: "is the person who is away",
  raiser: "raised or asked for it",
};

/** Whether a role holds a capability in the single who-can-do-what table. Admin never does for cover. */
export function holdsCapability(role: string, capability: Capability): boolean {
  return rolesFor(ACTION_ROLES[capability]).some((allowed) => allowed === normaliseRole(role));
}

/** A role at or above the role an authority escalation is aimed at. */
function atOrAbove(role: string, minRole: string): boolean {
  const held = normaliseRole(role);
  return held === normaliseRole(minRole) || isAbove(held, minRole);
}

function moneyRefusal(item: CoverItem, person: DirectoryUser, context: CoverContext): Ineligible | null {
  const need = item.money;
  if (!need) return null;
  if (creatorRefusal(need.createdByName, { name: person.name, roles: [person.role] }, "quote")) return "creator";
  if (!context.moneyFacts) return "money_limit";
  const decision = canApprove(
    { email: person.email ?? undefined, roles: [person.role], userId: person.userId },
    { amount: need.amount ?? Number.NaN, buildingId: need.buildingId, subject: need.subject },
    context.moneyFacts,
  );
  return decision.allowed ? null : "money_limit";
}

/** Null when `person` may cover `item`; otherwise why not. */
export function ineligibleReason(item: CoverItem, person: DirectoryUser, context: CoverContext): Ineligible | null {
  if (person.userId === item.ownerUserId) return "owner";
  if (context.absentIds.has(person.userId)) return "absent";
  // Not away, but the trusted sign-in log has not seen them for its whole window: nobody can say they are in.
  if (context.dormantIds.has(person.userId)) return "dormant";
  if (adminRefusal([person.role], item.isTest)) return "admin";
  if (item.raisedByUserId !== null && item.raisedByUserId === person.userId) return "raiser";
  if (item.capability && !holdsCapability(person.role, item.capability)) return "capability";
  if (item.minRole && !atOrAbove(person.role, item.minRole)) return "capability";
  if (item.onlyIf && !item.onlyIf(person)) return "capability";
  return moneyRefusal(item, person, context);
}

/**
 * Whether anyone besides the owner is in and could take the item: then it is not
 * stranded. A shared queue (a quote awaiting approval) is only at risk when the
 * answer is no.
 */
export function someoneElseCanCover(item: CoverItem, context: CoverContext): boolean {
  return context.directory.some((person) => ineligibleReason(item, person, context) === null);
}
