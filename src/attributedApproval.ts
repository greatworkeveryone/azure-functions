// R2 attributed quote approval: held OFF until Connor lifts beta-sprint
// decisions 1 and 9 (review 117). With ATTRIBUTED_APPROVAL_ENABLED unset, or
// anything but "true", plain facilities can't press Approve on a quote and any
// attribution sent with an approval is ignored, exactly as before 117.
//
// When it is on, the person named must be a manager in their own right
// (facilities_manager, accounts_manager, cfo or director): an accounts clerk's
// own $5,000 row doesn't make them the manager who agreed, and admin never
// counts (decision 4).

export const ATTRIBUTED_APPROVAL_SWITCH = "ATTRIBUTED_APPROVAL_ENABLED";

export function attributedApprovalEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ATTRIBUTED_APPROVAL_SWITCH] === "true";
}

/** The roles a named manager may hold. Everything else they hold is ignored. */
export const NAMEABLE_ROLES: readonly string[] = Object.freeze(["facilities_manager", "accounts_manager", "cfo", "director"]);

/** A named person's roles, keeping only the ones that make them a manager who can agree. */
export function nameableRoles(roles: readonly string[]): string[] {
  return roles.map((role) => role.trim().toLowerCase()).filter((role) => NAMEABLE_ROLES.includes(role));
}

/**
 * For a J4 gate (ACTION_ROLES): keeps its `conditional` roles only while the
 * switch is on, so with it off they get the 403 they got before 117.
 */
export function unlessHeldOff(entry: { conditional?: readonly string[] }, env: NodeJS.ProcessEnv = process.env): (role: string) => boolean {
  const held = attributedApprovalEnabled(env) ? [] : (entry.conditional ?? []);
  return (role) => !held.includes(role);
}
