/// <reference types="jest" />

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({ connection: true }),
}));
// runTimer (TimerRuns row, rethrow) has its own tests in __tests__/timerRuns.test.ts;
// here the registered handler is the timer body itself.
jest.mock("../timerRuns", () => ({ runTimer: (_name: string, body: unknown) => body }));
jest.mock("../sentry", () => ({
  Sentry: { captureException: jest.fn(), captureMessage: jest.fn(), flush: jest.fn().mockResolvedValue(true) },
}));
jest.mock("../escalation/sweep", () => ({ runSweep: jest.fn() }));

import type { InvocationContext, Timer } from "@azure/functions";
import { DEFAULT_SWEEP_MAX_ACTIONS, sweepMaxActions, sweepMode } from "../escalation/config";

const db = require("../db") as { closeConnection: jest.Mock; createServiceRequestConnection: jest.Mock };
const { Sentry } = require("../sentry") as { Sentry: { captureException: jest.Mock; captureMessage: jest.Mock; flush: jest.Mock } };
const { runSweep } = require("../escalation/sweep") as { runSweep: jest.Mock };

require("./escalationSweepTimer");
const { app } = require("@azure/functions") as { app: { timer: jest.Mock } };
const registration = app.timer.mock.calls.find((c: unknown[]) => c[0] === "escalationSweepTimer");
const run = (registration?.[1] as { handler: (t: Timer, c: InvocationContext) => Promise<void> }).handler;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const report = (over: Record<string, unknown> = {}) => ({ errors: [], truncated: false, ...over });

const SAVED = { dry: process.env.ESCALATION_SWEEP_DRY_RUN, enabled: process.env.ESCALATION_SWEEP_ENABLED };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.ESCALATION_SWEEP_ENABLED;
  delete process.env.ESCALATION_SWEEP_DRY_RUN;
  runSweep.mockResolvedValue(report());
  db.createServiceRequestConnection.mockResolvedValue({ connection: true });
});

afterAll(() => {
  for (const [key, value] of [["ESCALATION_SWEEP_DRY_RUN", SAVED.dry], ["ESCALATION_SWEEP_ENABLED", SAVED.enabled]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("escalationSweepTimer registration", () => {
  it("runs every 30 minutes, on its own", () => {
    expect((registration?.[1] as { schedule: string }).schedule).toBe("0 */30 * * * *");
  });
});

describe("opt-in", () => {
  it("does nothing, and does not touch the database, unless it is switched on", async () => {
    await run({} as Timer, ctx);

    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
    expect(runSweep).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("ESCALATION_SWEEP_ENABLED=true"));
  });

  it.each(["1", "yes", "TRUE", "True", " true", ""])("is not switched on by ESCALATION_SWEEP_ENABLED=%j", async (value) => {
    process.env.ESCALATION_SWEEP_ENABLED = value;
    await run({} as Timer, ctx);
    expect(runSweep).not.toHaveBeenCalled();
  });

  it("writes only when ESCALATION_SWEEP_ENABLED is exactly true", async () => {
    process.env.ESCALATION_SWEEP_ENABLED = "true";

    await run({} as Timer, ctx);

    expect(runSweep).toHaveBeenCalledTimes(1);
    expect(runSweep.mock.calls[0][0]).toEqual({ connection: true });
    expect(runSweep.mock.calls[0][1]).toMatchObject({ dryRun: false });
    expect(db.closeConnection).toHaveBeenCalledWith({ connection: true });
  });

  it("logs and writes nothing in a dry run, even when it is also enabled", async () => {
    process.env.ESCALATION_SWEEP_DRY_RUN = "true";
    process.env.ESCALATION_SWEEP_ENABLED = "true";

    await run({} as Timer, ctx);

    expect(runSweep.mock.calls[0][1]).toMatchObject({ dryRun: true });
  });

  it("runs a dry run without being enabled, so the counts can be read first", async () => {
    process.env.ESCALATION_SWEEP_DRY_RUN = "true";
    await run({} as Timer, ctx);
    expect(runSweep.mock.calls[0][1]).toMatchObject({ dryRun: true });
  });

  it("knows its mode", () => {
    expect(sweepMode({} as NodeJS.ProcessEnv)).toBe("off");
    expect(sweepMode({ ESCALATION_SWEEP_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe("live");
    expect(sweepMode({ ESCALATION_SWEEP_DRY_RUN: "true" } as NodeJS.ProcessEnv)).toBe("dry-run");
    expect(sweepMode({ ESCALATION_SWEEP_DRY_RUN: "true", ESCALATION_SWEEP_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe("dry-run");
    expect(sweepMode({ ESCALATION_SWEEP_DRY_RUN: "false", ESCALATION_SWEEP_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe("off");
  });

  it("reads the action limit", () => {
    expect(sweepMaxActions({} as NodeJS.ProcessEnv)).toBe(DEFAULT_SWEEP_MAX_ACTIONS);
    expect(sweepMaxActions({ ESCALATION_SWEEP_MAX_ACTIONS: "25" } as NodeJS.ProcessEnv)).toBe(25);
    for (const bad of ["0", "-3", "abc", "1.5", " "]) {
      expect(sweepMaxActions({ ESCALATION_SWEEP_MAX_ACTIONS: bad } as NodeJS.ProcessEnv)).toBe(DEFAULT_SWEEP_MAX_ACTIONS);
    }
  });
});

describe("running", () => {
  beforeEach(() => {
    process.env.ESCALATION_SWEEP_ENABLED = "true";
  });

  it("hands the sweep a fresh service connection and the Functions logger", async () => {
    await run({} as Timer, ctx);

    const options = runSweep.mock.calls[0][1] as { log: (m: string) => void; warn: (m: string) => void };
    options.log("hello");
    options.warn("careful");
    expect(ctx.log).toHaveBeenCalledWith("hello");
    expect(ctx.warn).toHaveBeenCalledWith("careful");
  });

  it("tells Sentry when the run stopped at its limit or had problems", async () => {
    runSweep.mockResolvedValue(report({ errors: ["raising job.past_due on job #4: Graph is down"], truncated: true }));

    await run({} as Timer, ctx);

    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining("action limit"), "warning");
    expect(Sentry.captureMessage).toHaveBeenCalledWith("Escalation sweep finished with 1 problem(s): raising job.past_due on job #4: Graph is down", "error");
  });

  it("stays quiet when the run was clean", async () => {
    await run({} as Timer, ctx);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("reports a crash to Sentry, fails the run, and still closes the connection", async () => {
    const boom = new Error("connection lost");
    runSweep.mockRejectedValue(boom);

    await expect(run({} as Timer, ctx)).rejects.toBe(boom);

    expect(Sentry.captureException).toHaveBeenCalledWith(boom, expect.objectContaining({ tags: { source: "escalation_sweep_timer" } }));
    expect(db.closeConnection).toHaveBeenCalled();
    expect(Sentry.flush).toHaveBeenCalled();
  });

  it("fails the run when it cannot even connect", async () => {
    db.createServiceRequestConnection.mockRejectedValue(new Error("login failed"));
    await expect(run({} as Timer, ctx)).rejects.toThrow("login failed");
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(db.closeConnection).not.toHaveBeenCalled();
  });
});
