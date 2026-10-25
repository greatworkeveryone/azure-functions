// Role knowledge for escalations: names, labels, the ladder's shape (PLAN §3.7
// Figure 2) and which roles sit above which. Pure; the strings are the AppRole
// values in auth.ts, kept here so this folder's pure modules need no imports.
//
//   Directors                       top tier
//   CFO                             invoices, POs, billing runs
//   Facilities manager | Accounts manager
//   Facilities staff   | Accounts staff
//
// Admin is IT oversight: it sees everything and is a target only for
// system.health, never an approver (D20).

export const ROLES = {
  accounts: "accounts",
  accountsManager: "accounts_manager",
  admin: "admin",
  cfo: "cfo",
  director: "director",
  facilities: "facilities",
  facilitiesManager: "facilities_manager",
  user: "user",
} as const;

const LABELS: Record<string, string> = {
  accounts: "Accounts",
  accounts_manager: "Accounts manager",
  admin: "Admin",
  cfo: "CFO",
  director: "Director",
  facilities: "Facilities",
  facilities_manager: "Facilities manager",
  user: "User",
};

export function normaliseRole(role: unknown): string {
  return typeof role === "string" ? role.trim().toLowerCase() : "";
}

/** "facilities_manager" -> "Facilities manager"; an unknown role is title-cased. */
export function roleLabel(role: string | null | undefined): string {
  const key = normaliseRole(role);
  if (!key) return "Nobody";
  const known = LABELS[key];
  if (known) return known;
  const spaced = key.replace(/_/g, " ");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/** PLAN §3.7 rule 2: the `raiser_manager` token, from the raiser's role. */
export function managerRoleFor(raiserRole: string | null | undefined): string {
  switch (normaliseRole(raiserRole)) {
    case ROLES.facilities:
      return ROLES.facilitiesManager;
    case ROLES.accounts:
      return ROLES.accountsManager;
    case ROLES.facilitiesManager:
    case ROLES.accountsManager:
      return ROLES.cfo;
    // cfo and admin go to a director; a director goes to the other directors
    // (the ladder drops the raiser). Anyone unknown also lands at the top.
    default:
      return ROLES.director;
  }
}

/** The roles a role's team view covers: its own and the roles below it. `null`
 *  means everything (director, admin); an empty list means no team view. */
export function teamRolesOf(role: string | null | undefined): readonly string[] | null {
  switch (normaliseRole(role)) {
    case ROLES.facilitiesManager:
      return [ROLES.facilitiesManager, ROLES.facilities];
    case ROLES.accountsManager:
      return [ROLES.accountsManager, ROLES.accounts];
    case ROLES.cfo:
      return [ROLES.cfo, ROLES.accountsManager, ROLES.facilitiesManager, ROLES.accounts, ROLES.facilities];
    case ROLES.director:
    case ROLES.admin:
      return null;
    default:
      return [];
  }
}

/** The union of the team views of several roles. null = everything. */
export function teamRolesOfAll(roles: readonly string[]): readonly string[] | null {
  const union = new Set<string>();
  for (const role of roles) {
    const team = teamRolesOf(role);
    if (team === null) return null;
    for (const member of team) union.add(member);
  }
  return [...union];
}

/** The Finance workspace's alerts are policies whose key starts with this. */
export const FINANCE_POLICY_PREFIX = "finance.";

/** Policy-key prefixes a role can see in full, whoever the escalation goes to.
 *  Oversight only: seeing an escalation never lets the role act on it. */
export function seenPolicyPrefixesOf(role: string | null | undefined): readonly string[] {
  switch (normaliseRole(role)) {
    case ROLES.cfo:
      return [FINANCE_POLICY_PREFIX];
    default:
      return [];
  }
}

/** The union of seenPolicyPrefixesOf over several roles. */
export function seenPolicyPrefixesOfAll(roles: readonly string[]): readonly string[] {
  return [...new Set(roles.flatMap((role) => seenPolicyPrefixesOf(role)))];
}

/** Whether a holder of `viewerRole` is above `targetRole` in the ladder, so can
 *  see escalations aimed at it (§3.7 visibility: "every role above the target"). */
export function isAbove(viewerRole: string, targetRole: string | null): boolean {
  const target = normaliseRole(targetRole);
  if (!target) return false;
  const team = teamRolesOf(viewerRole);
  if (team === null) return true;
  return normaliseRole(viewerRole) !== target && team.includes(target);
}
