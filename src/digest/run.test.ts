/// <reference types="jest" />
import type { Connection } from "tedious";
import type { AuthorityFacts } from "../approvalAuthority";
import { formatDigestSummary, runDigest, type DigestDeps } from "./run";
import type { DigestFacts, DigestUser, DueJob } from "./types";

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
  email: `user${userId}@example.test`, name: `Person ${userId}`, optedOut: false, role: "facilities", userId, ...over,
});
const due = (assignedToUserId: number, jobId = assignedToUserId * 100): DueJob => ({
  assignedToUserId, buildingName: "Tower A", expectedProgressUpdate: new Date("2026-10-13T14:30:00Z"), jobId, title: "Paint stairwell",
});
const facts = (over: Partial<DigestFacts> = {}): DigestFacts => ({ dueJobs: [], escalations: [], overdueKeys: [], users: [], waitingApprovals: [], ...over });

function deps(f: DigestFacts, send: jest.Mock = jest.fn().mockResolvedValue(undefined)): DigestDeps & { send: jest.Mock } {
  return { authority: jest.fn().mockResolvedValue(() => authority), load: jest.fn().mockResolvedValue(f), send };
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

describe("the summary line", () => {
  it("has the counts a TimerRuns row wants: sent, skipped, errors", async () => {
    const d = deps(facts({ dueJobs: [due(1), due(2)], users: [person(1), person(2), person(3), person(4, { optedOut: true })] }), jest.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue(undefined));
    const report = await runDigest(conn, options(), d);
    expect(formatDigestSummary(report, "2026-10-14")).toBe(
      "digest 2026-10-14 live: sent=1 skipped=2 errors=1 (nothingToSend=1 optedOut=1 noAddress=0)",
    );
  });

  it("says would-send for a dry run", async () => {
    const d = deps(facts({ dueJobs: [due(1)], users: [person(1), person(2)] }));
    const report = await runDigest(conn, options({ dryRun: true }), d);
    expect(formatDigestSummary(report, "2026-10-14")).toBe(
      "digest 2026-10-14 dry-run: wouldSend=1 sent=0 skipped=1 errors=0 (nothingToSend=1 optedOut=0 noAddress=0)",
    );
  });
});
