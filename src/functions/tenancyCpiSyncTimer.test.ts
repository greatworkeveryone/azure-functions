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
jest.mock("../cpiIndexSync", () => ({ planCpiSync: jest.fn(), syncCpiIndex: jest.fn() }));
// INDEX_AVAILABLE has its own tests (__tests__/rentReviewIndexResume.test.ts); here only its place in the run.
jest.mock("../rentReview/indexResume", () => ({ resumeAwaitingIndex: jest.fn() }));
jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createServiceRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
// runTimer (TimerRuns row, rethrow) has its own tests in __tests__/timerRuns.test.ts;
// here the registered handler is the timer body itself.
jest.mock("../timerRuns", () => ({ runTimer: (_name: string, body: unknown) => body }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), flush: jest.fn() } }));

import { AbsCpiError, CpiSeries } from "../cpiAbs";
import { tenancyCpiSyncTimer } from "./tenancyCpiSyncTimer";

const { app } = require("@azure/functions") as { app: { timer: jest.Mock } };
const registrations = [...app.timer.mock.calls];

const abs = require("../cpiAbs") as { fetchAllCpiSeries: jest.Mock };
const sync = require("../cpiIndexSync") as { planCpiSync: jest.Mock; syncCpiIndex: jest.Mock };
const resume = require("../rentReview/indexResume") as { resumeAwaitingIndex: jest.Mock };
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
  sync.syncCpiIndex.mock.calls.length > 0 ||
  sync.planCpiSync.mock.calls.length > 0;

const FLAGS = ["CPI_SYNC_ENABLED", "CPI_SYNC_DRY_RUN"] as const;
const originalFlags = Object.fromEntries(FLAGS.map((name) => [name, process.env[name]]));

function setFlags(flags: { enabled?: string; dryRun?: string }): void {
  const values = { CPI_SYNC_ENABLED: flags.enabled, CPI_SYNC_DRY_RUN: flags.dryRun };
  for (const name of FLAGS) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
}

afterAll(() => {
  for (const name of FLAGS) {
    const value = originalFlags[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  jest.clearAllMocks();
  setFlags({ enabled: "true" });
  abs.fetchAllCpiSeries.mockResolvedValue(series);
  db.createServiceRequestConnection.mockResolvedValue(connection);
  sync.syncCpiIndex.mockResolvedValue({ regions: [] });
  sync.planCpiSync.mockResolvedValue({ regions: [] });
  resume.resumeAwaitingIndex.mockResolvedValue({ errors: [], resumed: 0, waiting: 0 });
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

describe("tenancyCpiSyncTimer: rent reviews waiting for the index (WP26 INDEX_AVAILABLE)", () => {
  it("returns them to in progress after the sync has committed, on the same connection", async () => {
    await tenancyCpiSyncTimer(timer, ctx);
    expect(resume.resumeAwaitingIndex).toHaveBeenCalledWith(connection, expect.objectContaining({ dryRun: false }));
    expect(sync.syncCpiIndex.mock.invocationCallOrder[0]).toBeLessThan(resume.resumeAwaitingIndex.mock.invocationCallOrder[0]);
  });

  it("only says which would go back in a dry run", async () => {
    setFlags({ dryRun: "true" });
    await tenancyCpiSyncTimer(timer, ctx);
    expect(resume.resumeAwaitingIndex).toHaveBeenCalledWith(connection, expect.objectContaining({ dryRun: true }));
  });

  it("doesn't run when the sync failed", async () => {
    sync.syncCpiIndex.mockRejectedValue(new Error("deadlock victim"));
    await expect(tenancyCpiSyncTimer(timer, ctx)).rejects.toThrow("deadlock victim");
    expect(resume.resumeAwaitingIndex).not.toHaveBeenCalled();
  });

  it("fails the invocation under its own stage when a review couldn't go back, the CPI rows already committed", async () => {
    resume.resumeAwaitingIndex.mockResolvedValue({ errors: [{ message: "ledger down", reviewId: "rev-1" }], resumed: 0, waiting: 0 });
    await expect(tenancyCpiSyncTimer(timer, ctx)).rejects.toThrow("1 rent review(s) couldn't go back to in progress; first: ledger down");
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(Error), expect.objectContaining({ extra: expect.objectContaining({ context: "tenancyCpiSyncTimer index resume" }) }));
    expect(db.closeConnection).toHaveBeenCalledWith(connection);
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
    expect(sync.planCpiSync).not.toHaveBeenCalled();
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

// Database-safety rule 2: a timer that overwrites is off by default and only a
// flag that is exactly the string "true" turns anything on.
describe("tenancyCpiSyncTimer — CPI_SYNC_ENABLED", () => {
  const OFF = 'tenancyCpiSyncTimer disabled (CPI_SYNC_ENABLED is not "true")';

  it.each([undefined, "", "false", "0", "1", "yes", "on", "TRUE", "True", " true", "true "])(
    "does nothing when CPI_SYNC_ENABLED is %j",
    async (enabled) => {
      setFlags({ enabled });

      await tenancyCpiSyncTimer(timer, ctx);

      expect(context.log).toHaveBeenCalledTimes(1);
      expect(context.log).toHaveBeenCalledWith(OFF);
      expect(abs.fetchAllCpiSeries).not.toHaveBeenCalled();
      expect(databaseTouched()).toBe(false);
      expect(db.closeConnection).not.toHaveBeenCalled();
      expect(context.warn).not.toHaveBeenCalled();
      expect(Sentry.captureException).not.toHaveBeenCalled();
    },
  );

  it('syncs when CPI_SYNC_ENABLED is exactly "true"', async () => {
    setFlags({ enabled: "true" });

    await tenancyCpiSyncTimer(timer, ctx);

    expect(context.log).not.toHaveBeenCalledWith(OFF);
    expect(sync.syncCpiIndex).toHaveBeenCalledWith(connection, series, context);
    expect(sync.planCpiSync).not.toHaveBeenCalled();
  });
});

describe("tenancyCpiSyncTimer — CPI_SYNC_DRY_RUN", () => {
  it.each([undefined, "true"])(
    'plans and writes nothing when CPI_SYNC_DRY_RUN is "true" (CPI_SYNC_ENABLED %j)',
    async (enabled) => {
      setFlags({ enabled, dryRun: "true" });

      await tenancyCpiSyncTimer(timer, ctx);

      expect(abs.fetchAllCpiSeries).toHaveBeenCalledTimes(1);
      expect(sync.planCpiSync).toHaveBeenCalledWith(connection, series, context);
      expect(sync.syncCpiIndex).not.toHaveBeenCalled();
      expect(db.beginTransaction).not.toHaveBeenCalled();
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(db.executeQuery).not.toHaveBeenCalled();
      expect(db.closeConnection).toHaveBeenCalledWith(connection);
      expect(context.log).toHaveBeenCalledWith(expect.stringMatching(/dry run \(nothing will be written\)/));
      expect(Sentry.captureException).not.toHaveBeenCalled();
    },
  );

  it.each(["", "false", "0", "1", "yes", "TRUE", "True", " true", "true "])(
    "is not a dry run when CPI_SYNC_DRY_RUN is %j: with the sync off, nothing runs",
    async (dryRun) => {
      setFlags({ dryRun });

      await tenancyCpiSyncTimer(timer, ctx);

      expect(abs.fetchAllCpiSeries).not.toHaveBeenCalled();
      expect(databaseTouched()).toBe(false);
      expect(context.log).toHaveBeenCalledWith(
        'tenancyCpiSyncTimer disabled (CPI_SYNC_ENABLED is not "true")',
      );
    },
  );

  it('ignores a CPI_SYNC_DRY_RUN that is not exactly "true", so an enabled sync still runs', async () => {
    setFlags({ enabled: "true", dryRun: "1" });

    await tenancyCpiSyncTimer(timer, ctx);

    expect(sync.syncCpiIndex).toHaveBeenCalledTimes(1);
    expect(sync.planCpiSync).not.toHaveBeenCalled();
  });

  it("still fails visibly when ABS cannot be fetched, without touching the database", async () => {
    setFlags({ dryRun: "true" });
    const failure = new AbsCpiError("http", "AUS: ABS responded 503", { status: 503, retryable: true });
    abs.fetchAllCpiSeries.mockRejectedValue(failure);

    await expect(tenancyCpiSyncTimer(timer, ctx)).rejects.toBe(failure);

    expect(databaseTouched()).toBe(false);
    expect(Sentry.captureException).toHaveBeenCalledWith(
      failure,
      expect.objectContaining({
        extra: expect.objectContaining({ context: "tenancyCpiSyncTimer ABS fetch" }),
      }),
    );
  });

  it("reports a failed dry run under its own stage and still closes the connection", async () => {
    setFlags({ dryRun: "true" });
    const failure = new Error("refusing to write a regression");
    sync.planCpiSync.mockRejectedValue(failure);

    await expect(tenancyCpiSyncTimer(timer, ctx)).rejects.toBe(failure);

    expect(db.closeConnection).toHaveBeenCalledWith(connection);
    expect(Sentry.captureException).toHaveBeenCalledWith(failure, {
      extra: { context: "tenancyCpiSyncTimer database dry run", kind: undefined, status: undefined },
    });
  });
});
