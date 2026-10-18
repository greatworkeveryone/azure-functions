/// <reference types="jest" />

import { dailyWindow, myobDailyMode, runMyobDaily, type MyobDailyDeps } from "./run";
import type { DailyFacts } from "./types";

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const NOW = new Date("2026-10-13T22:05:00Z"); // Wednesday 14/10 07:35 Darwin
const MAIL = { APP_BASE_URL: "https://floorplan.example", GRAPH_CLIENT_ID: "c", GRAPH_CLIENT_SECRET: "s", GRAPH_SENDER_EMAIL: "noreply@rp", GRAPH_TENANT_ID: "t" };
const CALL = {
  actorKind: "user", actorName: "Johanne", errorMessage: null, httpStatus: 201, method: "POST", occurredAt: new Date("2026-10-13T00:05:00Z"),
  path: `/accountright/${CF}/Purchase/Order/Service`, phase: "response" as const, purpose: "create-order",
};
const facts = (over: Partial<DailyFacts> = {}): DailyFacts => ({ calls: [CALL], controls: [], events: [], files: [{ id: CF, name: "Demo Pty Ltd" }], since: new Date(0), until: NOW, ...over });

function deps(over: Partial<MyobDailyDeps> = {}): MyobDailyDeps & Record<string, jest.Mock> {
  return {
    lastCovered: jest.fn().mockResolvedValue(null),
    load: jest.fn().mockResolvedValue(facts()),
    recipients: jest.fn().mockResolvedValue([{ email: "johanne@rp", name: "Johanne Smith", userId: 12 }]),
    send: jest.fn().mockResolvedValue(undefined),
    ...over,
  } as MyobDailyDeps & Record<string, jest.Mock>;
}
const run = (d: MyobDailyDeps, over: { dryRun?: boolean; env?: NodeJS.ProcessEnv } = {}) =>
  runMyobDaily({} as never, { dryRun: over.dryRun ?? false, env: over.env ?? MAIL, log: jest.fn(), now: NOW }, d);

const saved = process.env.DEV_EMAIL_OVERRIDE;
afterEach(() => {
  if (saved === undefined) delete process.env.DEV_EMAIL_OVERRIDE;
  else process.env.DEV_EMAIL_OVERRIDE = saved;
});

describe("myobDailyMode", () => {
  it("is off unless asked; the dry run wins", () => {
    expect(myobDailyMode({})).toBe("off");
    expect(myobDailyMode({ MYOB_DAILY_EMAIL_ENABLED: "1" })).toBe("off");
    expect(myobDailyMode({ MYOB_DAILY_EMAIL_ENABLED: "true" })).toBe("live");
    expect(myobDailyMode({ MYOB_DAILY_EMAIL_DRY_RUN: "true", MYOB_DAILY_EMAIL_ENABLED: "true" })).toBe("dry-run");
  });
});

describe("dailyWindow", () => {
  it("runs from the previous business morning at 07:30 Darwin, so Monday's covers the weekend", () => {
    expect(dailyWindow(NOW, {})).toEqual({ gapSince: null, since: new Date("2026-10-12T22:00:00Z"), until: new Date("2026-10-13T22:00:00Z") });
    const monday = new Date("2026-10-18T22:05:00Z"); // Monday 19/10 07:35 Darwin
    expect(dailyWindow(monday, {}).since).toEqual(new Date("2026-10-15T22:00:00Z")); // Friday 16/10 07:30
  });
});

describe("dailyWindow from the last run that covered a day", () => {
  it("starts where the last successful run of the same kind ended, so a skipped or failed day is not lost", () => {
    const lastOk = new Date("2026-10-11T22:01:00Z"); // Monday 12/10 07:31 Darwin
    expect(dailyWindow(NOW, {}, lastOk)).toEqual({ gapSince: null, since: new Date("2026-10-11T22:00:00Z"), until: new Date("2026-10-13T22:00:00Z") });
  });

  it("goes back at most 14 days, and covers nothing twice on a second run the same morning", () => {
    expect(dailyWindow(NOW, {}, new Date("2026-08-01T22:00:00Z")).since).toEqual(new Date("2026-09-29T22:00:00Z"));
    const window = dailyWindow(NOW, {}, new Date("2026-10-13T22:01:00Z"));
    expect(window.since).toEqual(window.until);
  });
});

describe("runMyobDaily", () => {
  it("tells the email when the window was capped after a longer gap", async () => {
    const d = deps({ lastCovered: jest.fn().mockResolvedValue(new Date("2026-08-01T22:00:00Z")) });
    await run(d);
    expect(d.send).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.stringContaining("This email could not be sent since 02/08 07:30. This one covers the last 14 days"), { isTest: false });
  });

  it("asks for the last run of its own kind (live or dry run) and reads from where it ended", async () => {
    const d = deps({ lastCovered: jest.fn().mockResolvedValue(new Date("2026-10-11T22:01:00Z")) });
    await run(d);
    expect(d.lastCovered).toHaveBeenCalledWith(expect.anything(), false);
    expect(d.load).toHaveBeenCalledWith(expect.anything(), new Date("2026-10-11T22:00:00Z"), new Date("2026-10-13T22:00:00Z"));
    await run(d, { dryRun: true, env: {} });
    expect(d.lastCovered).toHaveBeenLastCalledWith(expect.anything(), true);
  });

  it("emails each CFO through the digest's send path, with the window's facts", async () => {
    const d = deps();
    const report = await run(d);
    expect(d.load).toHaveBeenCalledWith(expect.anything(), new Date("2026-10-12T22:00:00Z"), new Date("2026-10-13T22:00:00Z"));
    expect(d.send).toHaveBeenCalledWith(["johanne@rp"], "What Floorplan did in MYOB, 14/10/2026", expect.stringContaining("Good morning Johanne,"), { isTest: false });
    expect(report).toMatchObject({ calls: 1, errors: [], recipients: 1, sent: 1 });
  });

  it("sends nothing when Floorplan did nothing in MYOB, or only in files the CFO hasn't registered", async () => {
    for (const quiet of [facts({ calls: [] }), facts({ files: [] })]) {
      const d = deps({ load: jest.fn().mockResolvedValue(quiet) });
      expect(await run(d)).toMatchObject({ nothingToSend: true, sent: 0 });
      expect(d.send).not.toHaveBeenCalled();
      expect(d.recipients).not.toHaveBeenCalled();
    }
  });

  it("in a dry run builds and logs the email but sends nothing, even without mail settings", async () => {
    const d = deps();
    expect(await run(d, { dryRun: true, env: {} })).toMatchObject({ sent: 0, wouldSend: 1 });
    expect(d.send).not.toHaveBeenCalled();
  });

  it("refuses to run live without the mail settings, reading nothing", async () => {
    const d = deps();
    const report = await run(d, { env: {} });
    expect(report.configMissing.length).toBeGreaterThan(0);
    expect(d.load).not.toHaveBeenCalled();
  });

  it("goes through DEV_EMAIL_OVERRIDE, counts a CFO with no address, and keeps going after one failed send", async () => {
    process.env.DEV_EMAIL_OVERRIDE = "dev@rp";
    const d = deps({
      recipients: jest.fn().mockResolvedValue([{ email: "johanne@rp", name: "Johanne", userId: 12 }, { email: "second@rp", name: "Ana", userId: 13 }]),
      send: jest.fn().mockRejectedValueOnce(new Error("Graph 503")).mockResolvedValue(undefined),
    });
    const report = await run(d);
    expect(d.send).toHaveBeenCalledWith(["dev@rp"], expect.any(String), expect.stringContaining("meant for johanne@rp"), { isTest: false });
    expect(report).toMatchObject({ errors: ["user #12: Graph 503"], sent: 1 });
    delete process.env.DEV_EMAIL_OVERRIDE;
    const none = deps({ recipients: jest.fn().mockResolvedValue([{ email: null, name: "Johanne", userId: 12 }]) });
    const unsent = await run(none);
    expect(unsent).toMatchObject({ noAddress: 1, sent: 0 });
    expect(unsent.errors).toEqual([expect.stringContaining("nobody was sent")]);
  });

  it("reports an error when there is something to tell but no active CFO", async () => {
    const report = await run(deps({ recipients: jest.fn().mockResolvedValue([]) }));
    expect(report.errors).toEqual([expect.stringContaining("No active user has the cfo role")]);
  });
});

describe("test records (D9)", () => {
  const EVENT = {
    action: "myob.push", actorName: "Johanne", after: null, companyFileId: CF, companyFileName: "Demo Pty Ltd", jobId: 42, myobNumber: "66Sm1",
    myobUrl: null, occurredAt: new Date("2026-10-13T00:05:00Z"), operation: "orders.create", proposalId: 7, proposedBy: "Cam", reason: null,
    rendered: { number: "66Sm1" }, reviewedBy: "Johanne", ruleApplied: null, subjectId: 70, subjectType: "purchase_order",
  };

  it("sends nothing that names a test job, and says why", async () => {
    const d = deps({ load: jest.fn().mockResolvedValue(facts({ events: [EVENT], testKeys: new Set(["job:42"]) })) });
    const report = await run(d);
    expect(d.send).not.toHaveBeenCalled();
    expect(report.errors).toEqual(["user #12: Not sent: test record"]);
  });

  it.each([
    ["purchase_order", 70],
    ["quote", 71],
    ["invoice", 72],
  ])("also refuses an email naming a test %s on a real job", async (subjectType, subjectId) => {
    const d = deps({
      load: jest.fn().mockResolvedValue(facts({ events: [{ ...EVENT, subjectId, subjectType }], testKeys: new Set([`${subjectType}:${subjectId}`]) })),
    });
    const report = await run(d);
    expect(d.send).not.toHaveBeenCalled();
    expect(report.errors).toEqual(["user #12: Not sent: test record"]);
  });

  it("tells the sender a real email names no test record", async () => {
    const d = deps({ load: jest.fn().mockResolvedValue(facts({ events: [EVENT], testKeys: new Set(["job:41"]) })) });
    await run(d);
    expect((d.send as jest.Mock).mock.calls[0][3]).toEqual({ isTest: false });
  });
});
