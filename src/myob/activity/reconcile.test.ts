/// <reference types="jest" />

// Reconciliation (SPR-M4): Floorplan's record of each record it sent, against
// MYOB's own, read now through the GET-only reader. It never writes.

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../../ledger", () => ({ record: jest.fn() }));
jest.mock("../proposalsStore", () => ({ updateProposal: jest.fn() }));

import { MyobRequestRefusedError } from "../../myob-api-log";
import { MyobPurchaseError } from "../../myob-purchase-order";
import type { MyobReader } from "../readbackClient";
import { reconcile } from "./reconcile";

const { executeQuery } = require("../../db") as { executeQuery: jest.Mock };
const { record } = require("../../ledger") as { record: jest.Mock };
const { updateProposal } = require("../proposalsStore") as { updateProposal: jest.Mock };

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const NOW = new Date("2026-10-17T00:00:00Z");
const JOHANNE = { kind: "user" as const, name: "Johanne", oid: "cfo-oid" };
const SENT = {
  Date: "2026-10-14T00:00:00", IsTaxInclusive: true, JournalMemo: "FP 66Sm261014 · proposed Ray",
  Lines: [{ Account: { UID: "a" }, Description: "x", TaxCode: { UID: "t" }, Total: 4840, Type: "Transaction" }], Number: "66Sm261014", Supplier: { UID: "s" },
};
const row = (id: number, over: Record<string, unknown> = {}) => ({
  CompanyFileId: CF, CorrelationId: "9b1f2c34-5d6e-4f70-8a91-0b2c3d4e5f60", Discrepancy: null, FileName: "Demo Pty Ltd", JobId: 12, MyobRowVersion: "7",
  MyobSnapshot: null, MyobStatus: "Open", MyobUid: `uid-${id}`, Operation: "orders.create", Payload: JSON.stringify(SENT), PayloadHash: "h", ProposalId: id,
  ProposedAt: new Date("2026-10-14T00:00:00Z"), ProposedBy: "Ray", ReadBack: JSON.stringify({ ...SENT, RowVersion: "7", Status: "Open" }),
  Rendered: JSON.stringify({ document: "Order", number: "66Sm261014", supplier: "ACME" }), RowVersion: Buffer.from("v1"), State: "verified", SubjectId: 9,
  SubjectType: "purchase_order", ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
    sql.includes("FROM dbo.DecisionLedger") ? [] : sql.includes("COUNT(*)") ? [{ Total: 40 }] : [row(1), row(2), row(3), row(4)],
  );
});

describe("reconcile", () => {
  it("reads each record Floorplan sent and says matched, differs field by field, or missing in MYOB, writing nothing", async () => {
    const get = jest.fn()
      .mockResolvedValueOnce({ ...SENT, RowVersion: "7", Status: "Open" })
      .mockResolvedValueOnce({ ...SENT, JournalMemo: "Johanne: hold", LastModified: "2026-10-16T05:00:00", RowVersion: "9", Status: "Open" })
      .mockRejectedValueOnce(new MyobPurchaseError(404, "not found"))
      .mockRejectedValueOnce(new MyobRequestRefusedError("controls", "purchases.read is switched off"));
    const reader: MyobReader = { get };
    const result = await reconcile({} as never, JOHANNE, { companyFileId: CF, limit: 100 }, { now: NOW, reader });

    expect(result.rows.map((r) => r.status)).toEqual(["matched", "differs", "missing", "refused"]);
    expect(result.rows[1]).toMatchObject({
      fields: [expect.objectContaining({ label: "Memo", myob: "Johanne: hold" })], myobLastModified: "2026-10-16T05:00:00", myobRowVersion: "9", proposalId: 2, record: "Order 66Sm261014",
    });
    expect(result.rows[3].message).toContain("purchases.read is switched off");
    expect(get).toHaveBeenCalledWith("Order", CF, "uid-1", JOHANNE, expect.any(String));
    expect(updateProposal).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
    for (const [, sql] of executeQuery.mock.calls as [unknown, string][]) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE)\b/);
  });

  it("says how many records there are in all, and which differences the CFO may accept", async () => {
    const get = jest.fn()
      .mockResolvedValueOnce({ ...SENT, JournalMemo: "Johanne: hold", RowVersion: "9", Status: "Open" })
      .mockResolvedValueOnce({ ...SENT, Lines: [{ ...SENT.Lines[0], Total: 4900 }], RowVersion: "9", Status: "Open" })
      .mockResolvedValue({ ...SENT, RowVersion: "7", Status: "Open" });
    const result = await reconcile({} as never, JOHANNE, { companyFileId: null, limit: 25 }, { now: NOW, reader: { get } });
    expect(result.total).toBe(40);
    expect(result.rows.map((r) => [r.status, r.acceptable])).toEqual([["differs", true], ["differs", false], ["matched", false], ["matched", false]]);
  });

  it("calls a record missing at the first 404: the CFO is looking now", async () => {
    const get = jest.fn().mockRejectedValue(new MyobPurchaseError(404, "not found"));
    const result = await reconcile({} as never, JOHANNE, { companyFileId: null, limit: 100 }, { now: NOW, reader: { get } });
    expect(new Set(result.rows.map((r) => r.status))).toEqual(new Set(["missing"]));
  });

  it("selects positively: the latest verified proposal per MYOB record, optionally for one file, capped", async () => {
    const get = jest.fn().mockResolvedValue({ ...SENT, RowVersion: "7", Status: "Open" });
    await reconcile({} as never, JOHANNE, { companyFileId: CF, limit: 500 }, { now: NOW, reader: { get } });
    const [, sql, params] = executeQuery.mock.calls.find((call: unknown[]) => String(call[1]).includes("TOP (@Limit)")) as [unknown, string, { name: string; value: unknown }[]];
    expect(sql.replace(/\s+/g, " ")).toMatch(/p\.State = N'verified' AND p\.MyobUid IS NOT NULL/);
    expect(sql).toMatch(/p\.ProposalId = \(SELECT MAX\(q\.ProposalId\)/);
    expect(sql).toMatch(/@File IS NULL OR p\.CompanyFileId = @File/);
    expect(params).toEqual(expect.arrayContaining([expect.objectContaining({ name: "File", value: CF }), expect.objectContaining({ name: "Limit", value: 25 })]));
  });

  it("keeps going when one read fails", async () => {
    const get = jest.fn().mockRejectedValueOnce(new Error("socket hang up")).mockResolvedValue({ ...SENT, RowVersion: "7", Status: "Open" });
    const result = await reconcile({} as never, JOHANNE, { companyFileId: null, limit: 100 }, { now: NOW, reader: { get } });
    expect(result.rows.map((r) => r.status)).toEqual(["failed", "matched", "matched", "matched"]);
  });
});
