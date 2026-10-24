/// <reference types="jest" />
import type { InvocationContext, Timer } from "@azure/functions";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { timer: jest.fn() } }));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createServiceRequestConnection: jest.fn(async () => ({})) }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn(), flush: jest.fn(async () => true) } }));
jest.mock("../usage/rollup", () => ({ ...jest.requireActual("../usage/rollup"), rollUpDays: jest.fn(async () => ({ days: 3, inserted: 2, updated: 5 })) }));
jest.mock("../usage/purge", () => ({
  ...jest.requireActual("../usage/purge"),
  purgeUsage: jest.fn(async (_c: unknown, o: { dryRun: boolean }) => ({ cutoffDay: "2026-04-27", dryRun: o.dryRun, sessionsDeleted: 0, sessionsEligible: 0, viewsDeleted: 0, viewsEligible: 0 })),
}));

import { createServiceRequestConnection } from "../db";
import { Sentry } from "../sentry";
import { purgeUsage } from "../usage/purge";
import { rollUpDays } from "../usage/rollup";
import { usagePurgeTimer } from "./usagePurgeTimer";
import { usageRollupTimer } from "./usageRollupTimer";

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const timer = { isPastDue: false } as unknown as Timer;
const KEYS = ["USAGE_TRACKING_ENABLED", "USAGE_PURGE_ENABLED", "USAGE_PURGE_DRY_RUN", "USAGE_RETENTION_DAYS"] as const;
const saved = Object.fromEntries(KEYS.map((key) => [key, process.env[key]]));

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of KEYS) delete process.env[key];
});
afterAll(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("usageRollupTimer", () => {
  it("does nothing, and does not touch the database, while tracking is off", async () => {
    expect(await usageRollupTimer(timer, ctx)).toBeUndefined();
    expect(createServiceRequestConnection).not.toHaveBeenCalled();
    expect(rollUpDays).not.toHaveBeenCalled();
  });

  it("rolls up the last three Darwin days and returns its counts when tracking is on", async () => {
    process.env.USAGE_TRACKING_ENABLED = "true";
    expect(await usageRollupTimer(timer, ctx)).toEqual({ days: 3, inserted: 2, updated: 5 });
    const [, from, to] = jest.mocked(rollUpDays).mock.calls[0];
    expect(from < to).toBe(true);
  });

  it("fails loudly: it tells Sentry and rethrows", async () => {
    process.env.USAGE_TRACKING_ENABLED = "true";
    jest.mocked(rollUpDays).mockRejectedValueOnce(new Error("sql down"));
    await expect(usageRollupTimer(timer, ctx)).rejects.toThrow("sql down");
    expect(Sentry.captureException).toHaveBeenCalled();
  });
});

describe("usagePurgeTimer", () => {
  it("does nothing, and does not touch the database, unless a purge switch is exactly \"true\"", async () => {
    process.env.USAGE_PURGE_ENABLED = "yes";
    expect(await usagePurgeTimer(timer, ctx)).toBeUndefined();
    expect(createServiceRequestConnection).not.toHaveBeenCalled();
    expect(purgeUsage).not.toHaveBeenCalled();
  });

  it("is not switched on by tracking alone", async () => {
    process.env.USAGE_TRACKING_ENABLED = "true";
    await usagePurgeTimer(timer, ctx);
    expect(purgeUsage).not.toHaveBeenCalled();
  });

  it("deletes with USAGE_PURGE_ENABLED, using the retention days", async () => {
    process.env.USAGE_PURGE_ENABLED = "true";
    process.env.USAGE_RETENTION_DAYS = "90";
    await usagePurgeTimer(timer, ctx);
    expect(jest.mocked(purgeUsage).mock.calls[0][1]).toMatchObject({ dryRun: false, retentionDays: 90 });
  });

  it("only counts with USAGE_PURGE_DRY_RUN, even when the purge is also enabled", async () => {
    process.env.USAGE_PURGE_ENABLED = "true";
    process.env.USAGE_PURGE_DRY_RUN = "true";
    await usagePurgeTimer(timer, ctx);
    expect(jest.mocked(purgeUsage).mock.calls[0][1]).toMatchObject({ dryRun: true, retentionDays: 180 });
  });

  it("raises a Sentry warning when it reaches its per-run cap", async () => {
    process.env.USAGE_PURGE_ENABLED = "true";
    jest.mocked(purgeUsage).mockResolvedValueOnce({ cutoffDay: "x", dryRun: false, sessionsDeleted: 0, sessionsEligible: 0, viewsDeleted: 200_000, viewsEligible: 300_000 });
    await usagePurgeTimer(timer, ctx);
    expect(Sentry.captureMessage).toHaveBeenCalledWith(expect.stringMatching(/per-run cap/), { level: "warning" });
  });

  it("returns its counts for TimerRuns", async () => {
    process.env.USAGE_PURGE_DRY_RUN = "true";
    expect(await usagePurgeTimer(timer, ctx)).toMatchObject({ dryRun: true, viewsDeleted: 0 });
  });
});
