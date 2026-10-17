/// <reference types="jest" />

import { compareReadback, paidState } from "./readbackCompare";

const NOW = new Date("2026-10-15T00:12:00Z");
const SENT = {
  Date: "2026-10-14T00:00:00",
  IsTaxInclusive: true,
  Lines: [{ Account: { UID: "acct" }, TaxCode: { UID: "gst" }, Total: 4840, Type: "Transaction" }],
  Number: "66Sm261014",
  Supplier: { UID: "sup" },
};
const myob = (over: Record<string, unknown> = {}) => ({ ...SENT, LastModified: "2026-10-14T23:20:00", RowVersion: "9", Status: "Open", ...over });
const READ_BACK = { ...SENT, LastModified: "2026-10-14T00:06:00", RowVersion: "7", Status: "Open" };
const compare = (
  record: Record<string, unknown> | null,
  over: { kind?: "Bill" | "Order" | "Quote"; lastSeen?: Record<string, unknown> | null; previousStatus?: string | null } = {},
) =>
  compareReadback({
    floorplanLastTouch: { action: "po.create", at: "2026-10-14T00:01:00.000Z", name: "Ray" },
    kind: over.kind ?? "Order",
    lastSeen: over.lastSeen === undefined ? READ_BACK : over.lastSeen,
    myob: record,
    now: NOW,
    previousStatus: over.previousStatus ?? "Open",
    sent: SENT,
    sentLabels: { supplier: "ACME Air Pty Ltd" },
  });

describe("compareReadback", () => {
  it("finds nothing to say, and takes MYOB's version, when MYOB holds what was sent", () => {
    expect(compare(myob())).toEqual({ advanceVersion: true, discrepancy: null, notFoundOnce: false, paid: { balanceDue: null, state: null }, status: "Open" });
  });

  it("names a changed amount in the CFO's words, keeps the old version, and says who last touched it in Floorplan", () => {
    const verdict = compare(myob({ Lines: [{ ...SENT.Lines[0], Total: 4900 }] }));
    expect(verdict.advanceVersion).toBe(false);
    expect(verdict.discrepancy).toMatchObject({
      fields: [{ field: "total", floorplan: "$4,840.00 inc GST", label: "Amount", myob: "$4,900.00 inc GST" }],
      floorplanLastTouch: { name: "Ray" },
      missing: false,
      myobLastModified: "2026-10-14T23:20:00",
      seenAt: NOW.toISOString(),
    });
  });

  it("names the supplier MYOB now holds", () => {
    const verdict = compare(myob({ Supplier: { Name: "Other Air", UID: "other" } }));
    expect(verdict.discrepancy?.fields).toEqual([{ field: "supplierUid", floorplan: "ACME Air Pty Ltd", label: "Supplier", myob: "Other Air" }]);
  });

  it("calls a record missing only after two reads in a row find nothing (a one-off 404 is noted, not ledgered)", () => {
    expect(compare(null)).toEqual({ advanceVersion: false, discrepancy: null, notFoundOnce: true, paid: { balanceDue: null, state: null }, status: "NotFound" });
    expect(compare(null, { previousStatus: "NotFound" })).toMatchObject({ advanceVersion: false, discrepancy: { fields: [], missing: true }, notFoundOnce: false, status: "Missing" });
    expect(compare(null, { previousStatus: "Missing" })).toMatchObject({ discrepancy: { missing: true }, status: "Missing" });
  });

  it("names tax-inclusive as money: the same line totals flipped to tax-exclusive", () => {
    const verdict = compare(myob({ IsTaxInclusive: false }));
    expect(verdict.advanceVersion).toBe(false);
    expect(verdict.discrepancy?.fields).toEqual([{ field: "isTaxInclusive", floorplan: "Yes", label: "Tax inclusive", myob: "No" }]);
  });

  it("never takes MYOB's version without the record as read back to compare with", () => {
    expect(compare(myob(), { lastSeen: null }).advanceVersion).toBe(false);
  });

  it("reports a status change (an order converted to a bill) but still takes the version: the content matches", () => {
    const verdict = compare(myob({ Status: "ConvertedToBill" }));
    expect(verdict.advanceVersion).toBe(true);
    expect(verdict.discrepancy?.fields).toEqual([{ field: "status", floorplan: "Open", label: "Status", myob: "ConvertedToBill" }]);
  });

  it("shows a paid bill as paid, not as a disagreement", () => {
    const verdict = compare(myob({ BalanceDueAmount: 0, Status: "Closed", TotalAmount: 4840 }), { kind: "Bill" });
    expect(verdict).toMatchObject({ discrepancy: null, paid: { balanceDue: 0, state: "paid" } });
  });

  it("never calls an order paid because MYOB closed it (billed or received): only a zero balance is paid", () => {
    const closed = compare(myob({ BalanceDueAmount: 4840, Status: "Closed", TotalAmount: 4840 }));
    expect(closed.paid).toEqual({ balanceDue: 4840, state: "unpaid" });
    expect(closed.discrepancy?.fields).toEqual([{ field: "status", floorplan: "Open", label: "Status", myob: "Closed" }]);
    expect(compare(myob({ BalanceDueAmount: 0, Status: "Closed", TotalAmount: 4840 })).paid).toEqual({ balanceDue: 0, state: "paid" });
  });
});

describe("paidState", () => {
  it("reads paid, part paid and unpaid from the record alone", () => {
    expect(paidState({ BalanceDueAmount: 0, Status: "Open", TotalAmount: 10 }, "Bill")).toEqual({ balanceDue: 0, state: "paid" });
    expect(paidState({ BalanceDueAmount: 4, Status: "Open", TotalAmount: 10 }, "Bill")).toEqual({ balanceDue: 4, state: "part_paid" });
    expect(paidState({ BalanceDueAmount: 10, Status: "Open", TotalAmount: 10 }, "Bill")).toEqual({ balanceDue: 10, state: "unpaid" });
    expect(paidState({ Status: "Open" }, "Bill")).toEqual({ balanceDue: null, state: null });
  });

  it("pays a bill by Status Closed, an order only by its balance, and never a quote or an empty order", () => {
    expect(paidState({ BalanceDueAmount: 10, Status: "Closed", TotalAmount: 10 }, "Bill").state).toBe("paid");
    expect(paidState({ BalanceDueAmount: 10, Status: "Closed", TotalAmount: 10 }, "Order").state).toBe("unpaid");
    expect(paidState({ BalanceDueAmount: 0, Status: "Open", TotalAmount: 10 }, "Quote").state).toBeNull();
    expect(paidState({ BalanceDueAmount: 0, Status: "Open", TotalAmount: 0 }, "Order").state).not.toBe("paid");
  });
});
