// Who a decision request is sent to (jobs plan A1, decision D4): the people named,
// or everyone in a role, checked against the people who can actually be asked.
// Pure: the caller passes the active directory.

import { normaliseRole, roleLabel, ROLES } from "../escalation/roles";
import type { DirectoryUser } from "../escalation/types";
import { RequestError, roleNotAskable, type DecisionMakersInput } from "./request";
import { ADMIN_DOES_NOT_DECIDE, DECISION_MAKER_ROLES } from "./roles";

export interface ResolvedMakers {
  /** The people it goes to, in the order asked (named) or by name (a role). */
  people: DirectoryUser[];
  /** Set when everyone in a role was asked. */
  role: string | null;
  userIds: number[];
}

const names = (users: readonly DirectoryUser[]): string => users.map((user) => user.name).join(", ");

/**
 * The people a request goes to, or a RequestError (422) saying who can't be asked
 * and why. Never the person asking, who would only be asking themselves; a role
 * request leaves the asker out and needs somebody else in the role.
 */
export function resolveDecisionMakers(
  input: DecisionMakersInput,
  directory: readonly DirectoryUser[],
  requesterUserId: number | null,
): ResolvedMakers {
  if (input.mode === "role") {
    // The role may come from a row saved before admin could not be asked (a
    // deferred question coming back, reask.ts), not only from a request just read.
    const role = normaliseRole(input.role);
    const notAskable = roleNotAskable(role);
    if (notAskable) throw notAskable;
    const members = directory
      .filter((user) => normaliseRole(user.role) === role && user.userId !== requesterUserId)
      .sort((a, b) => a.name.localeCompare(b.name) || a.userId - b.userId);
    if (members.length === 0) {
      throw new RequestError("role_has_no_one", `There is nobody else in the ${roleLabel(role)} role to ask.`, 422, { role });
    }
    return { people: members, role, userIds: members.map((user) => user.userId) };
  }

  const people: DirectoryUser[] = [];
  const unknown: number[] = [];
  for (const id of input.userIds) {
    const found = directory.find((user) => user.userId === id);
    if (found) people.push(found);
    else unknown.push(id);
  }
  if (unknown.length > 0) {
    throw new RequestError("decision_maker_unknown", `These people aren't active Floorplan users, so they can't be asked: ${unknown.map((id) => `#${id}`).join(", ")}.`, 422, { userIds: unknown });
  }
  if (requesterUserId !== null && people.some((user) => user.userId === requesterUserId)) {
    throw new RequestError("decision_maker_is_requester", "You can't ask yourself. Ask someone else, or a whole role.", 422, { userIds: [requesterUserId] });
  }
  // Admin can open the inbox but approves nothing real (decision 4), so it gets its own reason.
  const admins = people.filter((user) => normaliseRole(user.role) === ROLES.admin);
  if (admins.length > 0) {
    throw new RequestError("decision_maker_role_not_allowed", `${ADMIN_DOES_NOT_DECIDE}, so ${names(admins)} can't be asked. Ask someone else.`, 422, {
      userIds: admins.map((user) => user.userId),
    });
  }
  const cannot = people.filter((user) => !DECISION_MAKER_ROLES.includes(normaliseRole(user.role)));
  if (cannot.length > 0) {
    throw new RequestError(
      "decision_maker_role_not_allowed",
      `${names(cannot)} can't open Floorplan's escalation inbox, so a request to them would never be seen. Ask someone else.`,
      422,
      { userIds: cannot.map((user) => user.userId) },
    );
  }
  return { people, role: null, userIds: people.map((user) => user.userId) };
}
