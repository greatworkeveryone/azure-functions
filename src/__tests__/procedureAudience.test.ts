/// <reference types="jest" />
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";
import { AppRole, rolesPassGate } from "../auth";
import { canReadProcedure } from "../procedureAudience";

// Who may read a procedure (beta sprint U4). The audience of a procedure is a
// list of roles, read through requireRole's hierarchy: a manager sees what is
// written for their officers, the CFO what is written for accounts, and admin
// and director see everything. The rule is one dependency-free file, identical
// in rpcc-functions src/procedureAudience.ts and command-centre
// src/helpers/procedureAudience.ts: its SHA-256 is pinned in both repos, and
// the vector block below is identical in both tests. Copy both across whole.

const RULE_SHA256 = "269e7320c3344308aad65ecd8239ac50bcdf8c6b238f0291c71d7264b7bdc68d";

// ═══ Shared vectors ══════════════════════════════════════════════════════════
type Vector = { audience: string[]; roles: string[]; sees: boolean; why: string };
const VECTORS: Vector[] = [
  { audience: ["all"], roles: ["user"], sees: true, why: "all is every signed-in user" },
  { audience: ["all"], roles: ["facilities"], sees: true, why: "all is every signed-in user" },
  { audience: ["all"], roles: [], sees: true, why: "the endpoint's own gate refuses a caller with no role; the rule does not" },
  { audience: ["facilities"], roles: ["facilities"], sees: true, why: "the officer it is written for" },
  { audience: ["facilities"], roles: ["facilities_manager"], sees: true, why: "a manager sees officer procedures" },
  { audience: ["facilities"], roles: ["accounts"], sees: false, why: "another team" },
  { audience: ["facilities"], roles: ["accounts_manager"], sees: false, why: "another team's manager" },
  { audience: ["facilities"], roles: ["cfo"], sees: false, why: "the CFO sits on the accounts ladder only" },
  { audience: ["facilities"], roles: ["user"], sees: false, why: "the baseline role reads only what is for all or for user" },
  { audience: ["facilities"], roles: ["director"], sees: true, why: "director sees all" },
  { audience: ["facilities"], roles: ["admin"], sees: true, why: "admin sees all" },
  { audience: ["accounts"], roles: ["accounts"], sees: true, why: "the officer it is written for" },
  { audience: ["accounts"], roles: ["accounts_manager"], sees: true, why: "a manager sees officer procedures" },
  { audience: ["accounts"], roles: ["cfo"], sees: true, why: "the CFO satisfies any accounts audience" },
  { audience: ["accounts"], roles: ["facilities_manager"], sees: false, why: "another team's manager" },
  { audience: ["accounts_manager"], roles: ["accounts"], sees: false, why: "an officer does not see what is written for managers" },
  { audience: ["accounts_manager"], roles: ["accounts_manager"], sees: true, why: "the manager it is written for" },
  { audience: ["accounts_manager"], roles: ["cfo"], sees: true, why: "the CFO satisfies the accounts manager audience" },
  { audience: ["facilities_manager"], roles: ["facilities"], sees: false, why: "an officer does not see what is written for managers" },
  { audience: ["facilities_manager"], roles: ["facilities_manager"], sees: true, why: "the manager it is written for" },
  { audience: ["cfo"], roles: ["accounts_manager"], sees: false, why: "a manager does not see what is written for the CFO" },
  { audience: ["cfo"], roles: ["cfo"], sees: true, why: "the CFO it is written for" },
  { audience: ["director"], roles: ["cfo"], sees: false, why: "the CFO is below a director" },
  { audience: ["director"], roles: ["facilities_manager"], sees: false, why: "a manager is below a director" },
  { audience: ["director"], roles: ["director"], sees: true, why: "the director it is written for" },
  { audience: ["admin"], roles: ["director"], sees: true, why: "director sees all, an admin-only procedure included" },
  { audience: ["admin"], roles: ["cfo"], sees: false, why: "only admin and director see an admin-only procedure" },
  { audience: ["admin"], roles: ["admin"], sees: true, why: "the admin it is written for" },
  { audience: ["user"], roles: ["facilities"], sees: true, why: "user is any assigned role" },
  { audience: ["user"], roles: [], sees: false, why: "no role is no audience" },
  { audience: ["facilities", "accounts"], roles: ["facilities_manager"], sees: true, why: "any entry of the audience will do" },
  { audience: ["facilities", "accounts"], roles: ["accounts_manager"], sees: true, why: "any entry of the audience will do" },
  { audience: ["facilities", "accounts"], roles: ["cfo"], sees: true, why: "any entry of the audience will do" },
  { audience: ["facilities", "accounts"], roles: ["user"], sees: false, why: "neither team" },
  { audience: ["accounts"], roles: ["facilities", "accounts_manager"], sees: true, why: "a person with several roles sees what any of them sees" },
  { audience: ["accounts"], roles: ["facilities", "user"], sees: false, why: "none of several roles is on the accounts ladder" },
  { audience: [], roles: ["facilities_manager"], sees: false, why: "an empty audience is for nobody but admin and director" },
  { audience: [], roles: ["director"], sees: true, why: "director sees all" },
  { audience: [], roles: ["admin"], sees: true, why: "admin sees all" },
  { audience: ["hacker"], roles: ["accounts_manager"], sees: false, why: "an audience entry that is not a role grants nothing" },
  { audience: ["hacker"], roles: ["director"], sees: true, why: "director sees all" },
];
// ═════════════════════════════════════════════════════════════════════════════

describe("canReadProcedure", () => {
  it.each(VECTORS)("$audience read by $roles is $sees: $why", ({ audience, roles, sees }) => {
    expect(canReadProcedure(roles, audience)).toBe(sees);
  });

  it("is the one file in both repos: its bytes are pinned", () => {
    const file = readFileSync(join(__dirname, "..", "procedureAudience.ts"));
    expect(createHash("sha256").update(file).digest("hex")).toBe(RULE_SHA256);
  });

  it("agrees with requireRole's hierarchy for every pair of roles, but for admin and director seeing all", () => {
    const roles = Object.values(AppRole);
    const mismatches: string[] = [];
    for (const audienceRole of roles) {
      for (const role of roles) {
        const sees = canReadProcedure([role], [audienceRole]);
        const hierarchy = rolesPassGate([role], [audienceRole]);
        const seesAll = role === AppRole.ADMIN || role === AppRole.DIRECTOR;
        if (sees !== (seesAll || hierarchy)) mismatches.push(`${role} reading ${audienceRole}: rule ${sees}, gate ${hierarchy}`);
      }
    }
    expect(mismatches).toEqual([]);
  });
});
