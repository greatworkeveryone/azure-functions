// Who may see and do what with an escalation (PLAN §3.7). Pure.
//
// Visibility: the people it goes to, the person who raised it, and every role
// above the target. A team view belongs to managers and the CFO, everything to
// directors and admin. The CFO also sees every escalation whose policy key starts
// with finance., whoever it goes to; seeing grants no action. Acting: the people
// it goes to, plus directors and admin as oversight; never the raiser (an
// escalation is never its own target), who can still withdraw it or push it
// further up.
//
// The inbox query (store.ts buildListWhere) expresses the same visibility in
// SQL; keep the two in step.

import { isDecisionRow, namedTargetIds } from "./decisionRows";
import { EscalationError } from "./errors";
import { isAbove, normaliseRole, ROLES, seenPolicyPrefixesOfAll, teamRolesOfAll } from "./roles";
import type { EscalationRow, Viewer } from "./types";

const OVERSIGHT: ReadonlySet<string> = new Set([ROLES.director, ROLES.admin]);

const rolesOf = (viewer: Viewer): string[] => viewer.roles.map(normaliseRole).filter(Boolean);

export const isOversight = (viewer: Viewer): boolean => rolesOf(viewer).some((role) => OVERSIGHT.has(role));

export const isAdmin = (viewer: Viewer): boolean => rolesOf(viewer).includes(ROLES.admin);

export function isRaiser(viewer: Viewer, row: Pick<EscalationRow, "raisedByUserId">): boolean {
  return viewer.userId !== null && row.raisedByUserId === viewer.userId;
}

/** Whether the viewer is one of the several named people a row goes to. */
const isNamedTarget = (viewer: Viewer, row: Pick<EscalationRow, "context" | "noIndependentTarget" | "targetRole">): boolean =>
  viewer.userId !== null && namedTargetIds(row).includes(viewer.userId);

/** Whether the viewer is one of the people the escalation goes to. */
export function isTargetOf(
  viewer: Viewer,
  row: Pick<EscalationRow, "context" | "noIndependentTarget" | "status" | "targetRole" | "targetUserId">,
): boolean {
  const roles = rolesOf(viewer);
  if (row.noIndependentTarget && roles.some((role) => OVERSIGHT.has(role))) return true;
  // Named: the raiser picked this person, or they acknowledged it.
  if (row.targetUserId !== null && viewer.userId === row.targetUserId) return true;
  // One of several named people (a decision request's), whoever has acknowledged it.
  if (isNamedTarget(viewer, row)) return true;
  const role = normaliseRole(row.targetRole);
  if (role === "" || !roles.includes(role)) return false;
  // At role level everyone in the role is a target until somebody is named by the
  // raiser. Once a colleague has acknowledged it, the others can still help.
  return row.targetUserId === null || row.status === "acknowledged";
}

/**
 * §3.7 visibility. `raiserRole` is the raiser's current role, which lets a
 * manager see what their own staff raised; leave it out and that part is skipped.
 */
export function canSee(viewer: Viewer, row: EscalationRow, raiserRole?: string | null): boolean {
  if (isOversight(viewer)) return true;
  if (isRaiser(viewer, row)) return true;
  if (viewer.userId !== null && row.targetUserId === viewer.userId) return true;
  if (isNamedTarget(viewer, row)) return true;
  const roles = rolesOf(viewer);
  const target = normaliseRole(row.targetRole);
  if (target !== "" && roles.includes(target)) return true;
  if (roles.some((role) => isAbove(role, row.targetRole))) return true;
  // Oversight of a policy domain (the CFO and finance.). Keys are lower case; the
  // database compares them case-insensitively, so this does too.
  const policyKey = row.policyKey.toLowerCase();
  if (seenPolicyPrefixesOfAll(roles).some((prefix) => policyKey.startsWith(prefix))) return true;
  const team = teamRolesOfAll(roles);
  const raiser = normaliseRole(raiserRole);
  return team !== null && raiser !== "" && team.includes(raiser);
}

/** Acknowledge, resolve: the people it goes to, and oversight. Not the raiser. */
export function canAct(viewer: Viewer, row: EscalationRow): boolean {
  if (isRaiser(viewer, row)) return false;
  return isTargetOf(viewer, row) || isOversight(viewer);
}

/** The raiser takes it back (while open); admin can too. */
export function canWithdraw(viewer: Viewer, row: EscalationRow): boolean {
  return isRaiser(viewer, row) || isAdmin(viewer);
}

/** Push to the next level: whoever can act, or the raiser. */
export function canEscalateFurther(viewer: Viewer, row: EscalationRow): boolean {
  return canAct(viewer, row) || isRaiser(viewer, row);
}

export interface ActionAvailability {
  acknowledge: boolean;
  escalateFurther: boolean;
  resolve: boolean;
  withdraw: boolean;
}

/** What the viewer can do with this row right now, for the inbox's buttons. */
export function availableActions(viewer: Viewer, row: EscalationRow): ActionAvailability {
  const live = row.status === "open" || row.status === "acknowledged";
  return {
    // A decision request is answered, not acknowledged (engine.acknowledge refuses it).
    acknowledge: live && row.status === "open" && !isDecisionRow(row) && canAct(viewer, row),
    escalateFurther: live && canEscalateFurther(viewer, row),
    // Authority escalations end with the decision on the subject.
    resolve: live && row.kind === "attention" && canAct(viewer, row),
    // A decision request is withdrawn from the request, which ends this too.
    withdraw: row.status === "open" && !isDecisionRow(row) && canWithdraw(viewer, row),
  };
}

export function assertCan(allowed: boolean, message: string): void {
  if (!allowed) throw new EscalationError("forbidden", message);
}
