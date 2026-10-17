/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../ledger");

import { readSignOffClearReason, scheduleSignOffFromRow } from "../scheduleSignOff";
import { runScheduleWrite, scheduleWriteResponse } from "../tenancyScheduleWrite";
import type { LedgerActor } from "../ledger";

const db = require("../db") as {
  commitTransaction: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const ledger = require("../ledger") as { record: jest.Mock };

const ACTOR: LedgerActor = { kind: "user", name: "Ann Accounts", role: "accounts", userId: 7 };
const SIGNED_AT = new Date("2026-10-10T01:00:00Z");

const lockedRow = (over: Record<string, unknown> = {}) => ({
  BuildingId: 5,
  ScheduleSignedOffAt: null,
  ScheduleSignedOffByName: null,
  ScheduleSignOffNote: null,
  ScheduleVersion: 3,
  TenantId: 1,
  ...over,
});
const SIGNED = {
  ScheduleSignedOffAt: SIGNED_AT,
  ScheduleSignedOffByName: "Mia Manager",
  ScheduleSignOffNote: "Checked against the lease",
};

/** Answers by what the SQL is about, so the runner's order of queries can change. */
function answer(locked: Record<string, unknown>) {
  db.executeQuery.mockImplementation(async (_conn: unknown, sql: string) => {
    if (/WITH \(UPDLOCK/.test(sql)) return [locked];
    if (/OUTPUT INSERTED\.ScheduleVersion/.test(sql)) return [{ RowVersion: Buffer.from("0a", "hex"), ScheduleVersion: 4 }];
    return [];
  });
}
const sqlRun = (pattern: RegExp) => db.executeQuery.mock.calls.filter((call) => pattern.test(call[1] as string));

const write = (over: { expectedVersion?: number; reason?: string | null; reject?: boolean } = {}) =>
  runScheduleWrite(
    {} as never,
    {
      actor: ACTOR,
      buildingId: 5,
      expectedVersion: over.expectedVersion,
      signOffClearReason: over.reason,
      tenantId: 1,
      updatedById: "oid-1",
    },
    () =>
      over.reject
        ? { error: "No such step", kind: "reject", status: 404 }
        : {
            column: "ScheduledRateSteps",
            kind: "write",
            ledgerEntries: [{ action: "schedule.manual_edit", after: { id: "s1" }, before: null, subject: { id: "s1", type: "rate_step" } }],
            result: null,
            value: [],
          },
  );

beforeEach(() => {
  jest.clearAllMocks();
  ledger.record.mockResolvedValue(undefined);
});

describe("a schedule write to a tenancy that is not signed off", () => {
  it("goes through as before, with nothing cleared and no reason asked for", async () => {
    answer(lockedRow());
    const outcome = await write();
    expect(outcome.kind).toBe("ok");
    expect(sqlRun(/ScheduleSignedOffAt = NULL/)).toHaveLength(0);
    expect(ledger.record.mock.calls.map(([, entry]) => entry.action)).toEqual(["schedule.manual_edit"]);
  });
});

describe("a schedule write to a signed-off tenancy", () => {
  it("asks for a reason and writes nothing when none is given", async () => {
    answer(lockedRow(SIGNED));
    const outcome = await write();
    expect(outcome.kind).toBe("signOffReasonRequired");
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(sqlRun(/UPDATE dbo\.Tenants/)).toHaveLength(0);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("treats a blank reason as none", async () => {
    answer(lockedRow(SIGNED));
    expect((await write({ reason: readSignOffClearReason({ SignOffClearReason: "   " }) })).kind).toBe("signOffReasonRequired");
  });

  it("clears the sign-off in the same transaction, and ledgers why", async () => {
    answer(lockedRow(SIGNED));
    const outcome = await write({ reason: "Rent step was entered wrong" });
    expect(outcome.kind).toBe("ok");
    // The same UPDATE that writes the edit clears the sign-off, so the RowVersion
    // it returns is the final one and the next edit from this screen is not stale.
    expect(sqlRun(/UPDATE dbo\.Tenants/)).toHaveLength(1);
    expect(sqlRun(/UPDATE dbo\.Tenants[^]*ScheduleSignedOffAt = NULL/)).toHaveLength(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    const entries = ledger.record.mock.calls.map(([, entry]) => entry);
    expect(entries.map((entry) => entry.action)).toEqual(["schedule.manual_edit", "schedule.sign_off_cleared"]);
    const cleared = entries[1];
    expect(cleared).toMatchObject({
      actor: ACTOR,
      buildingId: 5,
      reason: "Rent step was entered wrong",
      subject: { id: 1, type: "tenancy" },
      tenantId: 1,
    });
    expect(cleared.before.signOff).toMatchObject({ by: "Mia Manager", note: "Checked against the lease" });
    expect(cleared.after.signOff).toBeNull();
    expect(cleared.correlationId).toBe(entries[0].correlationId);
  });

  it("still refuses a stale write or a bad request before it asks why", async () => {
    answer(lockedRow(SIGNED));
    expect((await write({ expectedVersion: 2 })).kind).toBe("conflict");
    expect((await write({ reject: true })).kind).toBe("rejected");
  });

  it("is answered 409 SIGN_OFF_REASON_REQUIRED naming who signed it", async () => {
    answer(lockedRow(SIGNED));
    const outcome = await write();
    const response = scheduleWriteResponse(outcome, () => ({}));
    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ code: "SIGN_OFF_REASON_REQUIRED", signOff: { by: "Mia Manager" } });
    expect((response.jsonBody as { error: string }).error).toContain("Mia Manager");
  });
});

describe("scheduleSignOffFromRow", () => {
  it("reads who and when, and is null for an unsigned row", () => {
    expect(scheduleSignOffFromRow(lockedRow())).toBeNull();
    expect(scheduleSignOffFromRow(lockedRow(SIGNED))).toEqual({
      at: "2026-10-10T01:00:00.000Z",
      by: "Mia Manager",
      note: "Checked against the lease",
    });
  });
});

describe("every schedule write passes the reason through", () => {
  it("names signOffClearReason at each runScheduleWrite call site in tenancy.ts", () => {
    const source = readFileSync(join(__dirname, "..", "functions", "tenancy.ts"), "utf8");
    const calls = source.split("runScheduleWrite(").slice(1);
    expect(calls.length).toBeGreaterThanOrEqual(8);
    for (const call of calls) expect(call.slice(0, 400)).toContain("signOffClearReason");
  });
});
