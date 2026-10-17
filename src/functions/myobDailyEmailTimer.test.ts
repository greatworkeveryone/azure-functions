/// <reference types="jest" />

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createServiceRequestConnection: jest.fn().mockResolvedValue({}) }));
jest.mock("../myob/daily/run", () => ({ ...jest.requireActual("../myob/daily/run"), runMyobDaily: jest.fn() }));

import type { InvocationContext, Timer } from "@azure/functions";
import { DIGEST_CRON } from "../digest/schedule";
import { TIMER_NAMES } from "../timerRuns";
import { myobDailyEmailTimer } from "./myobDailyEmailTimer";

const db = require("../db") as Record<string, jest.Mock>;
const { runMyobDaily } = require("../myob/daily/run") as { runMyobDaily: jest.Mock };
const { app } = require("@azure/functions") as { app: { timer: jest.Mock } };
const registered = [...app.timer.mock.calls];
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const saved = { ...process.env };
const report = (over: Record<string, unknown> = {}) => ({
  calls: 3, changes: 2, configMissing: [], created: 1, discrepancies: 0, dryRun: false, errors: [], noAddress: 0, nothingToSend: false, recipients: 1, sent: 1, wouldSend: 0, ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...saved };
  delete process.env.MYOB_DAILY_EMAIL_ENABLED;
  delete process.env.MYOB_DAILY_EMAIL_DRY_RUN;
  delete process.env.ESCALATION_HOLIDAYS;
  jest.useFakeTimers().setSystemTime(new Date("2026-10-13T22:00:30Z")); // Wednesday 07:30 Darwin
  runMyobDaily.mockResolvedValue(report());
});

afterEach(() => jest.useRealTimers());
afterAll(() => {
  process.env = saved;
});

describe("myobDailyEmailTimer", () => {
  it("is registered at the digest's 07:30 Darwin through runTimer, and is a known timer for TimerRuns", () => {
    expect(registered).toEqual([["myobDailyEmailTimer", expect.objectContaining({ schedule: DIGEST_CRON })]]);
    expect(TIMER_NAMES).toContain("myobDailyEmailTimer");
  });

  it("does nothing, and opens no connection, while off", async () => {
    await expect(myobDailyEmailTimer({} as Timer, ctx)).resolves.toBeUndefined();
    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
  });

  it("sends live, or dry-runs when the dry run is on (it wins), and returns counts for TimerRuns", async () => {
    process.env.MYOB_DAILY_EMAIL_ENABLED = "true";
    await expect(myobDailyEmailTimer({} as Timer, ctx)).resolves.toMatchObject({ calls: 3, created: 1, errors: 0, sent: 1 });
    expect(runMyobDaily.mock.calls[0][1]).toMatchObject({ dryRun: false });
    process.env.MYOB_DAILY_EMAIL_DRY_RUN = "true";
    await myobDailyEmailTimer({} as Timer, ctx);
    expect(runMyobDaily.mock.calls[1][1]).toMatchObject({ dryRun: true });
  });

  it("skips a weekend", async () => {
    process.env.MYOB_DAILY_EMAIL_ENABLED = "true";
    jest.setSystemTime(new Date("2026-10-16T22:00:30Z")); // Saturday 07:30 Darwin
    await myobDailyEmailTimer({} as Timer, ctx);
    expect(runMyobDaily).not.toHaveBeenCalled();
  });

  it("fails the run when mail settings are missing or every send failed, but not for one failure among several", async () => {
    process.env.MYOB_DAILY_EMAIL_ENABLED = "true";
    runMyobDaily.mockResolvedValueOnce(report({ configMissing: ["GRAPH_SENDER_EMAIL"], errors: ["Notification settings are missing"], sent: 0 }));
    await expect(myobDailyEmailTimer({} as Timer, ctx)).rejects.toThrow("Notification settings are missing");
    runMyobDaily.mockResolvedValueOnce(report({ errors: ["user #12: Graph 503"], sent: 0 }));
    await expect(myobDailyEmailTimer({} as Timer, ctx)).rejects.toThrow("Graph 503");
    runMyobDaily.mockResolvedValueOnce(report({ errors: ["user #12: Graph 503"], recipients: 2, sent: 1 }));
    await expect(myobDailyEmailTimer({} as Timer, ctx)).resolves.toMatchObject({ errors: 1, sent: 1 });
  });
});
