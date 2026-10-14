/// <reference types="jest" />
// DL-12: a timer that fails must fail where someone sees it — a TimerRuns row,
// the error log, Sentry, and a failed invocation in Azure — never a quiet
// "complete".
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { InvocationContext, Timer } from "@azure/functions";

jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
jest.mock("../sentry", () => ({
  Sentry: { captureException: jest.fn(), flush: jest.fn().mockResolvedValue(true) },
}));

import { runTimer, TIMER_NAMES } from "../timerRuns";

const db = jest.requireMock("../db") as Record<"closeConnection" | "createServiceRequestConnection" | "executeQuery", jest.Mock>;
const { Sentry } = jest.requireMock("../sentry") as { Sentry: { captureException: jest.Mock; flush: jest.Mock } };

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const timer = { isPastDue: false } as unknown as Timer;
const FUNCTIONS = join(__dirname, "..", "functions");

const writes = () =>
  db.executeQuery.mock.calls.map((c: unknown[]) => ({
    params: Object.fromEntries(((c[2] as { name: string; value: unknown }[]) ?? []).map((p) => [p.name, p.value])),
    sql: String(c[1]),
  }));

beforeEach(() => {
  jest.clearAllMocks();
  db.createServiceRequestConnection.mockResolvedValue({});
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
    /INSERT INTO dbo\.TimerRuns/.test(sql) ? [{ TimerRunId: 41 }] : [],
  );
});

describe("runTimer", () => {
  it("records Outcome 'error' with the message, tells Sentry, and rethrows", async () => {
    const boom = new Error("Invalid object name 'dbo.GraphSubscriptions'.");
    const run = runTimer("renewGraphSubscription", async () => {
      throw boom;
    });

    await expect(run(timer, ctx)).rejects.toBe(boom);

    const [start, finish] = writes();
    expect(start.sql).toMatch(/INSERT INTO dbo\.TimerRuns[\s\S]*'running'/);
    expect(start.params.Name).toBe("renewGraphSubscription");
    expect(finish.sql).toMatch(/UPDATE dbo\.TimerRuns SET[\s\S]*WHERE TimerRunId = @Id/);
    expect(finish.params).toMatchObject({ Error: boom.message, Id: 41, Outcome: "error" });
    expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining("renewGraphSubscription failed"));
    expect(Sentry.captureException).toHaveBeenCalledWith(boom, { tags: { timer: "renewGraphSubscription" } });
    expect(Sentry.flush).toHaveBeenCalled();
  });

  it("records Outcome 'ok' with the counts the body returns", async () => {
    await runTimer("cleanupAttachmentsTimer", async () => ({ deleted: 2, failed: 0, scanned: 2 }))(timer, ctx);
    const finish = writes()[1];
    expect(finish.params).toMatchObject({ Counts: '{"deleted":2,"failed":0,"scanned":2}', Error: null, Outcome: "ok" });
  });

  it("still runs the timer, and still fails it, when the run can't be recorded", async () => {
    db.createServiceRequestConnection.mockRejectedValue(new Error("Login failed"));
    const body = jest.fn().mockRejectedValue(new Error("myBuildings 500"));
    await expect(runTimer("syncAllWorkRequestsTimer", body)(timer, ctx)).rejects.toThrow("myBuildings 500");
    expect(body).toHaveBeenCalled();
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringContaining("could not record"));
  });

  it("writes a whole row at the end when the start row never landed", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("timeout")).mockResolvedValue([]);
    await runTimer("ledgerVerifyTimer", async () => undefined)(timer, ctx);
    const finish = writes()[1];
    expect(finish.sql).toMatch(/INSERT INTO dbo\.TimerRuns \(Name, StartedAt, FinishedAt, Outcome, Error, Counts\)/);
    expect(finish.params).toMatchObject({ Name: "ledgerVerifyTimer", Outcome: "ok" });
  });
});

describe("every timer is wrapped", () => {
  const registrations = readdirSync(FUNCTIONS)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .flatMap((f) =>
      [...readFileSync(join(FUNCTIONS, f), "utf8").matchAll(/app\.timer\(\s*"([^"]+)"\s*,\s*\{([\s\S]*?)\n\}\);/g)].map((m) => ({
        block: m[2],
        file: f,
        name: m[1],
      })),
    );

  it("registers exactly the timers TIMER_NAMES lists", () => {
    expect(registrations.map((r) => r.name).sort()).toEqual([...TIMER_NAMES].sort());
  });

  it.each(registrations)("$name hands its handler to runTimer under its own name", ({ block, name }) => {
    expect(block).toMatch(new RegExp(`handler:\\s*runTimer\\(\\s*"${name}"`));
  });

  it("no longer ships sqlKeepWarmTimer (SQL is always on)", () => {
    expect(existsSync(join(FUNCTIONS, "sqlKeepWarmTimer.ts"))).toBe(false);
  });
});
