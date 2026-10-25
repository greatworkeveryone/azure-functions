/// <reference types="jest" />
import type { Connection } from "tedious";
import type { AuthorityFacts } from "../approvalAuthority";
import { formatDigestSummary, runDigest, type DigestDeps } from "./run";
import type { DigestFacts, DigestUser, DueJob } from "./types";

// A real deriveItems that a test can make fail for one person.
jest.mock("./items", () => {
  const actual = jest.requireActual("./items");
  return { ...actual, deriveItems: jest.fn(actual.deriveItems) };
});
const { deriveItems } = require("./items") as { deriveItems: jest.Mock };

const NOW = new Date("2026-10-13T22:00:00Z"); // 07:30 Wednesday 14/10/2026, Darwin
const conn = {} as Connection;

const FULL_ENV = {
  APP_BASE_URL: "https://floorplan.example.test",
  GRAPH_CLIENT_ID: "id",
  GRAPH_CLIENT_SECRET: "secret",
  GRAPH_SENDER_EMAIL: "floorplan@example.test",
  GRAPH_TENANT_ID: "tenant",
} as NodeJS.ProcessEnv;

const authority: AuthorityFacts = {
  directorThreshold: null, isResidence: false, limits: [], residenceApprovers: [], residenceDirectorFallback: true, today: "2026-10-14",
};

const person = (userId: number, over: Partial<DigestUser> = {}): DigestUser => ({
  email: `user${userId}@example.test`, lastSentOn: null, name: `Person ${userId}`, optedOut: false, role: "facilities", userId, ...over,
});
const due = (assignedToUserId: number, jobId = assignedToUserId * 100, kind = "facilities"): DueJob => ({
  assignedToUserId, buildingName: "Tower A", expectedProgressUpdate: new Date("2026-10-13T14:30:00Z"), jobId, kind, title: "Paint stairwell",
});
const facts = (over: Partial<DigestFacts> = {}): DigestFacts => ({ dueJobs: [], escalations: [], overdueKeys: [], users: [], waitingApprovals: [], ...over });

function deps(f: DigestFacts, send: jest.Mock = jest.fn().mockResolvedValue(undefined)): DigestDeps & { record: jest.Mock; send: jest.Mock } {
  return { authority: jest.fn().mockResolvedValue(() => authority), load: jest.fn().mockResolvedValue(f), record: jest.fn().mockResolvedValue(undefined), send };
}

const options = (over: Partial<Parameters<typeof runDigest>[1]> = {}) => ({ dryRun: false, env: FULL_ENV, log: jest.fn(), now: NOW, ...over });

describe("when nothing needs anyone", () => {
  it("sends no email at all", async () => {
    const d = deps(facts({ users: [person(1), person(2)] }));
    const report = await runDigest(conn, options(), d);
    expect(d.send).not.toHaveBeenCalled();
    expect(report).toMatchObject({ errors: [], nothingToSend: 2, sent: 0 });
  });
});

describe("when only Admin / Accounts work is waiting", () => {
  it("sends no email: those jobs are not on the digest's contractor lines", async () => {
    const d = deps(facts({ dueJobs: [due(1, 100, "admin")], users: [person(1)] }));
    const report = await runDigest(conn, options(), d);
    expect(d.send).not.toHaveBeenCalled();
    expect(report).toMatchObject({ errors: [], nothingToSend: 1, sent: 0 });
  });
});

describe("sending", () => {
  it("sends one email to each person who has something, and only to them", async () => {
    const d = deps(facts({ dueJobs: [due(1), due(3)], users: [person(1), person(2), person(3)] }));
    const report = await runDigest(conn, options(), d);
    expect(d.send).toHaveBeenCalledTimes(2);
    expect(d.send.mock.calls.map((c) => c[0])).toEqual([["user1@example.test"], ["user3@example.test"]]);
    expect(report).toMatchObject({ considered: 3, nothingToSend: 1, sent: 2 });
  });

  it("sends one email per person however many things they have", async () => {
    const d = deps(facts({ dueJobs: [due(1, 1), due(1, 2), due(1, 3)], users: [person(1)] }));
    await runDigest(conn, options(), d);
    expect(d.send).toHaveBeenCalledTimes(1);
    const [, subject, body] = d.send.mock.calls[0];
    expect(subject).toBe("Floorplan 14/10/2026: 3 items need you");
    expect(body).toContain("https://floorplan.example.test/jobs?jobId=1");
  });

  it("does not put the person's work in the subject", async () => {
    const d = deps(facts({ dueJobs: [due(1)], users: [person(1)] }));
    await runDigest(conn, options(), d);
    expect(d.send.mock.calls[0][1]).not.toMatch(/Paint|Tower/);
  });

  it("passes every address through DEV_EMAIL_OVERRIDE and says who it was meant for", async () => {
    const d = deps(facts({ dueJobs: [due(1)], users: [person(1)] }));
    await runDigest(conn, options(), d);
    expect(d.send.mock.calls[0][0]).toEqual(["user1@example.test"]);

    const original = process.env.DEV_EMAIL_OVERRIDE;
    process.env.DEV_EMAIL_OVERRIDE = "inbox@gwe.test";
    try {
      const d2 = deps(facts({ dueJobs: [due(1)], users: [person(1)] }));
      await runDigest(conn, options(), d2);
      expect(d2.send.mock.calls[0][0]).toEqual(["inbox@gwe.test"]);
      expect(d2.send.mock.calls[0][2]).toContain("meant for user1@example.test");
    } finally {
      if (original === undefined) delete process.env.DEV_EMAIL_OVERRIDE;
      else process.env.DEV_EMAIL_OVERRIDE = original;
    }
  });
});

describe("opting out", () => {
  it("never emails a person who has switched the digest off, however much is waiting", async () => {
    const d = deps(facts({ dueJobs: [due(1), due(2)], users: [person(1, { optedOut: true }), person(2)] }));
    const report = await runDigest(conn, options(), d);
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send.mock.calls[0][0]).toEqual(["user2@example.test"]);
    expect(report).toMatchObject({ optedOut: 1, sent: 1 });
  });
});

describe("a person with no address", () => {
  it("is counted and skipped, not an error", async () => {
    const d = deps(facts({ dueJobs: [due(1)], users: [person(1, { email: null })] }));
    const report = await runDigest(conn, options(), d);
    expect(d.send).not.toHaveBeenCalled();
    expect(report).toMatchObject({ errors: [], noAddress: 1, sent: 0 });
  });
});

describe("dry run", () => {
  it("logs what it would send and sends nothing", async () => {
    const d = deps(facts({ dueJobs: [due(1)], users: [person(1), person(2)] }));
    const opts = options({ dryRun: true });
    const report = await runDigest(conn, opts, d);
    expect(d.send).not.toHaveBeenCalled();
    expect(report).toMatchObject({ dryRun: true, sent: 0, wouldSend: 1 });
    const logged = (opts.log as jest.Mock).mock.calls.map((c) => c[0]).join("\n");
    expect(logged).toContain("would email");
    expect(logged).toContain("Floorplan 14/10/2026: 1 item needs you");
    expect(logged).toContain("/jobs?jobId=100");
  });

  it("does not need the mail settings", async () => {
    const d = deps(facts({ dueJobs: [due(1)], users: [person(1)] }));
    const report = await runDigest(conn, options({ dryRun: true, env: {} as NodeJS.ProcessEnv }), d);
    expect(report.configMissing).toEqual([]);
    expect(report.wouldSend).toBe(1);
  });
});

describe("missing settings", () => {
  it("sends nothing, reads nothing and says which settings are missing", async () => {
    const d = deps(facts({ dueJobs: [due(1)], users: [person(1)] }));
    const env = { ...FULL_ENV, GRAPH_SENDER_EMAIL: "", APP_BASE_URL: undefined } as NodeJS.ProcessEnv;
    const report = await runDigest(conn, options({ env }), d);
    expect(d.send).not.toHaveBeenCalled();
    expect(d.load).not.toHaveBeenCalled();
    expect(report.configMissing).toEqual(["APP_BASE_URL", "GRAPH_SENDER_EMAIL"]);
    expect(report.errors[0]).toContain("APP_BASE_URL");
  });
});

describe("a send that fails", () => {
  it("is recorded, does not stop the others, and is never counted as sent", async () => {
    const send = jest.fn().mockRejectedValueOnce(new Error("Graph sendMail failed: 429")).mockResolvedValue(undefined);
    const d = deps(facts({ dueJobs: [due(1), due(2), due(3)], users: [person(1), person(2), person(3)] }), send);
    const report = await runDigest(conn, options(), d);
    expect(send).toHaveBeenCalledTimes(3);
    expect(report.sent).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("#1");
    expect(report.errors[0]).toContain("429");
  });

  it("does not put the person's address in the error", async () => {
    const send = jest.fn().mockRejectedValue(new Error("boom"));
    const d = deps(facts({ dueJobs: [due(1)], users: [person(1)] }), send);
    const report = await runDigest(conn, options(), d);
    expect(report.errors.join()).not.toContain("example.test");
  });
});

describe("a problem with one person", () => {
  it("working out their items fails: recorded against them, the others still get theirs", async () => {
    deriveItems.mockImplementationOnce(() => {
      throw new Error("bad data for this person");
    });
    const d = deps(facts({ dueJobs: [due(1), due(2), due(3)], users: [person(1), person(2), person(3)] }));
    const report = await runDigest(conn, options(), d);
    expect(d.send).toHaveBeenCalledTimes(2);
    expect(report.sent).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("#1");
    expect(report.errors[0]).toContain("bad data");
  });

  it("building their email fails: recorded against them, the others still get theirs", async () => {
    const broken = { ...person(2), name: null as unknown as string };
    const d = deps(facts({ dueJobs: [due(1), due(2), due(3)], users: [person(1), broken, person(3)] }));
    const report = await runDigest(conn, options(), d);
    expect(d.send.mock.calls.map((c) => c[0])).toEqual([["user1@example.test"], ["user3@example.test"]]);
    expect(report.sent).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("#2");
  });

  it("does the same in a dry run", async () => {
    deriveItems.mockImplementationOnce(() => {
      throw new Error("bad data");
    });
    const d = deps(facts({ dueJobs: [due(1), due(2)], users: [person(1), person(2)] }));
    const report = await runDigest(conn, options({ dryRun: true }), d);
    expect(report).toMatchObject({ wouldSend: 1 });
    expect(report.errors).toHaveLength(1);
  });
});

describe("one digest per person per Darwin day", () => {
  const TODAY = "2026-10-14";

  it("does not email someone already emailed today, however much is waiting, and does not stamp them again", async () => {
    const d = deps(facts({ dueJobs: [due(1), due(2)], users: [person(1, { lastSentOn: TODAY }), person(2)] }));
    const report = await runDigest(conn, options(), d);
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.send.mock.calls[0][0]).toEqual(["user2@example.test"]);
    expect(d.record).toHaveBeenCalledTimes(1);
    expect(d.record).toHaveBeenCalledWith(conn, 2, TODAY);
    expect(report).toMatchObject({ alreadySent: 1, considered: 2, sent: 1 });
  });

  it("emails someone last emailed on an earlier day, and stamps today", async () => {
    const d = deps(facts({ dueJobs: [due(1)], users: [person(1, { lastSentOn: "2026-10-13" })] }));
    const report = await runDigest(conn, options(), d);
    expect(d.send).toHaveBeenCalledTimes(1);
    expect(d.record).toHaveBeenCalledWith(conn, 1, TODAY);
    expect(report).toMatchObject({ alreadySent: 0, sent: 1 });
  });

  it("counts the day by Darwin's calendar, not UTC's: 22:00 UTC on the 13th is already the 14th", async () => {
    // NOW is 2026-10-13T22:00Z. A stamp for the UTC date (the 13th) is yesterday in Darwin.
    const d = deps(facts({ dueJobs: [due(1), due(2)], users: [person(1, { lastSentOn: "2026-10-13" }), person(2, { lastSentOn: TODAY })] }));
    await runDigest(conn, options(), d);
    expect(d.send.mock.calls.map((call) => call[0])).toEqual([["user1@example.test"]]);
    expect(d.record).toHaveBeenCalledWith(conn, 1, TODAY);
  });

  it("stamps a person only after their email has gone, one at a time", async () => {
    const order: string[] = [];
    const d = deps(facts({ dueJobs: [due(1), due(2)], users: [person(1), person(2)] }), jest.fn(async (to: string[]) => { order.push(`send ${to[0]}`); }));
    d.record.mockImplementation(async (_conn: unknown, userId: number) => { order.push(`record ${userId}`); });
    await runDigest(conn, options(), d);
    expect(order).toEqual(["send user1@example.test", "record 1", "send user2@example.test", "record 2"]);
  });

  it("does not stamp a person whose send failed, so a rerun tries them again", async () => {
    const d = deps(facts({ dueJobs: [due(1), due(2)], users: [person(1), person(2)] }), jest.fn().mockRejectedValueOnce(new Error("Graph 429")).mockResolvedValue(undefined));
    const report = await runDigest(conn, options(), d);
    expect(d.record).toHaveBeenCalledTimes(1);
    expect(d.record).toHaveBeenCalledWith(conn, 2, TODAY);
    expect(report).toMatchObject({ sent: 1 });
    expect(report.errors).toHaveLength(1);
  });

  it("replays a run that died part-way without repeating the people already told", async () => {
    // The first run emailed person 1, then failed on person 2 and never reached 3 (the host went down).
    const stamped = new Map<number, string>();
    const everyone = [1, 2, 3];
    const load = jest.fn(async () => facts({ dueJobs: everyone.map((id) => due(id)), users: everyone.map((id) => person(id, { lastSentOn: stamped.get(id) ?? null })) }));
    const first = deps(facts());
    first.load = load;
    first.send = jest.fn().mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("host stopping")).mockRejectedValueOnce(new Error("host stopping"));
    first.record.mockImplementation(async (_conn: unknown, userId: number, day: string) => { stamped.set(userId, day); });
    await runDigest(conn, options(), first);
    expect([...stamped.keys()]).toEqual([1]);

    const second = deps(facts());
    second.load = load;
    second.record.mockImplementation(async (_conn: unknown, userId: number, day: string) => { stamped.set(userId, day); });
    const report = await runDigest(conn, options(), second);
    expect(second.send.mock.calls.map((call) => call[0])).toEqual([["user2@example.test"], ["user3@example.test"]]);
    expect(report).toMatchObject({ alreadySent: 1, sent: 2 });
    expect([...stamped.keys()].sort()).toEqual([1, 2, 3]);

    const third = deps(facts());
    third.load = load;
    const idle = await runDigest(conn, options(), third);
    expect(third.send).not.toHaveBeenCalled();
    expect(idle).toMatchObject({ alreadySent: 3, sent: 0 });
  });

  it("says a send went out but could not be stamped, without stopping the others or un-counting the send", async () => {
    const d = deps(facts({ dueJobs: [due(1), due(2)], users: [person(1), person(2)] }));
    d.record.mockRejectedValueOnce(new Error("deadlock victim")).mockResolvedValue(undefined);
    const report = await runDigest(conn, options(), d);
    expect(d.send).toHaveBeenCalledTimes(2);
    expect(report.sent).toBe(2);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toContain("#1");
    expect(report.errors[0]).toMatch(/could not be recorded.*repeat/i);
    expect(d.record).toHaveBeenCalledTimes(2);
  });

  it("changes nothing in a dry run, and still reports who would be skipped", async () => {
    const d = deps(facts({ dueJobs: [due(1), due(2)], users: [person(1, { lastSentOn: TODAY }), person(2)] }));
    const report = await runDigest(conn, options({ dryRun: true }), d);
    expect(d.record).not.toHaveBeenCalled();
    expect(d.send).not.toHaveBeenCalled();
    expect(report).toMatchObject({ alreadySent: 1, wouldSend: 1 });
  });

  it("says who it skipped and why", async () => {
    const opts = options();
    await runDigest(conn, opts, deps(facts({ dueJobs: [due(1)], users: [person(1, { lastSentOn: TODAY })] })));
    expect((opts.log as jest.Mock).mock.calls.map((call) => call[0]).join("\n")).toContain("user #1 was already emailed on 2026-10-14");
  });

  it("counts someone who opted out as opted out, not as already sent", async () => {
    const d = deps(facts({ dueJobs: [due(1)], users: [person(1, { lastSentOn: TODAY, optedOut: true })] }));
    expect(await runDigest(conn, options(), d)).toMatchObject({ alreadySent: 0, optedOut: 1 });
  });

  describe("on staging, where DEV_EMAIL_OVERRIDE redirects every address", () => {
    const withOverride = (env: NodeJS.ProcessEnv) => ({ ...FULL_ENV, ...env }) as NodeJS.ProcessEnv;
    let saved: string | undefined;
    beforeEach(() => {
      saved = process.env.DEV_EMAIL_OVERRIDE;
    });
    afterEach(() => {
      if (saved === undefined) delete process.env.DEV_EMAIL_OVERRIDE;
      else process.env.DEV_EMAIL_OVERRIDE = saved;
    });

    it("sends again the same morning, so a tester can re-run it, and leaves the stamp alone", async () => {
      const d = deps(facts({ dueJobs: [due(1)], users: [person(1, { lastSentOn: TODAY })] }));
      const report = await runDigest(conn, options({ env: withOverride({ DEV_EMAIL_OVERRIDE: "inbox@gwe.test" }) }), d);
      expect(d.send).toHaveBeenCalledTimes(1);
      expect(d.record).not.toHaveBeenCalled();
      expect(report).toMatchObject({ alreadySent: 0, sent: 1 });
    });
  });
});

describe("the summary line", () => {
  it("has the counts a TimerRuns row wants: sent, skipped, errors", async () => {
    const d = deps(facts({ dueJobs: [due(1), due(2)], users: [person(1), person(2), person(3), person(4, { optedOut: true })] }), jest.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(undefined));
    const report = await runDigest(conn, options(), d);
    expect(formatDigestSummary(report, "2026-10-14")).toBe(
      "digest 2026-10-14 live: sent=1 skipped=2 errors=1 (nothingToSend=1 optedOut=1 noAddress=0 alreadySent=0)",
    );
  });

  it("counts people already emailed today among those skipped", async () => {
    const d = deps(facts({ dueJobs: [due(1), due(2)], users: [person(1, { lastSentOn: "2026-10-14" }), person(2)] }));
    const report = await runDigest(conn, options(), d);
    expect(formatDigestSummary(report, "2026-10-14")).toBe(
      "digest 2026-10-14 live: sent=1 skipped=1 errors=0 (nothingToSend=0 optedOut=0 noAddress=0 alreadySent=1)",
    );
  });

  it("says would-send for a dry run", async () => {
    const d = deps(facts({ dueJobs: [due(1)], users: [person(1), person(2)] }));
    const report = await runDigest(conn, options({ dryRun: true }), d);
    expect(formatDigestSummary(report, "2026-10-14")).toBe(
      "digest 2026-10-14 dry-run: wouldSend=1 sent=0 skipped=1 errors=0 (nothingToSend=1 optedOut=0 noAddress=0 alreadySent=0)",
    );
  });
});

describe("test records (D9)", () => {
  it("refuses a person's digest that would name a test record, and says why", async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const d = deps(facts({ dueJobs: [due(1, 100)], testKeys: new Set(["job:100"]), users: [person(1)] }), send);
    const report = await runDigest(conn, options(), d);
    expect(send).not.toHaveBeenCalled();
    expect(report.errors).toEqual(["user #1: Not sent: test record"]);
    expect(report.sent).toBe(0);
  });

  it("tells the sender a real digest names no test record", async () => {
    const d = deps(facts({ dueJobs: [due(1, 100)], testKeys: new Set(["job:999"]), users: [person(1)] }));
    await runDigest(conn, options(), d);
    expect(d.send.mock.calls[0][3]).toEqual({ isTest: false });
  });
});
