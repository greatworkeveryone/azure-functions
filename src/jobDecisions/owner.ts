// Who a next step is handed to (jobs plan A2): a person, a role, or by default the
// person who raised the job. Pure: the caller passes the active directory and, for the
// default, the creator it has already found. The same people-checks as asking for a
// decision (people.ts): the person must be active and able to open the escalation
// inbox, where the step lands.

import { normaliseRole, roleLabel } from "../escalation/roles";
import type { LadderRaiser } from "../escalation/decisionRows";
import type { DirectoryUser } from "../escalation/types";
import type { NextStepOwnerInput } from "./respond";
import { RequestError } from "./request";
import { NEXT_STEP_OWNER_ROLES } from "./roles";

export interface ResolvedOwner {
  kind: "user" | "role";
  /** Whose manager the ladder's second level is. */
  ladder: LadderRaiser;
  /** The people told: the person, or everyone in the role now. */
  members: DirectoryUser[];
  /** The person's name, or the role's label. */
  name: string;
  /** Set for a role. */
  role: string | null;
  /** Set for a person. */
  userId: number | null;
}

const byName = (a: DirectoryUser, b: DirectoryUser): number => a.name.localeCompare(b.name) || a.userId - b.userId;

function person(user: DirectoryUser): ResolvedOwner {
  return {
    kind: "user",
    ladder: { role: normaliseRole(user.role), userId: user.userId },
    members: [user],
    name: user.name,
    role: null,
    userId: user.userId,
  };
}

/**
 * The owner of a next step, or a RequestError (422) saying why not. `creator` is the
 * active user who raised the job, if they can still be found: the default owner.
 */
export function resolveNextStepOwner(
  input: NextStepOwnerInput | null,
  directory: readonly DirectoryUser[],
  creator: DirectoryUser | null,
): ResolvedOwner {
  if (input === null) {
    if (creator === null) {
      throw new RequestError(
        "next_step_owner_required",
        "Say who does the next step: the person who raised this job can't be found among Floorplan's active users.",
        422,
      );
    }
    return checked(creator);
  }

  if (input.kind === "user") {
    const found = directory.find((user) => user.userId === input.userId);
    if (!found) {
      throw new RequestError("next_step_owner_unknown", `#${input.userId} isn't an active Floorplan user, so the step can't be handed to them.`, 422, {
        userId: input.userId,
      });
    }
    return checked(found);
  }

  const members = directory.filter((user) => normaliseRole(user.role) === input.role).sort(byName);
  if (members.length === 0) {
    throw new RequestError("next_step_owner_role_empty", `There is nobody in the ${roleLabel(input.role)} role to hand the step to.`, 422, { role: input.role });
  }
  return {
    kind: "role",
    ladder: { role: input.role, userId: null },
    members,
    name: roleLabel(input.role),
    role: input.role,
    userId: null,
  };
}

function checked(user: DirectoryUser): ResolvedOwner {
  if (!NEXT_STEP_OWNER_ROLES.includes(normaliseRole(user.role))) {
    throw new RequestError(
      "next_step_owner_role_not_allowed",
      `${user.name} can't open Floorplan's escalation inbox, so a step handed to them would never be seen. Hand it to someone else.`,
      422,
      { userId: user.userId },
    );
  }
  return person(user);
}
