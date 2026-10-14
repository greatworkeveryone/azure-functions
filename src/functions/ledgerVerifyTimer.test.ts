/// <reference types="jest" />

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));
// runTimer (TimerRuns row, rethrow) has its own tests in __tests__/timerRuns.test.ts;
// here the registered handler is the timer body itself.
jest.mock("../timerRuns", () => ({ runTimer: (_name: string, body: unknown) => body }));
jest.mock("../sentry", () => ({
  Sentry: { captureException: jest.fn(), captureMessage: jest.fn(), flush: jest.fn().mockResolvedValue(true) },
}));

import type { InvocationContext, Timer } from "@azure/functions";

const db = require("../db") as { closeConnection: jest.Mock; executeQuery: jest.Mock };
const { Sentry } = require("../sentry") as {
  Sentry: { captureException: jest.Mock; captureMessage: jest.Mock };
};

require("./ledgerVerifyTimer");
const { app } = require("@azure/functions") as { app: { timer: jest.Mock } };
const registration = app.timer.mock.calls.find((c: unknown[]) => c[0] === "ledgerVerifyTimer");
const run = (registration?.[1] as { handler: (t: Timer, c: InvocationContext) => Promise<void> }).handler;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const LEDGER_TABLES = [{ LedgerType: "APPEND_ONLY_LEDGER_TABLE", name: "MyobApiLog" }];
const LOCATIONS = '[{"path":"https://digests.blob.core.windows.net/sqldbledgerdigests","last_digest_block_id":3,"is_current":true}]';

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset();
});

describe("ledgerVerifyTimer schedule", () => {
  it("runs daily at 18:00 UTC, which is 03:30 in Darwin (UTC+9:30, no DST)", () => {
    expect((registration?.[1] as { schedule: string }).schedule).toBe("0 0 18 * * *");
  });
});

describe("ledgerVerifyTimer", () => {
  it("warns, tells Sentry, and verifies nothing when no digest storage is configured", async () => {
    db.executeQuery.mockResolvedValueOnce(LEDGER_TABLES).mockResolvedValueOnce([{ Locations: null }]);

    await run({} as Timer, ctx);

    expect(ctx.warn).toHaveBeenCalledWith(expect.stringContaining("verification skipped"));
    expect(Sentry.captureMessage).toHaveBeenCalledWith(
      "Ledger digest storage not configured — verification skipped",
      "warning",
    );
    expect(db.executeQuery).toHaveBeenCalledTimes(2);
  });

  it("runs the documented verify procedure with the locations JSON", async () => {
    db.executeQuery.mockResolvedValueOnce(LEDGER_TABLES).mockResolvedValueOnce([{ Locations: LOCATIONS }]).mockResolvedValueOnce([]);

    await run({} as Timer, ctx);

    expect(db.executeQuery).toHaveBeenCalledTimes(3);
    const [, sql, params] = db.executeQuery.mock.calls[2];
    expect(sql).toBe("EXEC sys.sp_verify_database_ledger_from_digest_storage @Locations");
    expect(params).toEqual([expect.objectContaining({ name: "Locations", value: LOCATIONS })]);
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("reads the locations from sys.database_ledger_digest_locations as JSON", async () => {
    db.executeQuery.mockResolvedValueOnce(LEDGER_TABLES).mockResolvedValueOnce([{ Locations: null }]);

    await run({} as Timer, ctx);

    const sql = String(db.executeQuery.mock.calls[1][1]);
    expect(sql).toMatch(/FROM sys\.database_ledger_digest_locations/);
    expect(sql).toMatch(/FOR JSON AUTO, INCLUDE_NULL_VALUES/);
  });

  it("sends a failed verification to Sentry and fails the run", async () => {
    const tampered = new Error("Ledger verification failed");
    db.executeQuery.mockResolvedValueOnce(LEDGER_TABLES).mockResolvedValueOnce([{ Locations: LOCATIONS }]).mockRejectedValueOnce(tampered);

    await expect(run({} as Timer, ctx)).rejects.toBe(tampered);

    expect(Sentry.captureException).toHaveBeenCalledWith(tampered, expect.anything());
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("skips without an alarm when every table is the trigger-protected fallback", async () => {
    db.executeQuery.mockResolvedValueOnce([
      { LedgerType: "NON_LEDGER_TABLE", name: "DecisionLedger" },
      { LedgerType: "NON_LEDGER_TABLE", name: "MyobApiLog" },
    ]);

    await run({} as Timer, ctx);

    expect(db.executeQuery).toHaveBeenCalledTimes(1);
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("MyobApiLog is the trigger-protected fallback"));
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("verification skipped"));
    expect(Sentry.captureMessage).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it("verifies when one ledger table is real even if the other fell back", async () => {
    db.executeQuery
      .mockResolvedValueOnce([
        { LedgerType: "NON_LEDGER_TABLE", name: "DecisionLedger" },
        { LedgerType: "APPEND_ONLY_LEDGER_TABLE", name: "MyobApiLog" },
      ])
      .mockResolvedValueOnce([{ Locations: LOCATIONS }])
      .mockResolvedValueOnce([]);

    await run({} as Timer, ctx);

    expect(String(db.executeQuery.mock.calls[2][1])).toMatch(/sp_verify_database_ledger_from_digest_storage/);
  });

  it("sends a failure to read the locations to Sentry too", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("permission denied"));

    await expect(run({} as Timer, ctx)).rejects.toThrow("permission denied");

    expect(Sentry.captureException).toHaveBeenCalled();
  });
});
