/// <reference types="jest" />
import { absent, context, DIRECTORY, item, user } from "../__tests__/fixtures/absenceCover";
import { ladderRoles, resolveCover } from "./resolveCover";
import type { CoverDelegate } from "./types";

const delegate = (over: Partial<CoverDelegate> = {}): CoverDelegate => ({
  coverDelegateId: 1,
  delegateUserId: 7,
  fromDate: "2026-10-26",
  leaveRequestId: 11,
  toDate: "2026-10-30",
  userId: 1,
  ...over,
});

const found = (resolution: ReturnType<typeof resolveCover>) => {
  expect(resolution.found).toBe(true);
  return resolution as Extract<typeof resolution, { found: true }>;
};

describe("resolveCover: the order", () => {
  it("takes the delegate the person nominated first", () => {
    const resolution = found(resolveCover(item(), absent(), context({ delegates: [delegate()], links: [{ managerId: 2, userId: 1 }] })));
    expect(resolution).toMatchObject({ action: "reassigned", source: "delegate", userId: 7 });
    expect(resolution.skipped).toEqual([]);
  });

  it("falls to the reporting-line manager when the delegate is away too, and says why", () => {
    const resolution = found(resolveCover(item(), absent(), context({ absentIds: new Set([1, 7]), delegates: [delegate()], links: [{ managerId: 2, userId: 1 }] })));
    expect(resolution).toMatchObject({ action: "reassigned", source: "reporting_manager", userId: 2 });
    expect(resolution.skipped).toEqual([{ name: "Sam Facilities", reason: "is away too", source: "delegate", userId: 7 }]);
  });

  it("falls to the team manager when there is no delegate and no reporting line", () => {
    expect(found(resolveCover(item(), absent(), context()))).toMatchObject({ action: "reassigned", source: "team_manager", userId: 2 });
  });

  it("picks the team manager who is in, not the first one listed", () => {
    expect(found(resolveCover(item(), absent(), context({ absentIds: new Set([1, 2]) })))).toMatchObject({ source: "team_manager", userId: 8 });
  });

  it("goes up the escalation ladder when the whole team is away, and calls it escalated", () => {
    const resolution = found(resolveCover(item(), absent(), context({ absentIds: new Set([1, 2, 8]) })));
    expect(resolution).toMatchObject({ action: "escalated", role: "cfo", source: "ladder", userId: 5 });
  });

  it("uses a delegate whose dates cover today, not one for other dates", () => {
    expect(found(resolveCover(item(), absent(), context({ delegates: [delegate({ toDate: "2026-10-25" })] }))).source).toBe("team_manager");
    expect(found(resolveCover(item(), absent(), context({ delegates: [delegate({ fromDate: "2026-10-27" })] }))).source).toBe("team_manager");
  });

  it("prefers the nomination tied to this leave, then the newest", () => {
    const rows = [delegate({ coverDelegateId: 1, delegateUserId: 3, leaveRequestId: 11 }), delegate({ coverDelegateId: 2, delegateUserId: 7, leaveRequestId: null }), delegate({ coverDelegateId: 3, delegateUserId: 8, leaveRequestId: null })];
    expect(found(resolveCover(item(), absent(), context({ delegates: rows }))).userId).toBe(3);
    expect(found(resolveCover(item(), absent({ leaveRequestId: null }), context({ delegates: rows }))).userId).toBe(8);
  });

  it("ignores another person's nominations", () => {
    expect(found(resolveCover(item(), absent(), context({ delegates: [delegate({ userId: 3 })] }))).source).toBe("team_manager");
  });
});

describe("resolveCover: who is passed over", () => {
  const withUser = [...DIRECTORY, user(10, "user", "Una User")];

  it("passes over a cover who cannot do this kind of work", () => {
    const resolution = found(resolveCover(item(), absent(), context({ delegates: [delegate({ delegateUserId: 10 })], directory: withUser })));
    expect(resolution.skipped).toEqual([{ name: "Una User", reason: "cannot do this kind of work", source: "delegate", userId: 10 }]);
    expect(resolution.source).toBe("team_manager");
  });

  it("never picks admin for a real record", () => {
    const resolution = found(resolveCover(item(), absent(), context({ delegates: [delegate({ delegateUserId: 9 })] })));
    expect(resolution.skipped[0]).toMatchObject({ reason: "is admin, who approves nothing real", userId: 9 });
    expect(resolution.userId).not.toBe(9);
  });

  it("never picks the person who raised or asked for it", () => {
    const resolution = found(resolveCover(item({ raisedByUserId: 7 }), absent(), context({ delegates: [delegate()] })));
    expect(resolution.skipped).toEqual([{ name: "Sam Facilities", reason: "raised or asked for it", source: "delegate", userId: 7 }]);
    expect(resolution.source).toBe("team_manager");
  });

  it("never picks the person who is away, even as their own delegate or manager", () => {
    const resolution = found(resolveCover(item(), absent(), context({ delegates: [delegate({ delegateUserId: 1 })] })));
    expect(resolution.skipped[0].reason).toBe("is the person who is away");
  });

  it("passes over a nominated cover who is no longer an active user", () => {
    const resolution = found(resolveCover(item(), absent(), context({ delegates: [delegate({ delegateUserId: 99 })] })));
    expect(resolution.skipped).toEqual([{ name: "Someone no longer here (#99)", reason: "is no longer an active user", source: "delegate", userId: 99 }]);
  });

  it("reports nobody when no one may take it, with every reason", () => {
    const resolution = resolveCover(item({ raisedByUserId: 2 }), absent(), context({ directory: [DIRECTORY[0], DIRECTORY[1], DIRECTORY[8]], delegates: [delegate({ delegateUserId: 9 })] }));
    expect(resolution.found).toBe(false);
    expect(resolution.skipped.map((skip) => skip.reason)).toEqual(["is admin, who approves nothing real", "raised or asked for it"]);
  });
});

describe("resolveCover: a decision, an escalation and a leave approval", () => {
  it("gives a decision only to someone who can answer decisions", () => {
    expect(found(resolveCover(item({ capability: "respondToDecision", type: "decision_request" }), absent(), context({ delegates: [delegate({ delegateUserId: 3 })] }))).userId).toBe(3);
  });

  it("gives an authority escalation only to its target role or above", () => {
    const resolution = found(resolveCover(item({ capability: null, minRole: "accounts_manager", type: "escalation" }), absent(), context({ delegates: [delegate()] })));
    expect(resolution.skipped).toEqual(expect.arrayContaining([{ name: "Sam Facilities", reason: "cannot do this kind of work", source: "delegate", userId: 7 }]));
    expect(resolution.userId).toBe(5);
    expect(resolution.action).toBe("escalated");
  });

  it("gives a director-level escalation only to a director", () => {
    expect(found(resolveCover(item({ capability: null, minRole: "director", type: "escalation" }), absent(), context())).userId).toBe(4);
  });

  it("honours an extra rule on who may cover", () => {
    const only = item({ capability: null, move: "none", onlyIf: (person) => person.userId === 8, type: "leave_approval" });
    expect(found(resolveCover(only, absent(), context())).userId).toBe(8);
  });
});

describe("resolveCover: money", () => {
  const quote = (amount: number | null, over: Record<string, unknown> = {}) =>
    item({ capability: null, money: { amount, buildingId: 3, createdByName: "Fay Facilities", subject: "quote", ...over }, move: "notice", type: "approval" });

  it("gives a quote to a cover whose limit covers the amount", () => {
    expect(found(resolveCover(quote(8_000), absent(), context({ links: [{ managerId: 2, userId: 1 }] })))).toMatchObject({ source: "reporting_manager", userId: 2 });
  });

  it("goes up the ladder when the cover's limit is too low", () => {
    const resolution = found(resolveCover(quote(15_000), absent(), context({ links: [{ managerId: 2, userId: 1 }] })));
    expect(resolution).toMatchObject({ action: "escalated", role: "accounts_manager", source: "ladder", userId: 6 });
    expect(resolution.skipped).toEqual(expect.arrayContaining([{ name: "Max Manager", reason: "has no authority for that amount", source: "reporting_manager", userId: 2 }]));
  });

  it("goes to a director above the director threshold, and for an unknown amount", () => {
    expect(found(resolveCover(quote(60_000), absent(), context())).userId).toBe(4);
    expect(found(resolveCover(quote(null), absent(), context())).userId).toBe(4);
  });

  it("walks the approval route for the amount, nearest sufficient role first", () => {
    expect(ladderRoles(quote(15_000), absent(), context())).toEqual(["accounts_manager", "cfo", "director"]);
    expect(ladderRoles(quote(60_000), absent(), context())).toEqual(["director"]);
    expect(ladderRoles(item(), absent(), context())).toEqual(["facilities_manager", "cfo", "director"]);
  });

  it("never gives a quote to the person who added it, unless a director", () => {
    const resolution = found(resolveCover(quote(8_000, { createdByName: "Max Manager" }), absent(), context({ links: [{ managerId: 2, userId: 1 }] })));
    expect(resolution.skipped).toEqual([{ name: "Max Manager", reason: "added it", source: "reporting_manager", userId: 2 }]);
    expect(resolution.userId).toBe(8);
    expect(found(resolveCover(quote(60_000, { createdByName: "Dee Director" }), absent(), context())).userId).toBe(4);
  });

  it("refuses everyone for money when the approval facts are missing", () => {
    expect(resolveCover(quote(100), absent(), context({ moneyFacts: null })).found).toBe(false);
  });

  it("walks the ladder for someone higher up: a facilities manager's goes to the CFO then a director", () => {
    expect(ladderRoles(item(), absent({ role: "facilities_manager" }), context())).toEqual(["cfo", "director"]);
    expect(ladderRoles(item(), absent({ role: "director" }), context())).toEqual(["director"]);
  });
});
