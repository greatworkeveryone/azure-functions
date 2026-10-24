/// <reference types="jest" />

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createServiceRequestConnection: jest.fn().mockResolvedValue({ connection: true }) }));
jest.mock("../timerRuns", () => ({ runTimer: (_name: string, body: unknown) => body }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn(), flush: jest.fn().mockResolvedValue(true) } }));
jest.mock("../comms/worker", () => ({ runCommsQueue: jest.fn() }));
jest.mock("../comms/queueStore", () => ({ sqlQueueStore: jest.fn(() => ({ store: true })) }));
jest.mock("../comms/graphSend", () => ({ createGraphSender: jest.fn(() => ({ sender: true })) }));

import type { InvocationContext, Timer } from "@azure/functions";

const db = require("../db") as { closeConnection: jest.Mock; createServiceRequestConnection: jest.Mock };
const { runCommsQueue } = require("../comms/worker") as { runCommsQueue: jest.Mock };
const graph = require("../comms/graphSend") as { createGraphSender: jest.Mock };
const { Sentry } = require("../sentry") as { Sentry: { captureException: jest.Mock } };

require("./commsSendTimer");
const { app } = require("@azure/functions") as { app: { timer: jest.Mock } };
const registration = app.timer.mock.calls.find((c: unknown[]) => c[0] === "commsSendTimer");
const run = (registration?.[1] as { handler: (t: Timer, c: InvocationContext) => Promise<unknown> }).handler;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const report = { blocked: 0, budget: 25, failed: 0, mode: "live", recovered: 0, retried: 0, sent: 3, skipped: 0, taken: 3, wouldSend: 0 };

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.COMMS_SEND_ENABLED;
  delete process.env.COMMS_SEND_DRY_RUN;
  delete process.env.COMMS_MAX_PER_MINUTE;
  runCommsQueue.mockResolvedValue(report);
});
afterAll(() => {
  delete process.env.COMMS_SEND_ENABLED;
  delete process.env.COMMS_SEND_DRY_RUN;
});

describe("commsSendTimer", () => {
  it("runs every minute", () => {
    expect((registration?.[1] as { schedule: string }).schedule).toBe("0 * * * * *");
  });

  it("does nothing, and touches neither the database nor Graph, unless it is switched on", async () => {
    expect(await run({} as Timer, ctx)).toBeUndefined();
    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
    expect(runCommsQueue).not.toHaveBeenCalled();
    expect(graph.createGraphSender).not.toHaveBeenCalled();
  });

  it.each([["COMMS_SEND_ENABLED", "TRUE"], ["COMMS_SEND_ENABLED", "1"], ["COMMS_SEND_DRY_RUN", "yes"]])("stays off for %s=%s", async (key, value) => {
    process.env[key] = value;
    await run({} as Timer, ctx);
    expect(runCommsQueue).not.toHaveBeenCalled();
    delete process.env[key];
  });

  it("runs live with COMMS_SEND_ENABLED=true and returns the counts for TimerRuns", async () => {
    process.env.COMMS_SEND_ENABLED = "true";
    process.env.COMMS_MAX_PER_MINUTE = "10";
    const counts = await run({} as Timer, ctx);
    expect(runCommsQueue).toHaveBeenCalledWith(expect.objectContaining({ maxPerMinute: 10, mode: "live" }));
    expect(counts).toMatchObject({ dryRun: false, sent: 3, taken: 3 });
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("runs as a dry run, which wins over ENABLED", async () => {
    process.env.COMMS_SEND_ENABLED = "true";
    process.env.COMMS_SEND_DRY_RUN = "true";
    const counts = await run({} as Timer, ctx);
    expect(runCommsQueue).toHaveBeenCalledWith(expect.objectContaining({ maxPerMinute: 25, mode: "dry-run" }));
    expect(counts).toMatchObject({ dryRun: true });
  });

  it("fails loudly, closing the connection and telling Sentry", async () => {
    process.env.COMMS_SEND_ENABLED = "true";
    runCommsQueue.mockRejectedValue(new Error("db down"));
    await expect(run({} as Timer, ctx)).rejects.toThrow("db down");
    expect(Sentry.captureException).toHaveBeenCalled();
    expect(db.closeConnection).toHaveBeenCalled();
  });
});
