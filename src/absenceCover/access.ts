// Who is asking, and whose cover they may arrange. The routes' role gates are in
// action-roles.ts (viewAbsenceCover, manageAbsenceCover, viewLeave); what a caller may
// do with one person's work or nominations is decided here.

import type { HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import type { Connection } from "tedious";
import { errorResponse } from "../auth";
import { resolveCaller } from "../escalation/http";
import { normaliseRole, ROLES, teamRolesOfAll } from "../escalation/roles";
import { coverMode, type CoverMode } from "./config";
import { CoverError, coverError } from "./errors";

export interface CoverCaller {
  name: string;
  roles: string[];
  userId: number;
}

/** The signed-in person with an active staff record, or a CoverError. */
export async function requireCoverCaller(request: HttpRequest, connection: Connection): Promise<CoverCaller> {
  const caller = await resolveCaller(request, connection);
  if (!caller) throw new CoverError("unauthorized", "Sign in again to continue.", 401);
  if (caller.actor.userId === null) throw coverError.refused("no_staff_record", "An active staff record is required.");
  return { name: caller.actor.name, roles: caller.viewer.roles.map(normaliseRole), userId: caller.actor.userId };
}

/** Admin looks after Floorplan and arranges nobody's work or cover (decision 4). */
export const isAdminOnly = (caller: CoverCaller): boolean => caller.roles.includes(ROLES.admin) && !caller.roles.some((role) => role !== ROLES.admin && role !== ROLES.user);

/** Whether a manager's team view takes in a person of this role (directors and the CFO's view are wider). */
export function inTeamOf(caller: CoverCaller, role: string): boolean {
  if (isAdminOnly(caller)) return false;
  const team = teamRolesOfAll(caller.roles);
  return team === null || team.includes(normaliseRole(role));
}

/** Manager taps move or keep items only while the engine is live: off and dry run move nothing. */
export function requireLive(mode: CoverMode = coverMode()): void {
  if (mode !== "live") throw coverError.switchedOff();
}

export function coverErrorResponse(error: unknown, context: InvocationContext, name: string): HttpResponseInit {
  if (error instanceof CoverError) return { jsonBody: { code: error.code, error: error.message }, status: error.status };
  context.error(`${name} failed:`, error instanceof Error ? error.message : String(error));
  return errorResponse(`${name} failed`, error);
}
