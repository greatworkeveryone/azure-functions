/// <reference types="jest" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { InvocationContext, Timer } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../cpiAbs", () => ({
  ...jest.requireActual("../cpiAbs"),
  fetchAllCpiSeries: jest.fn(),
}));
jest.mock("../cpiIndexSync", () => ({ syncCpiIndex: jest.fn() }));
jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createServiceRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), flush: jest.fn() } }));

import { AbsCpiError, CpiSeries } from "../cpiAbs";
import { tenancyCpiSyncTimer } from "./tenancyCpiSyncTimer";

const { app } = require("@azure/functions") as { app: { timer: jest.Mock } };
const registrations = [...app.timer.mock.calls];

const abs = require("../cpiAbs") as { fetchAllCpiSeries: jest.Mock };
const sync = require("../cpiIndexSync") as { syncCpiIndex: jest.Mock };
const db = require("../db") as {
  beginTransaction: jest.Mock;
  closeConnection: jest.Mock;
  commitTransaction: jest.Mock;
  createServiceRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
};
const { Sentry } = require("../sentry") as {
  Sentry: { captureException: jest.Mock; flush: jest.Mock };
};

const series = [{ region: "AUS" }, { region: "DARWIN" }] as unknown as CpiSeries[];
const timer = { isPastDue: false } as unknown as Timer;
const connection = { id: "connection" };
const context = { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
const ctx = context as unknown as InvocationContext;

const databaseTouched = (): boolean =>
  db.createServiceRequestConnection.mock.calls.length > 0 ||
  db.executeQuery.mock.calls.length > 0 ||
  db.beginTransaction.mock.calls.length > 0 ||
  db.commitTransaction.mock.calls.length > 0 ||
  sync.syncCpiIndex.mock.calls.length > 0;

beforeEach(() => {
  jest.clearAllMocks();
  abs.fetchAllCpiSeries.mockResolvedValue(series);
  db.createServiceRequestConnection.mockResolvedValue(connection);
  sync.syncCpiIndex.mockResolvedValue({ regions: [] });
  Sentry.flush.mockResolvedValue(true);
});

describe("tenancyCpiSyncTimer registration", () => {
  it("runs daily at 03:00 UTC", () => {
    expect(registrations).toEqual([
      ["tenancyCpiSyncTimer", { schedule: "0 0 3 * * *", handler: tenancyCpiSyncTimer }],
    ]);
  });

  it("is the only CPI timer, so the broken monthly one is replaced, not joined", () => {
    const names = readdirSync(__dirname)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
      .flatMap((f) => [...readFileSync(join(__dirname, f), "utf8").matchAll(/app\.timer\(\s*"([^"]*)"/g)])
      .map((match) => match[1])
      .filter((name) => /cpi/i.test(name));
    expect(names).toEqual(["tenancyCpiSyncTimer"]);
  });
});

describe("tenancyCpiSyncTimer", () => {
  it("fetches first, then syncs the fetched series on a fresh connection and closes it", async () => {
    await tenancyCpiSyncTimer(timer, ctx);

    expect(abs.fetchAllCpiSeries).toHaveBeenCalledTimes(1);
    expect(abs.fetchAllCpiSeries.mock.invocationCallOrder[0]).toBeLessThan(
      db.createServiceRequestConnection.mock.invocationCallOrder[0],
    );
    expect(sync.syncCpiIndex).toHaveBeenCalledWith(connection, series, context);
    expect(db.closeConnection).toHaveBeenCalledWith(connection);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(Sentry.flush).toHaveBeenCalled();
  });

  it("forwards fetch retries to the invocation log as warnings", async () => {
    await tenancyCpiSyncTimer(timer, ctx);
    const { onRetry } = abs.fetchAllCpiSeries.mock.calls[0][0];
    onRetry("ABS CPI request failed (attempt 1/3): 503");
    expect(context.warn).toHaveBeenCalledWith("ABS CPI request failed (attempt 1/3): 503");
  });

  it("notes when the invocation is past due", async () => {
    await tenancyCpiSyncTimer({ isPastDue: true } as unknown as Timer, ctx);
    expect(context.warn).toHaveBeenCalledWith(expect.stringMatching(/past due/));
  });

  it("a failed ABS fetch leaves the table untouched and reports to Sentry", async () => {
    const failure = new AbsCpiError("http", "AUS: ABS responded 503 Service Unavailable", {
      status: 503,
      retryable: true,
    });
    abs.fetchAllCpiSeries.mockRejectedValue(failure);

    await expect(tenancyCpiSyncTimer(timer, ctx)).rejects.toBe(failure);

    expect(databaseTouched()).toBe(false);
    expect(db.closeConnection).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(failure, {
      extra: { context: "tenancyCpiSyncTimer ABS fetch", kind: "http", status: 503 },
    });
    expect(Sentry.flush).toHaveBeenCalled();
    expect(context.error).toHaveBeenCalledWith(expect.stringContaining("ABS fetch failed"));
  });

  it("a response that fails validation is treated the same way", async () => {
    const failure = new AbsCpiError("validation", "AUS: series starts at 2017-Q1, expected 2000-Q1");
    abs.fetchAllCpiSeries.mockRejectedValue(failure);

    await expect(tenancyCpiSyncTimer(timer, ctx)).rejects.toBe(failure);
    expect(databaseTouched()).toBe(false);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({ extra: expect.objectContaining({ kind: "validation" }) }),
    );
  });

  it("reports a failed database sync, closes the connection and fails the invocation", async () => {
    const failure = new Error("deadlock victim");
    sync.syncCpiIndex.mockRejectedValue(failure);

    await expect(tenancyCpiSyncTimer(timer, ctx)).rejects.toBe(failure);

    expect(db.closeConnection).toHaveBeenCalledWith(connection);
    expect(Sentry.captureException).toHaveBeenCalledWith(failure, {
      extra: { context: "tenancyCpiSyncTimer database sync", kind: undefined, status: undefined },
    });
    expect(Sentry.flush).toHaveBeenCalled();
  });

  it("reports a failure to connect, with nothing to close", async () => {
    const failure = new Error("login failed");
    db.createServiceRequestConnection.mockRejectedValue(failure);

    await expect(tenancyCpiSyncTimer(timer, ctx)).rejects.toBe(failure);

    expect(sync.syncCpiIndex).not.toHaveBeenCalled();
    expect(db.closeConnection).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        extra: expect.objectContaining({ context: "tenancyCpiSyncTimer database sync" }),
      }),
    );
  });
});
