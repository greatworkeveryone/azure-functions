/// <reference types="jest" />

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createServiceRequestConnection: jest.fn().mockResolvedValue({}) }));
jest.mock("../myob/readbackRun", () => ({ ...jest.requireActual("../myob/readbackRun"), runReadback: jest.fn() }));

import type { InvocationContext, Timer } from "@azure/functions";
import { myobReadbackTimer, readbackDue, READBACK_CRON } from "./myobReadbackTimer";

const db = require("../db") as Record<string, jest.Mock>;
const { runReadback } = require("../myob/readbackRun") as { runReadback: jest.Mock };
const { app } = require("@azure/functions") as { app: { timer: jest.Mock } };
const registered = [...app.timer.mock.calls];
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const saved = { ...process.env };
const counts = (over: Record<string, number> = {}) => ({ discrepanciesChanged: 0, dryRun: false, errors: 0, matched: 1, missing: 0, read: 1, refused: 0, selected: 1, versionsAdvanced: 0, withDifferences: 0, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...saved };
  delete process.env.MYOB_READBACK_ENABLED;
  delete process.env.MYOB_READBACK_DRY_RUN;
  jest.useFakeTimers().setSystemTime(new Date("2026-10-14T00:30:00Z")); // Wednesday 10:00 Darwin
  runReadback.mockResolvedValue(counts());
});

afterEach(() => jest.useRealTimers());
afterAll(() => {
  process.env = saved;
});

describe("myobReadbackTimer", () => {
  it("is registered every 30 minutes through runTimer", () => {
    expect(registered).toEqual([["myobReadbackTimer", expect.objectContaining({ schedule: READBACK_CRON })]]);
    expect(READBACK_CRON).toBe("0 0,30 * * * *");
  });

  it("does nothing, and opens no connection, while off", async () => {
    await expect(myobReadbackTimer({} as Timer, ctx)).resolves.toBeUndefined();
    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
  });

  it("runs live with the system actor, and returns counts for TimerRuns", async () => {
    process.env.MYOB_READBACK_ENABLED = "true";
    const result = await myobReadbackTimer({} as Timer, ctx);
    expect(runReadback).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dryRun: false, limit: 50 }));
    expect(result).toMatchObject({ matched: 1, read: 1 });
  });

  it("runs a dry run when asked, even with ENABLED on", async () => {
    process.env.MYOB_READBACK_ENABLED = "true";
    process.env.MYOB_READBACK_DRY_RUN = "true";
    await myobReadbackTimer({} as Timer, ctx);
    expect(runReadback.mock.calls[0][1]).toMatchObject({ dryRun: true });
  });

  it("fails loudly when every read failed, so runTimer records an error", async () => {
    process.env.MYOB_READBACK_ENABLED = "true";
    runReadback.mockResolvedValue(counts({ errors: 3, matched: 0, read: 0 }));
    await expect(myobReadbackTimer({} as Timer, ctx)).rejects.toThrow("all 3 reads failed");
    expect(db.closeConnection).toHaveBeenCalled();
  });
});

describe("readbackDue", () => {
  it("runs every half hour in Darwin business hours, on the hour otherwise", () => {
    expect(readbackDue(new Date("2026-10-14T00:30:00Z"))).toBe(true); // Wed 10:00
    expect(readbackDue(new Date("2026-10-14T01:00:00Z"))).toBe(true); // Wed 10:30
    expect(readbackDue(new Date("2026-10-14T12:30:00Z"))).toBe(true); // Wed 22:00 on the hour
    expect(readbackDue(new Date("2026-10-14T13:00:00Z"))).toBe(false); // Wed 22:30
    expect(readbackDue(new Date("2026-10-17T01:00:00Z"))).toBe(false); // Sat 10:30
  });
});
