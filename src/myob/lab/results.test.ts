/// <reference types="jest" />

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../../ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));

import { LAB_CASES } from "./cases";
import { loadLabResults, recordLabResult } from "./results";

const { executeQuery } = require("../../db") as { executeQuery: jest.Mock };
const { record } = require("../../ledger") as { record: jest.Mock };
const DEMO = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const JOHANNE = { kind: "user" as const, name: "Johanne", role: "cfo", userId: 12 };

beforeEach(() => jest.clearAllMocks());

describe("the lab cases", () => {
  it("each have an id, steps and the expected answer, and cover create-only quotes and orders and the agreement's refusals", () => {
    const ids = LAB_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of LAB_CASES) {
      expect(c.title && c.expected && c.steps.length > 0).toBeTruthy();
      expect(c.id.length).toBeLessThanOrEqual(64);
    }
    expect(ids).toEqual(expect.arrayContaining(["create.order", "create.quote", "refuse.prior_period", "refuse.card_file", "refuse.update_existing"]));
  });
});

describe("recordLabResult", () => {
  it("ledgers her result for the case on the demonstration file, with her note and what she observed", async () => {
    await recordLabResult({} as never, JOHANNE, { caseId: "create.order", note: "Order 66Sm261014 in MYOB, memo names Ray and me", observed: "Matches", pass: true, proposalId: 5 }, DEMO);
    expect(record).toHaveBeenCalledWith(expect.anything(), {
      action: "myob.lab_result",
      actor: JOHANNE,
      after: { caseId: "create.order", expected: expect.any(String), observed: "Matches", pass: true, proposalId: 5 },
      reason: "Order 66Sm261014 in MYOB, memo names Ray and me",
      ruleApplied: "create.order",
      subject: { id: `${DEMO}:lab`, type: "myob_control" },
    });
  });

  it("refuses a case the lab doesn't have", async () => {
    await expect(recordLabResult({} as never, JOHANNE, { caseId: "made.up", note: "x", observed: "", pass: true, proposalId: null }, DEMO)).rejects.toMatchObject({ status: 400 });
    expect(record).not.toHaveBeenCalled();
  });
});

describe("loadLabResults", () => {
  it("reads the latest result per case for this demonstration file, from the ledger", async () => {
    executeQuery.mockResolvedValue([
      { ActorName: "Johanne", After: JSON.stringify({ caseId: "create.order", observed: "Matches", pass: true }), OccurredAt: new Date("2026-10-18T01:00:00Z"), Reason: "second" },
      { ActorName: "Johanne", After: JSON.stringify({ caseId: "create.order", observed: "Differs", pass: false }), OccurredAt: new Date("2026-10-18T00:00:00Z"), Reason: "first" },
    ]);
    const results = await loadLabResults({} as never, DEMO);
    const [, sql, params] = executeQuery.mock.calls[0] as [unknown, string, { name: string; value: unknown }[]];
    expect(sql).toMatch(/Action = N'myob\.lab_result' AND SubjectType = N'myob_control' AND SubjectId = @Subject/);
    expect(params).toEqual([expect.objectContaining({ name: "Subject", value: `${DEMO}:lab` })]);
    expect(results.get("create.order")).toEqual({ at: "2026-10-18T01:00:00.000Z", by: "Johanne", note: "second", observed: "Matches", pass: true });
  });
});
