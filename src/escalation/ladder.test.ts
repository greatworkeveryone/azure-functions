/// <reference types="jest" />
import { describeTarget, expandLadder, LadderError, levelOfRole, resolveTarget, type ResolveInput } from "./ladder";
import { FINANCE_POLICY_PREFIX, isAbove, managerRoleFor, roleLabel, seenPolicyPrefixesOf, seenPolicyPrefixesOfAll, teamRolesOf, teamRolesOfAll } from "./roles";
import type { DirectoryUser, LadderEntry } from "./types";

const user = (userId: number, name: string, role: string, email: string | null = `${name.toLowerCase()}@example.com`): DirectoryUser => ({
  email,
  name,
  role,
  userId,
});

const ADAM = user(1, "Adam", "facilities_manager");
const BEA = user(2, "Bea", "facilities_manager");
const CAM = user(3, "Cam", "accounts_manager");
const JOH = user(4, "Joh", "cfo");
const DEE = user(5, "Dee", "director");
const ELI = user(6, "Eli", "director");
const ADA = user(7, "Ada", "admin");
const FAY = user(8, "Fay", "facilities");
const GUS = user(9, "Gus", "accounts");
const EVERYONE = [ADAM, BEA, CAM, JOH, DEE, ELI, ADA, FAY, GUS];

// The seeded ladders (migration 098 / PLAN §3.7).
const STALLED: LadderEntry[] = [
  { role: "facilities_manager", slaHours: 16 },
  { role: "director", slaHours: 16 },
];
const MANUAL: LadderEntry[] = [{ token: "raiser_manager", slaHours: 8 }, { role: "director", slaHours: 16 }];
const INVOICE: LadderEntry[] = [
  { role: "accounts_manager", slaHours: 16 },
  { role: "cfo", slaHours: 16 },
  { role: "director" },
];

const resolve = (overrides: Partial<ResolveInput> & Pick<ResolveInput, "ladder">) =>
  resolveTarget({ activeUsers: EVERYONE, kind: "attention", onNoTarget: "directors", ...overrides });

describe("rule 1: the first level with an eligible active user", () => {
  it("targets level 1 when it has people", () => {
    const target = resolve({ ladder: STALLED });

    expect(target).toMatchObject({ hasNextLevel: true, level: 1, noIndependentTarget: false, role: "facilities_manager", slaHours: 16 });
    expect(target?.users.map((u) => u.name)).toEqual(["Adam", "Bea"]);
    expect(target?.targetUserId).toBeNull();
    expect(target?.skippedLevels).toEqual([]);
  });

  it("skips an empty level", () => {
    const target = resolve({ activeUsers: [CAM, DEE, ELI], ladder: STALLED });

    expect(target).toMatchObject({ hasNextLevel: false, level: 2, role: "director" });
    expect(target?.users.map((u) => u.name)).toEqual(["Dee", "Eli"]);
    expect(target?.skippedLevels).toEqual([1]);
  });

  it("skips several empty levels in a row", () => {
    const target = resolve({ activeUsers: [ADAM, DEE], kind: "authority", ladder: INVOICE });

    expect(target).toMatchObject({ level: 3, role: "director", slaHours: null });
    expect(target?.skippedLevels).toEqual([1, 2]);
  });

  it("matches roles without regard to case or stray spaces", () => {
    const target = resolve({ activeUsers: [user(1, "Adam", " Facilities_Manager ")], ladder: STALLED });
    expect(target?.role).toBe("facilities_manager");
  });

  it("lists the people at a level by name", () => {
    const target = resolve({ activeUsers: [user(9, "Zed", "director"), user(3, "Amy", "director")], ladder: [{ role: "director" }] });
    expect(target?.users.map((u) => u.name)).toEqual(["Amy", "Zed"]);
  });

  it("starts at a later position when escalating further", () => {
    const target = resolve({ fromLevel: 2, ladder: STALLED });
    expect(target).toMatchObject({ level: 2, role: "director" });
  });

  it("reports that there is nowhere further to go when asked to", () => {
    expect(resolve({ fromLevel: 3, ladder: STALLED, onNoTarget: "none" })).toBeNull();
    expect(resolve({ activeUsers: [ADAM], fromLevel: 2, ladder: STALLED, onNoTarget: "none" })).toBeNull();
  });
});

describe("the raiser is never the target", () => {
  it("leaves the raiser out of their own level", () => {
    const target = resolve({ ladder: STALLED, raiser: { role: "facilities_manager", userId: ADAM.userId } });

    expect(target?.level).toBe(1);
    expect(target?.users.map((u) => u.name)).toEqual(["Bea"]);
  });

  it("moves to the next level when the raiser was the only person at theirs", () => {
    const target = resolve({ activeUsers: [ADAM, DEE], ladder: STALLED, raiser: { role: "facilities_manager", userId: ADAM.userId } });

    expect(target).toMatchObject({ level: 2, role: "director" });
    expect(target?.users.map((u) => u.name)).toEqual(["Dee"]);
    expect(target?.skippedLevels).toEqual([1]);
  });

  it("recognises the raiser by email when their id is unknown", () => {
    const target = resolve({ ladder: STALLED, raiser: { email: "ADAM@example.com", role: "facilities_manager", userId: null } });
    expect(target?.users.map((u) => u.name)).toEqual(["Bea"]);
  });

  it("sends a director's escalation to the other directors", () => {
    const target = resolve({ ladder: MANUAL, raiser: { role: "director", userId: DEE.userId } });

    expect(target).toMatchObject({ level: 1, noIndependentTarget: false, role: "director", source: "raiser_manager" });
    expect(target?.users.map((u) => u.name)).toEqual(["Eli"]);
  });
});

describe("rule 3: nobody independent to send it to", () => {
  it("aims a lone director's escalation at the directors and flags it", () => {
    const target = resolve({ activeUsers: [DEE, ADA, FAY], ladder: MANUAL, raiser: { role: "director", userId: DEE.userId } });

    expect(target).toMatchObject({ hasNextLevel: false, noIndependentTarget: true, role: "director", source: "no_independent_target" });
    expect(target?.users).toEqual([]);
  });

  it("flags a stalled-job style ladder when the only director is the raiser", () => {
    const target = resolve({ activeUsers: [DEE], ladder: STALLED, raiser: { role: "director", userId: DEE.userId } });

    expect(target).toMatchObject({ level: 2, noIndependentTarget: true, role: "director" });
  });

  it("flags an escalation when the whole ladder is empty, aiming at whichever directors exist", () => {
    const target = resolve({ activeUsers: [DEE, FAY], ladder: [{ role: "facilities_manager", slaHours: 4 }] });

    expect(target).toMatchObject({ noIndependentTarget: true, role: "director" });
    expect(target?.users.map((u) => u.name)).toEqual(["Dee"]);
  });

  it("keeps the SLA of the top level so the flagged row still has a clock", () => {
    const target = resolve({ activeUsers: [DEE], ladder: STALLED, raiser: { role: "director", userId: DEE.userId } });
    expect(target?.slaHours).toBe(16);
  });

  it("does not invent a director level when escalating further from the top", () => {
    expect(resolve({ activeUsers: [DEE], fromLevel: 2, ladder: STALLED, onNoTarget: "none", raiser: { role: "director", userId: DEE.userId } })).toBeNull();
  });
});

describe("rule 2: the raiser_manager token", () => {
  it.each([
    ["facilities", "facilities_manager"],
    ["accounts", "accounts_manager"],
    ["facilities_manager", "cfo"],
    ["accounts_manager", "cfo"],
    ["cfo", "director"],
    ["admin", "director"],
    ["director", "director"],
    ["user", "director"],
    [null, "director"],
  ])("a %s raiser goes to the %s", (raiserRole, expected) => {
    expect(managerRoleFor(raiserRole)).toBe(expected);
    const raiser = raiserRole ? { role: raiserRole, userId: 999 } : null;
    expect(resolve({ ladder: MANUAL, raiser })?.role).toBe(expected);
  });

  it("collapses the director level a director or CFO raiser would repeat", () => {
    expect(expandLadder(MANUAL, { raiserRole: "cfo" }).map((l) => l.role)).toEqual(["director"]);
    expect(expandLadder(MANUAL, { raiserRole: "director" }).map((l) => l.role)).toEqual(["director"]);
    expect(expandLadder(MANUAL, { raiserRole: "facilities" }).map((l) => l.role)).toEqual(["facilities_manager", "director"]);
  });

  it("walks facilities staff -> facilities manager -> director as escalation continues", () => {
    const raiser = { role: "facilities", userId: FAY.userId };
    const first = resolve({ ladder: MANUAL, raiser });
    const second = resolve({ fromLevel: (first?.level ?? 0) + 1, ladder: MANUAL, raiser });

    expect(first).toMatchObject({ level: 1, role: "facilities_manager", slaHours: 8 });
    expect(second).toMatchObject({ level: 2, role: "director", slaHours: 16 });
  });

  it("skips the manager level when there is no manager, whoever raised", () => {
    const target = resolve({ activeUsers: [FAY, DEE], ladder: MANUAL, raiser: { role: "facilities", userId: FAY.userId } });
    expect(target).toMatchObject({ level: 2, role: "director", skippedLevels: [1] });
  });
});

describe("authority escalations leave out whoever prepared the subject", () => {
  it("skips the level the preparer alone made up", () => {
    const target = resolve({ excludeUserIds: [CAM.userId], kind: "authority", ladder: INVOICE });

    expect(target).toMatchObject({ level: 2, role: "cfo" });
    expect(target?.skippedLevels).toEqual([1]);
  });

  it("keeps the other people at the preparer's level", () => {
    const another = user(10, "Dot", "accounts_manager");
    const target = resolve({ activeUsers: [...EVERYONE, another], excludeUserIds: [CAM.userId], kind: "authority", ladder: INVOICE });

    expect(target?.users.map((u) => u.name)).toEqual(["Dot"]);
  });

  it("does not apply to attention escalations", () => {
    const target = resolve({ excludeUserIds: [CAM.userId], kind: "attention", ladder: INVOICE });
    expect(target?.users.map((u) => u.name)).toEqual(["Cam"]);
  });
});

describe("rule 4: picking a person", () => {
  it("sets the target user when the raiser picks someone at the resolved level", () => {
    const target = resolve({ ladder: STALLED, preferredUserId: BEA.userId });

    expect(target?.targetUserId).toBe(BEA.userId);
    expect(target?.users.map((u) => u.name)).toEqual(["Adam", "Bea"]);
  });

  it("leaves the target user empty until someone acknowledges", () => {
    expect(resolve({ ladder: STALLED })?.targetUserId).toBeNull();
  });

  it("refuses a person who isn't at that level", () => {
    expect(() => resolve({ ladder: STALLED, preferredUserId: DEE.userId })).toThrow(LadderError);
    expect(() => resolve({ ladder: STALLED, preferredUserId: DEE.userId })).toThrow(/isn't at the level/);
  });

  it("refuses the raiser as their own target", () => {
    expect(() => resolve({ ladder: STALLED, preferredUserId: ADAM.userId, raiser: { role: "facilities_manager", userId: ADAM.userId } })).toThrow(
      expect.objectContaining({ code: "target_not_eligible" }),
    );
  });
});

describe("the env-list fallback", () => {
  const fallbackEmails = { facilities_manager: ["fm1@example.com", "Adam@Example.com"] };

  it("is used only where a role has no eligible active user", () => {
    const target = resolve({ activeUsers: [DEE], fallbackEmails, ladder: STALLED });

    expect(target).toMatchObject({ level: 1, role: "facilities_manager" });
    expect(target?.users).toEqual([]);
    expect(target?.fallbackEmails).toEqual(["fm1@example.com", "Adam@Example.com"]);
  });

  it("is ignored when an active facilities manager exists", () => {
    const target = resolve({ fallbackEmails, ladder: STALLED });
    expect(target?.fallbackEmails).toEqual([]);
    expect(target?.users.length).toBe(2);
  });

  it("leaves out the raiser's own address", () => {
    const target = resolve({ activeUsers: [DEE], fallbackEmails, ladder: STALLED, raiser: { email: "adam@example.com", role: "facilities", userId: 50 } });
    expect(target?.fallbackEmails).toEqual(["fm1@example.com"]);
  });

  it("does not make an empty list a target", () => {
    const target = resolve({ activeUsers: [DEE], fallbackEmails: { facilities_manager: [] }, ladder: STALLED });
    expect(target).toMatchObject({ level: 2, role: "director" });
  });
});

describe("WP21's seam: amount-based authority routes", () => {
  const ladder: LadderEntry[] = [{ token: "authority_route", slaHours: 16 }, { role: "director", slaHours: 16 }];
  const route = [
    { kind: "role", role: "accounts_manager" },
    { displayName: "Resident", kind: "user", userId: 42 },
    { kind: "role", role: "director" },
  ] as const;

  it("replaces the token with the route's steps and drops the repeated director", () => {
    expect(expandLadder(ladder, { authorityRoute: route }).map((l) => [l.position, l.role, l.userIds])).toEqual([
      [1, "accounts_manager", []],
      [2, null, [42]],
      [3, "director", []],
    ]);
  });

  it("targets a user step's person", () => {
    const resident = user(42, "Resident", "user");
    const target = resolve({ activeUsers: [resident, DEE], authorityRoute: route, fromLevel: 2, kind: "authority", ladder });

    expect(target).toMatchObject({ level: 2, targetUserId: 42 });
    expect(target?.users).toEqual([resident]);
  });

  it("skips the token when no route is passed", () => {
    expect(resolve({ kind: "authority", ladder })).toMatchObject({ level: 1, role: "director" });
  });
});

describe("userTarget entries", () => {
  it("target the person named when the escalation is raised", () => {
    const target = resolve({ ladder: [{ userTarget: true }], userTargets: [CAM.userId] });

    expect(target).toMatchObject({ role: "accounts_manager", source: "user_target", targetUserId: CAM.userId });
  });

  it("are skipped when nobody is named", () => {
    expect(resolve({ ladder: [{ userTarget: true }, { role: "director" }] })).toMatchObject({ level: 1, role: "director" });
  });
});

describe("bad ladders", () => {
  it("refuses a policy with no levels", () => {
    expect(() => resolve({ ladder: [] })).toThrow(expect.objectContaining({ code: "empty_ladder" }));
    expect(() => resolve({ ladder: [{ token: "authority_route" }] })).toThrow(LadderError);
  });

  it("treats a negative or missing SLA as none", () => {
    expect(expandLadder([{ role: "director", slaHours: -3 }, { role: "admin" }]).map((l) => l.slaHours)).toEqual([null, null]);
  });
});

describe("describeTarget", () => {
  it("reads like the dialog's preview", () => {
    expect(describeTarget(resolve({ activeUsers: [ADAM, DEE], ladder: STALLED })!)).toBe("Facilities manager (Adam)");
    expect(describeTarget(resolve({ ladder: STALLED })!)).toBe("Facilities manager (Adam, Bea)");
  });

  it("shortens a long list", () => {
    const many = ["A", "B", "C", "D", "E"].map((name, i) => user(100 + i, name, "director"));
    expect(describeTarget(resolve({ activeUsers: many, ladder: [{ role: "director" }] })!)).toBe("Director (A, B, C +2 more)");
  });

  it("names just the person who was picked", () => {
    expect(describeTarget(resolve({ ladder: STALLED, preferredUserId: BEA.userId })!)).toBe("Facilities manager (Bea)");
  });

  it("names the env-list addresses when there are no users", () => {
    const target = resolve({ activeUsers: [DEE], fallbackEmails: { facilities_manager: ["fm@example.com"] }, ladder: STALLED });
    expect(describeTarget(target!)).toBe("Facilities manager (fm@example.com)");
  });

  it("is just the role label when nobody is left", () => {
    expect(describeTarget(resolve({ activeUsers: [DEE], ladder: STALLED, raiser: { role: "director", userId: DEE.userId } })!)).toBe("Director");
  });
});

describe("roles", () => {
  it("labels roles the way people say them", () => {
    expect(roleLabel("facilities_manager")).toBe("Facilities manager");
    expect(roleLabel("cfo")).toBe("CFO");
    expect(roleLabel("some_new_role")).toBe("Some new role");
    expect(roleLabel(null)).toBe("Nobody");
  });

  it("gives managers their own team, the CFO both sides, and directors and admin everything", () => {
    expect(teamRolesOf("facilities_manager")).toEqual(["facilities_manager", "facilities"]);
    expect(teamRolesOf("accounts_manager")).toEqual(["accounts_manager", "accounts"]);
    expect(teamRolesOf("cfo")).toEqual(expect.arrayContaining(["accounts_manager", "facilities_manager", "accounts", "facilities"]));
    expect(teamRolesOf("director")).toBeNull();
    expect(teamRolesOf("admin")).toBeNull();
    expect(teamRolesOf("facilities")).toEqual([]);
    expect(teamRolesOfAll(["facilities", "accounts_manager"])).toEqual(["accounts_manager", "accounts"]);
    expect(teamRolesOfAll(["facilities", "director"])).toBeNull();
  });

  it("lets only the CFO oversee a policy domain: finance.", () => {
    expect(seenPolicyPrefixesOf("cfo")).toEqual(["finance."]);
    expect(seenPolicyPrefixesOf(" CFO ")).toEqual(["finance."]);
    for (const role of ["director", "admin", "accounts_manager", "facilities_manager", "accounts", "facilities", "user", "constructor", "", null]) {
      expect(seenPolicyPrefixesOf(role)).toEqual([]);
    }
    expect(seenPolicyPrefixesOfAll(["facilities", "cfo", "cfo"])).toEqual(["finance."]);
    expect(seenPolicyPrefixesOfAll(["facilities", "accounts_manager"])).toEqual([]);
    expect(FINANCE_POLICY_PREFIX).toBe("finance.");
  });

  it("knows which roles are above a target (§3.7 visibility)", () => {
    expect(isAbove("director", "facilities_manager")).toBe(true);
    expect(isAbove("admin", "facilities_manager")).toBe(true);
    expect(isAbove("cfo", "accounts_manager")).toBe(true);
    expect(isAbove("cfo", "facilities_manager")).toBe(true);
    expect(isAbove("facilities_manager", "facilities")).toBe(true);
    expect(isAbove("facilities_manager", "facilities_manager")).toBe(false);
    expect(isAbove("facilities_manager", "accounts_manager")).toBe(false);
    expect(isAbove("accounts_manager", "facilities_manager")).toBe(false);
    expect(isAbove("facilities", "facilities_manager")).toBe(false);
    expect(isAbove("facilities_manager", "director")).toBe(false);
    expect(isAbove("director", null)).toBe(false);
  });
});

// ── A level of named people keeps the raiser (jobs plan A2) ──────────────────

describe("a level of named people keeps the raiser only when the ladder is about them (namedKeepRaiser)", () => {
  const NEXT_STEP: LadderEntry[] = [{ userTarget: true }, { token: "raiser_manager", slaHours: 16 }, { role: "director" }];
  const person = (u: DirectoryUser) => ({ email: u.email, role: u.role, userId: u.userId });

  it("leaves the raiser out of the people named when the caller says nothing, as for a decision request: nobody asks themselves", () => {
    const target = resolve({ ladder: NEXT_STEP, raiser: person(DEE), userTargets: [DEE.userId, CAM.userId] });
    expect(target?.users).toEqual([CAM]);
    expect(target).toMatchObject({ targetUserId: CAM.userId });
  });

  it("keeps them when asked to: a next step's owner is the person the ladder is about, and the level is theirs", () => {
    const target = resolve({ ladder: NEXT_STEP, namedKeepRaiser: true, raiser: person(DEE), userTargets: [DEE.userId] });
    expect(target).toMatchObject({ level: 1, source: "user_target", targetUserId: DEE.userId });
    expect(target?.users).toEqual([DEE]);
  });

  it("still leaves the raiser out of every role level, so a step is never escalated to the person it is about", () => {
    const target = resolve({
      fromLevel: 2,
      ladder: [{ userTarget: true }, { role: "facilities_manager", slaHours: 16 }],
      namedKeepRaiser: true,
      raiser: person(ADAM),
      userTargets: [ADAM.userId],
    });
    expect(target?.users).toEqual([BEA]);
  });

  it("goes to the manager of the person the ladder is about: a step for an accounts person moves up to the accounts manager, then a director", () => {
    const ladderPerson = { email: GUS.email, role: "accounts", userId: GUS.userId };
    const first = resolve({ ladder: NEXT_STEP, namedKeepRaiser: true, raiser: ladderPerson, userTargets: [GUS.userId] });
    expect(first).toMatchObject({ level: 1, targetUserId: GUS.userId });

    const second = resolve({ fromLevel: 2, ladder: NEXT_STEP, namedKeepRaiser: true, raiser: ladderPerson, userTargets: [GUS.userId] });
    expect(second).toMatchObject({ level: 2, role: "accounts_manager", slaHours: 16, source: "raiser_manager" });
    expect(second?.users).toEqual([CAM]);

    const third = resolve({ fromLevel: 3, ladder: NEXT_STEP, namedKeepRaiser: true, raiser: ladderPerson, userTargets: [GUS.userId] });
    expect(third).toMatchObject({ level: 3, role: "director" });
    expect(third?.users).toEqual([DEE, ELI]);
  });

  it("is a role's manager too, when the step is for a whole role and no one person: the ladder is the role's", () => {
    const second = resolve({ fromLevel: 2, ladder: NEXT_STEP, namedKeepRaiser: true, raiser: { role: "facilities", userId: null }, userTargets: [FAY.userId] });
    expect(second).toMatchObject({ level: 2, role: "facilities_manager" });
    expect(second?.users).toEqual([ADAM, BEA]);
  });

  it("does not escalate a director's step to that director: the other directors are the next level", () => {
    const second = resolve({ fromLevel: 2, ladder: NEXT_STEP, namedKeepRaiser: true, raiser: person(DEE), userTargets: [DEE.userId] });
    expect(second).toMatchObject({ level: 2, role: "director" });
    expect(second?.users).toEqual([ELI]);
  });

  it("still leaves out whoever prepared the subject of an authority escalation, named or not, whatever it is asked", () => {
    const target = resolve({
      excludeUserIds: [CAM.userId],
      kind: "authority",
      ladder: [{ userTarget: true }],
      namedKeepRaiser: true,
      raiser: person(FAY),
      userTargets: [CAM.userId, DEE.userId],
    });
    expect(target?.users).toEqual([DEE]);
  });

  it("changes nothing for the people asked a decision request, who are never the asker", () => {
    const target = resolve({ ladder: NEXT_STEP, raiser: person(GUS), userTargets: [CAM.userId, DEE.userId] });
    expect(target?.users).toEqual([CAM, DEE]);
    expect(target).toMatchObject({ role: null, targetUserId: null });
  });
});

describe("levelOfRole", () => {
  const ladder = [{ role: "accounts_manager" }, { role: "cfo" }, { role: "director" }];
  it("is the position of the first level holding the role, or the top when none does", () => {
    expect(levelOfRole(ladder, "accounts_manager")).toBe(1);
    expect(levelOfRole(ladder, "cfo")).toBe(2);
    expect(levelOfRole(ladder, "DIRECTOR")).toBe(3);
    expect(levelOfRole(ladder, "facilities_manager")).toBe(3);
  });
});
