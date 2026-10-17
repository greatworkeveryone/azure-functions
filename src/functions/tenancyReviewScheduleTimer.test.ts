/// <reference types="jest" />

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({ connection: true }),
}));
jest.mock("../sentry", () => ({
  Sentry: { captureException: jest.fn(), captureMessage: jest.fn(), flush: jest.fn().mockResolvedValue(true) },
}));
// Run recording has its own tests (timerRuns.test.ts); here the body runs as registered.
jest.mock("../timerRuns", () => ({ runTimer: (_name: string, body: unknown) => body }));
jest.mock("../rentReview/generator", () => {
  const actual = jest.requireActual("../rentReview/generator");
  return { ...actual, runReviewGenerator: jest.fn() };
});

import type { InvocationContext, Timer } from "@azure/functions";

const db = require("../db") as { closeConnection: jest.Mock; createServiceRequestConnection: jest.Mock };
const { Sentry } = require("../sentry") as { Sentry: { captureException: jest.Mock; captureMessage: jest.Mock; flush: jest.Mock } };
const { runReviewGenerator } = require("../rentReview/generator") as { runReviewGenerator: jest.Mock };

require("./tenancyReviewScheduleTimer");
const { app } = require("@azure/functions") as { app: { timer: jest.Mock } };
const registration = app.timer.mock.calls.find((c: unknown[]) => c[0] === "tenancyReviewScheduleTimer");
const run = (registration?.[1] as { handler: (t: Timer, c: InvocationContext) => Promise<void> }).handler;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const report = (over: Record<string, unknown> = {}) => ({
  drift: [],
  dryRun: false,
  errors: [],
  raced: 0,
  scheduled: 0,
  tenancies: 0,
  unchanged: 0,
  windowsOpened: 0,
  ...over,
});

const KEYS = ["RENT_REVIEW_GENERATOR_DRY_RUN", "RENT_REVIEW_GENERATOR_ENABLED", "REVIEW_WINDOW_DAYS"] as const;
const SAVED = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of KEYS) delete process.env[key];
  runReviewGenerator.mockResolvedValue(report());
  db.createServiceRequestConnection.mockResolvedValue({ connection: true });
});

afterAll(() => {
  for (const key of KEYS) {
    const value = SAVED[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("tenancyReviewScheduleTimer registration", () => {
  it("runs daily at 02:00 UTC", () => {
    expect((registration?.[1] as { schedule: string }).schedule).toBe("0 0 2 * * *");
  });
});

describe("opt-in", () => {
  it("does nothing, and does not touch the database, unless it is switched on", async () => {
    await run({} as Timer, ctx);

    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
    expect(runReviewGenerator).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("RENT_REVIEW_GENERATOR_ENABLED=true"));
  });

  it.each(["1", "yes", "TRUE", "True", " true", ""])("is not switched on by RENT_REVIEW_GENERATOR_ENABLED=%j", async (value) => {
    process.env.RENT_REVIEW_GENERATOR_ENABLED = value;
    await run({} as Timer, ctx);
    expect(runReviewGenerator).not.toHaveBeenCalled();
  });

  it("writes only when RENT_REVIEW_GENERATOR_ENABLED is exactly true", async () => {
    process.env.RENT_REVIEW_GENERATOR_ENABLED = "true";

    await run({} as Timer, ctx);

    expect(runReviewGenerator).toHaveBeenCalledTimes(1);
    expect(runReviewGenerator.mock.calls[0][0]).toMatchObject({ connection: { connection: true }, dryRun: false, windowDays: 60 });
    expect(db.closeConnection).toHaveBeenCalledWith({ connection: true });
  });

  it("logs and writes nothing in a dry run, even when it is also enabled", async () => {
    process.env.RENT_REVIEW_GENERATOR_DRY_RUN = "true";
    process.env.RENT_REVIEW_GENERATOR_ENABLED = "true";

    await run({} as Timer, ctx);

    expect(runReviewGenerator.mock.calls[0][0]).toMatchObject({ dryRun: true });
  });

  it("runs a dry run without being enabled, so the counts can be read first", async () => {
    process.env.RENT_REVIEW_GENERATOR_DRY_RUN = "true";
    await run({} as Timer, ctx);
    expect(runReviewGenerator.mock.calls[0][0]).toMatchObject({ dryRun: true });
  });
});

describe("running", () => {
  beforeEach(() => {
    process.env.RENT_REVIEW_GENERATOR_ENABLED = "true";
  });

  it("hands the generator a fresh service connection, the Functions logger and the review window", async () => {
    process.env.REVIEW_WINDOW_DAYS = "45";

    await run({} as Timer, ctx);

    const options = runReviewGenerator.mock.calls[0][0] as { log: (m: string) => void; warn: (m: string) => void; windowDays: number };
    expect(options.windowDays).toBe(45);
    options.log("hello");
    options.warn("careful");
    expect(ctx.log).toHaveBeenCalledWith("hello");
    expect(ctx.warn).toHaveBeenCalledWith("careful");
  });

  it("reports each tenancy that failed to Sentry and fails the run when any did", async () => {
    runReviewGenerator.mockResolvedValue(report({ errors: [{ message: "boom", tenantId: 7 }] }));

    await expect(run({} as Timer, ctx)).rejects.toThrow("1 tenancy(ies) failed; first: boom");

    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { extra: { context: "tenancyReviewScheduleTimer fatal" } });
    const options = runReviewGenerator.mock.calls[0][0] as { onError: (e: unknown, tenantId: number) => void };
    options.onError(new Error("x"), 7);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), { extra: { context: "tenancyReviewScheduleTimer TenantId=7" } });
  });

  it("stays quiet when nothing failed, and returns the run's counts", async () => {
    runReviewGenerator.mockResolvedValue(
      report({ drift: [], dryRun: false, raced: 0, scheduled: 3, tenancies: 5, unchanged: 2, windowsOpened: 1 }),
    );
    await expect(run({} as Timer, ctx)).resolves.toEqual({
      drift: 0,
      dryRun: false,
      raced: 0,
      scheduled: 3,
      tenancies: 5,
      unchanged: 2,
      windowsOpened: 1,
    });
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("closes the connection, flushes Sentry and rethrows when the run itself fails", async () => {
    runReviewGenerator.mockRejectedValue(new Error("database down"));

    await expect(run({} as Timer, ctx)).rejects.toThrow("database down");

    expect(Sentry.captureException).toHaveBeenCalled();
    expect(db.closeConnection).toHaveBeenCalledWith({ connection: true });
    expect(Sentry.flush).toHaveBeenCalled();
  });
});
