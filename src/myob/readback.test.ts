/// <reference types="jest" />

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));
jest.mock("./proposalsStore", () => ({ getProposal: jest.fn(), updateProposal: jest.fn() }));

import { MyobPurchaseError } from "../myob-purchase-order";
import { readBackProposal, recordReadback, selectForReadback } from "./readback";
import type { MyobReader } from "./readbackClient";
import type { ProposalRow } from "./proposalRow";

const { executeQuery } = require("../db") as { executeQuery: jest.Mock };
const { record } = require("../ledger") as { record: jest.Mock };
const store = require("./proposalsStore") as Record<string, jest.Mock>;

const NOW = new Date("2026-10-15T00:12:00Z");
const SENT = { Date: "2026-10-14T00:00:00", Lines: [{ Account: { UID: "acct" }, TaxCode: { UID: "gst" }, Total: 4840, Type: "Transaction" }], Number: "66Sm261014", Supplier: { UID: "sup" } };
const SYSTEM = { kind: "system" as const, name: "myobReadbackTimer" };
const proposal = (over: Partial<ProposalRow> = {}) =>
  ({
    companyFileId: "cf", correlationId: "9b1f2c34-5d6e-4f70-8a91-0b2c3d4e5f60", discrepancy: null, jobId: 12, myobRowVersion: "7", myobSnapshot: null, myobStatus: "Open",
    myobUid: "uid", operation: "orders.create", payload: SENT, proposalId: 5, readBack: { ...SENT, Status: "Open" },
    rendered: { supplier: "ACME Air" }, rowVersion: "v1", subjectId: 9, subjectType: "purchase_order", ...over,
  }) as ProposalRow;
const fakeMyob = (get: jest.Mock): MyobReader => ({ get });

beforeEach(() => {
  jest.clearAllMocks();
  executeQuery.mockResolvedValue([{ Action: "po.create", ActorName: "Ray", OccurredAt: new Date("2026-10-14T00:01:00Z") }]);
  store.getProposal.mockResolvedValue(proposal());
  store.updateProposal.mockImplementation(async () => proposal());
});

describe("selectForReadback", () => {
  it("selects positively: verified Floorplan records with a MYOB uid, the latest per record, not checked in 25 minutes", async () => {
    executeQuery.mockResolvedValueOnce([]);
    await selectForReadback({} as never, 50, NOW);
    const [, sql, params] = executeQuery.mock.calls[0];
    expect(sql).toMatch(/p\.State = N'verified' AND p\.MyobUid IS NOT NULL/);
    expect(sql).toMatch(/p\.ProposalId = \(SELECT MAX\(q\.ProposalId\)/);
    expect(sql).toMatch(/LastReadBackAt IS NULL OR p\.LastReadBackAt < @Before/);
    expect(sql).not.toMatch(/NOT IN|<>/);
    expect(params).toEqual(expect.arrayContaining([expect.objectContaining({ name: "Limit", value: 50 }), expect.objectContaining({ name: "Before", value: new Date("2026-10-14T23:47:00Z") })]));
  });
});

describe("readBackProposal", () => {
  it("reads the record by its uid; a 404 is noted once, and missing in MYOB when the next read misses too", async () => {
    const get = jest.fn().mockRejectedValue(new MyobPurchaseError(404, "not found"));
    const once = await readBackProposal({} as never, proposal(), SYSTEM, NOW, fakeMyob(get));
    expect(get).toHaveBeenCalledWith("Order", "cf", "uid", SYSTEM, expect.any(String));
    expect(once).toMatchObject({ record: null, verdict: { discrepancy: null, notFoundOnce: true, status: "NotFound" } });
    const twice = await readBackProposal({} as never, proposal({ myobStatus: "NotFound" }), SYSTEM, NOW, fakeMyob(get));
    expect(twice).toMatchObject({ record: null, verdict: { discrepancy: { missing: true }, notFoundOnce: false } });
  });

  it("lets any other failure through (a refusal is the run's to count)", async () => {
    const get = jest.fn().mockRejectedValue(new Error("socket hang up"));
    await expect(readBackProposal({} as never, proposal(), SYSTEM, NOW, fakeMyob(get))).rejects.toThrow("socket hang up");
  });
});

describe("recordReadback", () => {
  const matching = { record: { ...SENT, RowVersion: "9", Status: "Open" }, verdict: { advanceVersion: true, discrepancy: null, notFoundOnce: false, paid: { balanceDue: null, state: null }, status: "Open" } };
  const differing = {
    record: { ...SENT, RowVersion: "10", Status: "Open" },
    verdict: { advanceVersion: false, discrepancy: { fields: [{ field: "total", floorplan: "$4,840.00 inc GST", label: "Amount", myob: "$4,900.00 inc GST" }], floorplanLastTouch: null, missing: false, myobLastModified: null, seenAt: NOW.toISOString() }, notFoundOnce: false, paid: { balanceDue: null, state: null }, status: "Open" },
  };

  it("takes MYOB's version when it matches, so a later Update in MYOB isn't refused; ledgers nothing new", async () => {
    const result = await recordReadback({} as never, 5, matching, SYSTEM, NOW);
    expect(store.updateProposal.mock.calls[0][3]).toMatchObject({ Discrepancy: null, LastReadBackAt: NOW, MyobRowVersion: "9", MyobStatus: "Open" });
    expect(result).toEqual({ discrepancyChanged: false, versionAdvanced: true });
    expect(record).not.toHaveBeenCalled();
  });

  it("records a new difference, keeps the old version, and ledgers myob.discrepancy once", async () => {
    const result = await recordReadback({} as never, 5, differing, SYSTEM, NOW);
    const fields = store.updateProposal.mock.calls[0][3];
    expect(fields.MyobRowVersion).toBeUndefined();
    expect(JSON.parse(fields.Discrepancy)).toMatchObject({ fields: [{ label: "Amount" }] });
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "myob.discrepancy", ruleApplied: "found" }));
    expect(result.discrepancyChanged).toBe(true);

    jest.clearAllMocks();
    store.getProposal.mockResolvedValue(proposal({ discrepancy: differing.verdict.discrepancy as unknown as Record<string, unknown> }));
    store.updateProposal.mockImplementation(async () => proposal());
    await recordReadback({} as never, 5, differing, SYSTEM, NOW);
    expect(record).not.toHaveBeenCalled();
  });

  it("writes no ledger row when the same discrepancy is seen again, later, with newer timestamps", async () => {
    store.getProposal.mockResolvedValue(proposal({ discrepancy: differing.verdict.discrepancy as unknown as Record<string, unknown> }));
    const later = {
      ...differing,
      verdict: {
        ...differing.verdict,
        discrepancy: { ...differing.verdict.discrepancy, floorplanLastTouch: { action: "po.update", at: "2026-10-15T01:00:00.000Z", name: "Ana" }, myobLastModified: "2026-10-15T00:50:00", seenAt: "2026-10-15T01:12:00.000Z" },
      },
    };
    const result = await recordReadback({} as never, 5, later, SYSTEM, new Date("2026-10-15T01:12:00Z"));
    expect(result.discrepancyChanged).toBe(false);
    expect(record).not.toHaveBeenCalled();
    expect(store.updateProposal).toHaveBeenCalledTimes(1);
  });

  it("notes a first 404 without touching the discrepancy, the snapshot or the ledger", async () => {
    const notFound = { record: null, verdict: { advanceVersion: false, discrepancy: null, notFoundOnce: true, paid: { balanceDue: null, state: null }, status: "NotFound" } };
    store.getProposal.mockResolvedValue(proposal({ discrepancy: differing.verdict.discrepancy as unknown as Record<string, unknown> }));
    const result = await recordReadback({} as never, 5, notFound, SYSTEM, NOW);
    expect(store.updateProposal.mock.calls[0][3]).toEqual({ LastReadBackAt: NOW, MyobStatus: "NotFound" });
    expect(record).not.toHaveBeenCalled();
    expect(result).toEqual({ discrepancyChanged: false, versionAdvanced: false });
  });

  it("ledgers the difference clearing", async () => {
    store.getProposal.mockResolvedValue(proposal({ discrepancy: differing.verdict.discrepancy as unknown as Record<string, unknown> }));
    await recordReadback({} as never, 5, matching, SYSTEM, NOW);
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "myob.discrepancy", ruleApplied: "cleared" }));
  });
});
