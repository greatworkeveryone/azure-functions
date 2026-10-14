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
jest.mock("../digest/run", () => ({ ...jest.requireActual("../digest/run"), runDigest: jest.fn() }));

import type { InvocationContext, Timer } from "@azure/functions";
import { DIGEST_CRON } from "../digest/schedule";
import { digestMode } from "../digest/config";

const db = require("../db") as { closeConnection: jest.Mock; createServiceRequestConnection: jest.Mock };
const { Sentry } = require("../sentry") as { Sentry: { captureException: jest.Mock; captureMessage: jest.Mock; flush: jest.Mock } };
const { runDigest } = require("../digest/run") as { runDigest: jest.Mock };

require("./digestTimer");
const { app } = require("@azure/functions") as { app: { timer: jest.Mock } };
const registration = app.timer.mock.calls.find((c: unknown[]) => c[0] === "digestTimer");
const run = (registration?.[1] as { handler: (t: Timer, c: InvocationContext) => Promise<void> }).handler;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const report = (over: Record<string, unknown> = {}) => ({
  configMissing: [], considered: 5, dryRun: false, errors: [], noAddress: 0, nothingToSend: 2, optedOut: 1, sent: 2, wouldSend: 0, ...over,
});

const KEYS = ["DIGEST_ENABLED", "DIGEST_DRY_RUN", "ESCALATION_HOLIDAYS"] as const;
const SAVED = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
const MORNING = new Date("2026-10-13T22:00:00Z"); // 07:30 Wednesday in Darwin

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"], now: MORNING });
  for (const k of KEYS) delete process.env[k];
  runDigest.mockResolvedValue(report());
  db.createServiceRequestConnection.mockResolvedValue({ connection: true });
});

afterEach(() => jest.useRealTimers());

afterAll(() => {
  for (const k of KEYS) {
    const v = SAVED[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("registration", () => {
  it("runs at 07:30 Darwin on business days (22:00 UTC Sunday to Thursday)", () => {
    expect((registration?.[1] as { schedule: string }).schedule).toBe(DIGEST_CRON);
    expect(DIGEST_CRON).toBe("0 0 22 * * 0-4");
  });
});

describe("opt-in", () => {
  it("does nothing, and does not touch the database, unless it is switched on", async () => {
    await run({} as Timer, ctx);
    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
    expect(runDigest).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("DIGEST_ENABLED=true"));
  });

  it.each(["1", "yes", "TRUE", "True", " true", ""])("is not switched on by DIGEST_ENABLED=%j", async (value) => {
    process.env.DIGEST_ENABLED = value;
    await run({} as Timer, ctx);
    expect(runDigest).not.toHaveBeenCalled();
  });

  it("sends only when DIGEST_ENABLED is exactly true", async () => {
    process.env.DIGEST_ENABLED = "true";
    await run({} as Timer, ctx);
    expect(runDigest).toHaveBeenCalledTimes(1);
    expect(runDigest.mock.calls[0][0]).toEqual({ connection: true });
    expect(runDigest.mock.calls[0][1]).toMatchObject({ dryRun: false });
    expect(db.closeConnection).toHaveBeenCalledWith({ connection: true });
  });

  it("logs and sends nothing in a dry run, even when it is also enabled", async () => {
    process.env.DIGEST_DRY_RUN = "true";
    process.env.DIGEST_ENABLED = "true";
    await run({} as Timer, ctx);
    expect(runDigest.mock.calls[0][1]).toMatchObject({ dryRun: true });
  });

  it("runs a dry run without being enabled, so the lines can be read first", async () => {
    process.env.DIGEST_DRY_RUN = "true";
    await run({} as Timer, ctx);
    expect(runDigest.mock.calls[0][1]).toMatchObject({ dryRun: true });
  });

  it("knows its mode", () => {
    expect(digestMode({} as NodeJS.ProcessEnv)).toBe("off");
    expect(digestMode({ DIGEST_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe("live");
    expect(digestMode({ DIGEST_DRY_RUN: "true" } as NodeJS.ProcessEnv)).toBe("dry-run");
    expect(digestMode({ DIGEST_DRY_RUN: "true", DIGEST_ENABLED: "true" } as NodeJS.ProcessEnv)).toBe("dry-run");
    expect(digestMode({ DIGEST_DRY_RUN: "false", DIGEST_ENABLED: "false" } as NodeJS.ProcessEnv)).toBe("off");
  });
});

describe("business days and the morning window", () => {
  beforeEach(() => {
    process.env.DIGEST_ENABLED = "true";
  });

  it("does not run on a Darwin weekend and does not touch the database", async () => {
    jest.setSystemTime(new Date("2026-10-16T22:00:00Z")); // 07:30 Saturday
    await run({} as Timer, ctx);
    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringMatching(/weekend/));
  });

  it("does not run on a public holiday", async () => {
    process.env.ESCALATION_HOLIDAYS = "2026-10-14";
    await run({} as Timer, ctx);
    expect(runDigest).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringMatching(/holiday/));
  });

  it("does not send a morning digest in the afternoon when a missed run catches up", async () => {
    jest.setSystemTime(new Date("2026-10-14T06:00:00Z")); // 15:30 Darwin
    await run({ isPastDue: true } as Timer, ctx);
    expect(runDigest).not.toHaveBeenCalled();
    expect(ctx.log).toHaveBeenCalledWith(expect.stringMatching(/too_late/));
  });

  it("hands the run the current instant", async () => {
    await run({} as Timer, ctx);
    expect(runDigest.mock.calls[0][1].now).toEqual(MORNING);
  });
});

describe("logging and failure", () => {
  beforeEach(() => {
    process.env.DIGEST_ENABLED = "true";
  });

  it("logs one summary line with the counts", async () => {
    await run({} as Timer, ctx);
    expect(ctx.log).toHaveBeenCalledWith("digest 2026-10-14 live: sent=2 skipped=3 errors=0 (nothingToSend=2 optedOut=1 noAddress=0)");
  });

  it("tells Sentry about failed sends but keeps the run when some went out", async () => {
    runDigest.mockResolvedValue(report({ errors: ["user #4: Graph sendMail failed: 429"], sent: 1 }));
    await run({} as Timer, ctx);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining("1 of 2"), "error");
    expect(ctx.error).toHaveBeenCalled();
  });

  it("fails the run when every send failed", async () => {
    runDigest.mockResolvedValue(report({ errors: ["user #1: down", "user #2: down"], sent: 0 }));
    await expect(run({} as Timer, ctx)).rejects.toThrow(/every send failed/i);
  });

  it("fails the run, and says which settings, when the mail settings are missing", async () => {
    runDigest.mockResolvedValue(report({ configMissing: ["GRAPH_SENDER_EMAIL"], errors: ["Notification settings are missing: GRAPH_SENDER_EMAIL"], sent: 0 }));
    await expect(run({} as Timer, ctx)).rejects.toThrow(/GRAPH_SENDER_EMAIL/);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringContaining("GRAPH_SENDER_EMAIL"), "error");
  });

  it("reports a crash to Sentry, fails the run, and still closes the connection", async () => {
    const boom = new Error("Invalid column name 'DigestOptOut'");
    runDigest.mockRejectedValue(boom);
    await expect(run({} as Timer, ctx)).rejects.toBe(boom);
    expect(Sentry.captureException).toHaveBeenCalledWith(boom, expect.objectContaining({ tags: { source: "digest_timer" } }));
    expect(db.closeConnection).toHaveBeenCalled();
    expect(Sentry.flush).toHaveBeenCalled();
  });

  it("fails the run when it cannot even connect", async () => {
    db.createServiceRequestConnection.mockRejectedValue(new Error("login failed"));
    await expect(run({} as Timer, ctx)).rejects.toThrow("login failed");
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(db.closeConnection).not.toHaveBeenCalled();
  });

  it("stays quiet with Sentry when the run was clean", async () => {
    await run({} as Timer, ctx);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
