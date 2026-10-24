/// <reference types="jest" />

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createServiceRequestConnection: jest.fn().mockResolvedValue({ connection: true }) }));
// runTimer (the TimerRuns row, rethrow) has its own tests in __tests__/timerRuns.test.ts;
// here the registered handler is the timer body itself.
jest.mock("../timerRuns", () => ({ runTimer: (_name: string, body: unknown) => body }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn(), flush: jest.fn().mockResolvedValue(true) } }));
jest.mock("../absenceCover/engine", () => ({ runAbsenceCover: jest.fn() }));

import type { InvocationContext, Timer } from "@azure/functions";

const db = require("../db") as { closeConnection: jest.Mock; createServiceRequestConnection: jest.Mock };
const { Sentry } = require("../sentry") as { Sentry: { captureException: jest.Mock; flush: jest.Mock } };
const { runAbsenceCover } = require("../absenceCover/engine") as { runAbsenceCover: jest.Mock };

require("./absenceCoverTimer");
const { app } = require("@azure/functions") as { app: { timer: jest.Mock } };
const registration = app.timer.mock.calls.find((call: unknown[]) => call[0] === "absenceCoverTimer");
const run = (registration?.[1] as { handler: (timer: Timer, context: InvocationContext) => Promise<Record<string, unknown> | void> }).handler;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const report = (over: Record<string, unknown> = {}) => ({
  absent: 2, alreadyHandled: 0, businessDay: true, deferred: 0, dryRun: false, errors: [], escalated: 1, items: 9, moved: 4, notStranded: 0, raced: 0, stayed: 0, suggested: 3, wouldMove: 0, ...over,
});
const KEYS = ["ABSENCE_COVER_ENABLED", "ABSENCE_COVER_DRY_RUN", "ABSENCE_COVER_MAX_ACTIONS", "ABSENCE_INACTIVITY_DAYS", "ACCESS_LOG_ENABLED"] as const;
const SAVED = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of KEYS) delete process.env[key];
  runAbsenceCover.mockResolvedValue(report());
  db.createServiceRequestConnection.mockResolvedValue({ connection: true });
});

afterAll(() => {
  for (const key of KEYS) {
    if (SAVED[key] === undefined) delete process.env[key];
    else process.env[key] = SAVED[key];
  }
});

describe("absenceCoverTimer registration", () => {
  it("runs every 30 minutes on weekdays", () => {
    expect((registration?.[1] as { schedule: string }).schedule).toBe("0 */30 * * * 1-5");
  });
});

describe("with ABSENCE_COVER_ENABLED unset nothing moves", () => {
  it("does nothing, and does not touch the database", async () => {
    expect(await run({} as Timer, ctx)).toBeUndefined();
    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
    expect(runAbsenceCover).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("off"));
  });

  it.each(["TRUE", "1", "yes", ""])("stays off for ABSENCE_COVER_ENABLED=%j", async (value) => {
    process.env.ABSENCE_COVER_ENABLED = value;
    await run({} as Timer, ctx);
    expect(runAbsenceCover).not.toHaveBeenCalled();
  });
});

describe("live and dry run", () => {
  it("runs live with the defaults and closes the connection", async () => {
    process.env.ABSENCE_COVER_ENABLED = "true";
    await run({} as Timer, ctx);
    expect(runAbsenceCover).toHaveBeenCalledWith(expect.objectContaining({ accessLoggingOn: true, connection: { connection: true }, inactivityDays: 3, maxActions: 50, mode: "live" }));
    expect(db.closeConnection).toHaveBeenCalled();
    expect(Sentry.flush).toHaveBeenCalled();
  });

  it("takes the switches from the environment", async () => {
    process.env.ABSENCE_COVER_ENABLED = "true";
    process.env.ABSENCE_COVER_MAX_ACTIONS = "7";
    process.env.ABSENCE_INACTIVITY_DAYS = "5";
    process.env.ACCESS_LOG_ENABLED = "false";
    await run({} as Timer, ctx);
    expect(runAbsenceCover).toHaveBeenCalledWith(expect.objectContaining({ accessLoggingOn: false, inactivityDays: 5, maxActions: 7 }));
  });

  it("runs dry, and the dry run wins over ENABLED", async () => {
    process.env.ABSENCE_COVER_ENABLED = "true";
    process.env.ABSENCE_COVER_DRY_RUN = "true";
    await run({} as Timer, ctx);
    expect(runAbsenceCover).toHaveBeenCalledWith(expect.objectContaining({ mode: "dry-run" }));
  });

  it("runs on the dry run alone", async () => {
    process.env.ABSENCE_COVER_DRY_RUN = "true";
    await run({} as Timer, ctx);
    expect(runAbsenceCover).toHaveBeenCalledWith(expect.objectContaining({ mode: "dry-run" }));
  });

  it("records the run's counts", async () => {
    process.env.ABSENCE_COVER_ENABLED = "true";
    expect(await run({} as Timer, ctx)).toEqual({
      absent: 2, alreadyHandled: 0, businessDay: true, deferred: 0, dryRun: false, escalated: 1, items: 9, moved: 4, notStranded: 0, raced: 0, stayed: 0, suggested: 3, wouldMove: 0,
    });
  });
});

describe("failing loudly", () => {
  it("fails the run when an item failed, and tells Sentry", async () => {
    process.env.ABSENCE_COVER_ENABLED = "true";
    runAbsenceCover.mockResolvedValue(report({ errors: [{ item: "job:12", message: "deadlock" }] }));
    await expect(run({} as Timer, ctx)).rejects.toThrow("1 item(s) failed; first: job:12: deadlock");
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("fails the run, and closes the connection, when the engine throws", async () => {
    process.env.ABSENCE_COVER_ENABLED = "true";
    runAbsenceCover.mockRejectedValue(new Error("no database"));
    await expect(run({} as Timer, ctx)).rejects.toThrow("no database");
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("reports an error for one item to Sentry with where it was", async () => {
    process.env.ABSENCE_COVER_ENABLED = "true";
    await run({} as Timer, ctx);
    const options = runAbsenceCover.mock.calls[0][0] as { onError: (error: unknown, entry: { item: { id: string; type: string } }) => void };
    options.onError(new Error("x"), { item: { id: "12", type: "job" } });
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { extra: { context: "absenceCoverTimer job:12" } });
  });
});
