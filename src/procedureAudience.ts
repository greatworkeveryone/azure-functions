// Who may read a procedure (beta sprint U4).
//
// A procedure's audience is a list of roles, or "all". It is read through the
// same hierarchy requireRole applies, so the team a document is written for
// includes the people above them: a manager sees what is written for their
// officers, the CFO what is written for accounts, and admin and director see
// everything, an admin-only document included.
//
// This file has no imports and is byte for byte the same in rpcc-functions
// (src/procedureAudience.ts) and command-centre (src/helpers/procedureAudience.ts).
// Both repos pin its SHA-256 in a test that also carries the same table of
// vectors, so a change to one copy fails until the other has the same bytes.

/** For each audience entry, the roles that satisfy it: requireRole's hierarchy (auth.ts rolesPassGate) spelled out. */
const SATISFIED_BY: Readonly<Record<string, readonly string[]>> = {
  accounts: ["accounts", "accounts_manager", "cfo"],
  accounts_manager: ["accounts_manager", "cfo"],
  admin: ["admin"],
  cfo: ["cfo"],
  director: ["director"],
  facilities: ["facilities", "facilities_manager"],
  facilities_manager: ["facilities_manager"],
};

export function canReadProcedure(roles: readonly string[], audience: readonly string[]): boolean {
  if (audience.includes("all")) return true;
  if (roles.includes("admin") || roles.includes("director")) return true;
  return audience.some((entry) =>
    entry === "user" ? roles.length > 0 : (SATISFIED_BY[entry] ?? []).some((role) => roles.includes(role)),
  );
}
