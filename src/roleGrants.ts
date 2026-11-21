// SECA-02 / D5: granting director, cfo or admin takes a second person.
//
// A request is recorded as pending (dbo.PendingRoleGrants, migration 195); the person keeps their
// previous role until a different director or admin, who is also not the person being granted,
// confirms it. PRIVILEGED_GRANT_TWO_PERSON switches this off while one admin is all there is: anything
// other than "false" means on. The health report says which.

import { AppRole } from "./auth";

export const PRIVILEGED_ROLES: ReadonlySet<string> = new Set([AppRole.ADMIN, AppRole.DIRECTOR, AppRole.CFO]);

export function twoPersonGrantEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.PRIVILEGED_GRANT_TWO_PERSON ?? "").trim().toLowerCase() !== "false";
}

/** A move to director, cfo or admin from a different role is the one that needs a second person. */
export function needsSecondPerson(oldRole: string | null, newRole: string | null | undefined, enabled: boolean = twoPersonGrantEnabled()): boolean {
  return enabled && typeof newRole === "string" && PRIVILEGED_ROLES.has(newRole) && newRole !== oldRole;
}

export type GrantDecision = "confirm" | "decline" | "withdraw";

export interface GrantFacts {
  requestedByOid: string;
  targetOid: string | null;
}

/** Why this caller may not make this decision, or null. Confirm and decline: a director or admin who is neither the requester nor the person granted. Withdraw: the requester. */
export function grantDecisionRefusal(decision: GrantDecision, callerOid: string, callerRoles: readonly string[], grant: GrantFacts): string | null {
  if (decision === "withdraw") return callerOid === grant.requestedByOid ? null : "Only the person who asked can withdraw this.";
  if (!callerRoles.includes(AppRole.ADMIN) && !callerRoles.includes(AppRole.DIRECTOR)) return "Only a director or an admin can confirm a role.";
  if (callerOid === grant.requestedByOid) return "A second person has to confirm this: you asked for it.";
  if (grant.targetOid !== null && callerOid === grant.targetOid) return "You can't confirm a role for yourself.";
  return null;
}
