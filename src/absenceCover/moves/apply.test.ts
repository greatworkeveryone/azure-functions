/// <reference types="jest" />
import { absent, item } from "../../__tests__/fixtures/absenceCover";
import { EscalationError } from "../../escalation/errors";
import { applyCoverAction, type ApplyInput } from "./apply";

const log: string[] = [];
jest.mock("../../rentReview/store", () => ({
  inTransaction: jest.fn(async (_c: unknown, work: () => Promise<unknown>) => {
    log.push("begin");
    try {
      const out = await work();
      log.push("commit");
      return out;
    } catch (error) {
      log.push("rollback");
      throw error;
    }
  }),
}));
jest.mock("../coverActionStore", () => ({ insertCoverAction: jest.fn(async () => { log.push("ledger"); return 901; }) }));
jest.mock("./notice", () => ({ raiseCoverNotice: jest.fn(async () => { log.push("notice"); return jest.fn(async () => { log.push("announce"); }); }) }));
jest.mock("./domain", () => ({ MOVERS: { job_assignee: jest.fn() } }));
jest.mock("../../escalation/engine", () => ({ escalateFurther: jest.fn() }));

const store = jest.requireMock("../coverActionStore") as { insertCoverAction: jest.Mock };
const notice = jest.requireMock("./notice") as { raiseCoverNotice: jest.Mock };
const domain = jest.requireMock("./domain") as { MOVERS: { job_assignee: jest.Mock } };
const engine = jest.requireMock("../../escalation/engine") as { escalateFurther: jest.Mock };
const conn = {} as never;

const input = (over: Partial<ApplyInput> = {}): ApplyInput => ({
  absent: absent(),
  action: "reassigned",
  actor: { kind: "system" },
  cover: { name: "Max Manager", userId: 2 },
  item: item(),
  reasonCode: "due_before_return",
  reasonText: "It falls due before they are back.",
  runId: "run-1",
  ...over,
});

beforeEach(() => {
  log.length = 0;
  jest.clearAllMocks();
  domain.MOVERS.job_assignee.mockImplementation(async () => { log.push("move"); return true; });
});

describe("applyCoverAction: a move", () => {
  it("does the domain write, the ledger row and the notice in one transaction, and sends the email after the commit", async () => {
    const result = await applyCoverAction(conn, input());
    expect(log).toEqual(["begin", "move", "ledger", "notice", "commit"]);
    expect(result).toMatchObject({ coverActionId: 901, status: "applied", toUserId: 2 });
    if (result.status === "applied") await result.announce();
    expect(log.at(-1)).toBe("announce");
  });

  it("writes the ledger row with who, what, why and the absence", async () => {
    await applyCoverAction(conn, input());
    expect(store.insertCoverAction.mock.calls[0][1]).toMatchObject({
      absenceKind: "planned", absenceRef: "leave:11", action: "reassigned", actor: { kind: "system" }, actorName: "Floorplan (cover while away)", dryRun: false,
      fromUserId: 1, importance: "medium", itemId: "12", itemType: "job", reasonCode: "due_before_return", returnDate: "2026-11-02", runId: "run-1", toUserId: 2,
    });
    expect(notice.raiseCoverNotice).toHaveBeenCalledWith(conn, { coverActionId: 901, deepLink: "/jobs?jobId=12", toUserId: 2 });
  });

  it("names the manager as the actor when a manager moved it", async () => {
    await applyCoverAction(conn, input({ actor: { kind: "user", name: "Dee Director", userId: 4 } }));
    expect(store.insertCoverAction.mock.calls[0][1]).toMatchObject({ actor: { kind: "user", userId: 4 }, actorName: "Dee Director" });
    expect(domain.MOVERS.job_assignee.mock.calls[0][1]).toMatchObject({ actorName: "Dee Director", from: { name: "Fay Facilities", userId: 1 }, to: { name: "Max Manager", userId: 2 } });
  });

  it("writes no ledger row and sends no notice when the item has already moved", async () => {
    domain.MOVERS.job_assignee.mockResolvedValue(false);
    expect(await applyCoverAction(conn, input())).toEqual({ reason: "changed", status: "skipped" });
    expect(store.insertCoverAction).not.toHaveBeenCalled();
    expect(notice.raiseCoverNotice).not.toHaveBeenCalled();
  });

  it("rolls back, never commits, when a mover has already written part of a move and then finds the row stale (a decision's makers changed, its escalation did not)", async () => {
    domain.MOVERS.job_assignee.mockImplementation(async () => {
      log.push("partial write");
      return false;
    });
    expect(await applyCoverAction(conn, input())).toEqual({ reason: "changed", status: "skipped" });
    expect(log).toEqual(["begin", "partial write", "rollback"]);
  });

  it("rolls the whole move back when the ledger row cannot be written", async () => {
    store.insertCoverAction.mockRejectedValueOnce(new Error("ledger down"));
    await expect(applyCoverAction(conn, input())).rejects.toThrow("ledger down");
    expect(log).toEqual(["begin", "move", "rollback"]);
    expect(notice.raiseCoverNotice).not.toHaveBeenCalled();
  });

  it("rolls the whole move back when the notice cannot be raised", async () => {
    notice.raiseCoverNotice.mockRejectedValueOnce(new Error("no policy"));
    await expect(applyCoverAction(conn, input())).rejects.toThrow("no policy");
    expect(log).toEqual(["begin", "move", "ledger", "rollback"]);
  });

  it("needs a cover, and a type that can be moved", async () => {
    await expect(applyCoverAction(conn, input({ cover: null }))).rejects.toThrow("A move needs a cover");
    await expect(applyCoverAction(conn, input({ item: item({ move: "none", type: "leave_approval" }) }))).rejects.toThrow("cannot be moved from here");
  });
});

describe("applyCoverAction: what other people can read", () => {
  const SENSITIVE = /planned|unplanned|sick|personal|signed in|sign-in|business days|not signed|leave kind/i;

  it("gives the item's own history a neutral reason: first name and the date back, never the kind of absence, and keeps the detail for the ledger", async () => {
    await applyCoverAction(conn, input({ reasonText: "It falls due before they are back. Away on leave that was not planned, until 30/10/2026." }));
    const args = domain.MOVERS.job_assignee.mock.calls[0][1];
    expect(args.reason).toBe("Covering while Fay is away until 02/11");
    expect(args.reason).not.toMatch(SENSITIVE);
    expect(store.insertCoverAction.mock.calls[0][1].reasonText).toContain("not planned");
  });

  it("says unavailable, with no date and no sign-in detail, for someone who only stopped signing in", async () => {
    await applyCoverAction(conn, input({ absent: absent({ endDate: null, kind: "inactive", reason: "Has not signed in since 20/10/2026 (3 business days)", returnDate: null }), reasonText: "Has not signed in since 20/10/2026." }));
    const args = domain.MOVERS.job_assignee.mock.calls[0][1];
    expect(args.reason).toBe("Covering while Fay is unavailable");
    expect(args.reason).not.toMatch(SENSITIVE);
  });

  it("gives the escalation's note the same neutral reason, not the absence's", async () => {
    engine.escalateFurther.mockResolvedValue({ next: { targetRole: "director", targetUserId: null }, previous: {} });
    await applyCoverAction(conn, input({ action: "escalated", item: item({ id: "40", move: "escalation_retarget", type: "escalation" }), reasonText: "Away on leave that was not planned, until 30/10/2026." }));
    const note = engine.escalateFurther.mock.calls[0][1].note;
    expect(note).toBe("Covering while Fay is away until 02/11");
    expect(note).not.toMatch(SENSITIVE);
  });
});

describe("applyCoverAction: a notice only (a quote awaiting approval)", () => {
  it("tells the cover and writes the ledger row, without changing anything", async () => {
    const result = await applyCoverAction(conn, input({ item: item({ move: "notice", type: "approval" }) }));
    expect(log).toEqual(["begin", "ledger", "notice", "commit"]);
    expect(domain.MOVERS.job_assignee).not.toHaveBeenCalled();
    expect(result.status).toBe("applied");
  });
});

describe("applyCoverAction: an escalation pushed up its own ladder", () => {
  const escalation = item({ id: "40", detail: { rowVersion: "v1" }, move: "escalation_retarget", type: "escalation" });
  const next = (over: Record<string, unknown> = {}) => ({ next: { targetRole: "director", targetUserId: null, ...over }, previous: {} });

  it("uses the escalation engine, then writes its ledger row naming where it went", async () => {
    engine.escalateFurther.mockResolvedValue(next());
    const result = await applyCoverAction(conn, input({ action: "escalated", item: escalation }));
    expect(engine.escalateFurther).toHaveBeenCalledWith(conn, expect.objectContaining({ code: "escalated", escalationId: 40, expectedRowVersion: "v1", mode: "next_level" }));
    expect(store.insertCoverAction.mock.calls[0][1]).toMatchObject({ action: "escalated", toUserId: null });
    expect(store.insertCoverAction.mock.calls[0][1].reasonText).toContain("It went up to Director.");
    expect(result).toMatchObject({ status: "applied", toUserId: null });
    expect(notice.raiseCoverNotice).not.toHaveBeenCalled();
  });

  it("records the person it reached when the next level is one person", async () => {
    engine.escalateFurther.mockResolvedValue(next({ targetUserId: 4 }));
    expect(await applyCoverAction(conn, input({ action: "escalated", item: escalation }))).toMatchObject({ toUserId: 4 });
  });

  it.each([
    ["no_further_level", "no_further_level"],
    ["stale", "changed"],
    ["not_live", "changed"],
  ] as const)("skips, writing nothing, when the engine says %s", async (code, reason) => {
    engine.escalateFurther.mockRejectedValue(new EscalationError(code, "no"));
    expect(await applyCoverAction(conn, input({ action: "escalated", item: escalation }))).toEqual({ reason, status: "skipped" });
    expect(store.insertCoverAction).not.toHaveBeenCalled();
  });

  it("lets any other engine error through", async () => {
    engine.escalateFurther.mockRejectedValue(new Error("boom"));
    await expect(applyCoverAction(conn, input({ action: "escalated", item: escalation }))).rejects.toThrow("boom");
  });
});

describe("applyCoverAction: suggested and kept", () => {
  it.each(["suggested", "kept"] as const)("only writes the ledger row for %s, in its own transaction", async (action) => {
    const result = await applyCoverAction(conn, input({ action, cover: action === "suggested" ? { name: "Max Manager", userId: 2 } : null }));
    expect(log).toEqual(["begin", "ledger", "commit"]);
    expect(domain.MOVERS.job_assignee).not.toHaveBeenCalled();
    expect(notice.raiseCoverNotice).not.toHaveBeenCalled();
    expect(result).toMatchObject({ coverActionId: 901, status: "applied", toUserId: action === "suggested" ? 2 : null });
  });

  it("marks a dry run's rows as dry", async () => {
    await applyCoverAction(conn, input({ action: "suggested", dryRun: true }));
    expect(store.insertCoverAction.mock.calls[0][1]).toMatchObject({ dryRun: true });
  });
});
