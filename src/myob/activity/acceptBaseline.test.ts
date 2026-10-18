/// <reference types="jest" />

// "Accept MYOB's record as the baseline" (SPR-M4, CFO only): after a hand edit
// in MYOB she has checked, Floorplan takes MYOB's record and version as what it
// last saw. It changes only Floorplan's mirror of the record (MyobProposals),
// never MYOB and never a Floorplan money record.

jest.mock("../../ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../proposalsStore", () => ({ getProposal: jest.fn(), latestVerifiedForUid: jest.fn(), updateProposal: jest.fn() }));

import { MyobPurchaseError } from "../../myob-purchase-order";
import type { ProposalRow } from "../proposalRow";
import { acceptBaseline, readForAcceptance } from "./acceptBaseline";

const { record } = require("../../ledger") as { record: jest.Mock };
const store = require("../proposalsStore") as Record<string, jest.Mock>;

const CF = "0f9e8d7c-6b5a-4f3e-9d2c-1b0a99887766";
const NOW = new Date("2026-10-17T00:00:00Z");
const JOHANNE = { kind: "user" as const, name: "Johanne", role: "cfo", userId: 12 };
const SENT = { Date: "2026-10-14T00:00:00", IsTaxInclusive: true, JournalMemo: "FP 66Sm261014 · proposed Ray", Lines: [{ Account: { UID: "a" }, Total: 4840, Type: "Transaction" }], Number: "66Sm261014", Supplier: { UID: "s" } };
const EDITED = { ...SENT, JournalMemo: "Johanne: hold", RowVersion: "9", Status: "Open", UID: "uid-1" };
const proposal = (over: Partial<ProposalRow> = {}) =>
  ({
    companyFileId: CF, correlationId: "c", discrepancy: { fields: [{ field: "JournalMemo", floorplan: "FP …", label: "Memo", myob: "Johanne: hold" }] }, jobId: 12,
    myobRowVersion: "7", myobSnapshot: EDITED, myobStatus: "Open", myobUid: "uid-1", operation: "orders.create", payload: SENT, proposalId: 5,
    readBack: { ...SENT, RowVersion: "7", Status: "Open", UID: "uid-1" }, rendered: { document: "Order", number: "66Sm261014" }, rowVersion: "v1", state: "verified",
    subjectId: 9, subjectType: "purchase_order", ...over,
  }) as ProposalRow;
const input = (over: Record<string, unknown> = {}) => ({ expectedRowVersion: "v1", myobRecord: EDITED, myobRowVersion: "9", note: "Johanne's hold is right", proposalId: 5, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  store.getProposal.mockResolvedValue(proposal());
  store.latestVerifiedForUid.mockResolvedValue(proposal());
  store.updateProposal.mockImplementation(async () => proposal({ rowVersion: "v2" }));
});

describe("acceptBaseline", () => {
  it("takes MYOB's record and its version as the baseline, clears the discrepancy, and ledgers her note", async () => {
    await acceptBaseline({} as never, JOHANNE, input(), NOW);
    expect(store.getProposal).toHaveBeenCalledWith(expect.anything(), 5, true);
    expect(store.updateProposal).toHaveBeenCalledWith(expect.anything(), 5, "v1", {
      Discrepancy: null, LastReadBackAt: NOW, MyobRowVersion: "9", MyobSnapshot: JSON.stringify(EDITED), MyobStatus: "Open", ReadBack: JSON.stringify(EDITED),
    });
    expect(record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      action: "myob.control_change",
      after: expect.objectContaining({ accepted: [expect.objectContaining({ label: "Memo" })], myobRowVersion: "9", proposalId: 5, record: "Order 66Sm261014" }),
      before: expect.objectContaining({ myobRowVersion: "7" }),
      reason: "Johanne's hold is right",
      ruleApplied: "accept_baseline",
      subject: { id: `${CF}:baseline`, type: "myob_control" },
    }));
  });

  it.each([
    ["MYOB changed again since she checked", () => acceptBaseline({} as never, JOHANNE, input({ myobRecord: { ...EDITED, RowVersion: "10" } }), NOW), 409],
    ["a stale proposal version", () => acceptBaseline({} as never, JOHANNE, input({ expectedRowVersion: "old" }), NOW), 409],
    ["a proposal that isn't verified", () => (store.getProposal.mockResolvedValue(proposal({ state: "exception" })), acceptBaseline({} as never, JOHANNE, input(), NOW)), 409],
    ["a proposal a later one superseded", () => (store.latestVerifiedForUid.mockResolvedValue(proposal({ proposalId: 8 })), acceptBaseline({} as never, JOHANNE, input(), NOW)), 409],
    ["an invoice (its amounts are fixed once approved or paid)", () => (store.getProposal.mockResolvedValue(proposal({ subjectType: "invoice" })), acceptBaseline({} as never, JOHANNE, input(), NOW)), 409],
    ["a record MYOB no longer has", () => acceptBaseline({} as never, JOHANNE, input({ myobRecord: null }), NOW), 409],
    ["a proposal that doesn't exist", () => (store.getProposal.mockResolvedValue(null), acceptBaseline({} as never, JOHANNE, input(), NOW)), 404],
  ])("refuses %s, changing nothing", async (_label, act, status) => {
    await expect((act as () => Promise<unknown>)()).rejects.toMatchObject({ status });
    expect(store.updateProposal).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it.each([
    ["the amount", { Lines: [{ Account: { UID: "a" }, Total: 4900, Type: "Transaction" }] }, "Amount"],
    ["the supplier", { Supplier: { UID: "s2" } }, "Supplier"],
    ["tax-inclusive", { IsTaxInclusive: false }, "Tax inclusive"],
    ["the record's date", { Date: "2026-10-15T00:00:00" }, "Date"],
  ])("refuses to accept a difference in %s: accepting MYOB's value into Floorplan isn't built", async (_label, edit, label) => {
    await expect(acceptBaseline({} as never, JOHANNE, input({ myobRecord: { ...EDITED, ...edit } }), NOW)).rejects.toMatchObject({
      message: expect.stringMatching(new RegExp(`${label}.*isn't built`)),
      status: 409,
    });
    expect(store.updateProposal).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it("409s when someone else changed the proposal between the lock and the write", async () => {
    store.updateProposal.mockResolvedValue(null);
    await expect(acceptBaseline({} as never, JOHANNE, input(), NOW)).rejects.toMatchObject({ status: 409 });
    expect(record).not.toHaveBeenCalled();
  });
});

describe("readForAcceptance", () => {
  it("reads MYOB's record now through the GET-only reader, and a 404 as no record", async () => {
    const get = jest.fn().mockResolvedValueOnce(EDITED).mockRejectedValueOnce(new MyobPurchaseError(404, "gone"));
    const actor = { kind: "user" as const, name: "Johanne", oid: "cfo-oid" };
    await expect(readForAcceptance(proposal(), actor, { get })).resolves.toEqual(EDITED);
    expect(get).toHaveBeenCalledWith("Order", CF, "uid-1", actor, "c");
    await expect(readForAcceptance(proposal(), actor, { get })).resolves.toBeNull();
  });
});
