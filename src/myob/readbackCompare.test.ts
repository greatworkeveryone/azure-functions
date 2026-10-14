/// <reference types="jest" />

import { compareReadback, paidState } from "./readbackCompare";

const NOW = new Date("2026-10-15T00:12:00Z");
const SENT = {
  Date: "2026-10-14T00:00:00",
  Lines: [{ Account: { UID: "acct" }, TaxCode: { UID: "gst" }, Total: 4840, Type: "Transaction" }],
  Number: "66Sm261014",
  Supplier: { UID: "sup" },
};
const myob = (over: Record<string, unknown> = {}) => ({ ...SENT, LastModified: "2026-10-14T23:20:00", RowVersion: "9", Status: "Open", ...over });
const compare = (record: Record<string, unknown> | null, lastSeen: Record<string, unknown> | null = { Status: "Open" }) =>
  compareReadback({
    floorplanLastTouch: { action: "po.create", at: "2026-10-14T00:01:00.000Z", name: "Ray" },
    lastSeen,
    myob: record,
    now: NOW,
    sent: SENT,
    sentLabels: { supplier: "ACME Air Pty Ltd" },
  });

describe("compareReadback", () => {
  it("finds nothing to say, and takes MYOB's version, when MYOB holds what was sent", () => {
    expect(compare(myob())).toEqual({ advanceVersion: true, discrepancy: null, paid: { balanceDue: null, state: null }, status: "Open" });
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

  it("says missing in MYOB when the record is gone", () => {
    expect(compare(null)).toMatchObject({ advanceVersion: false, discrepancy: { fields: [], missing: true }, status: "Missing" });
  });

  it("reports a status change (an order converted to a bill) but still takes the version: the content matches", () => {
    const verdict = compare(myob({ Status: "ConvertedToBill" }));
    expect(verdict.advanceVersion).toBe(true);
    expect(verdict.discrepancy?.fields).toEqual([{ field: "status", floorplan: "Open", label: "Status", myob: "ConvertedToBill" }]);
  });

  it("shows a paid bill as paid, not as a disagreement", () => {
    const verdict = compare(myob({ BalanceDueAmount: 0, Status: "Closed", TotalAmount: 4840 }));
    expect(verdict).toMatchObject({ discrepancy: null, paid: { balanceDue: 0, state: "paid" } });
  });
});

describe("paidState", () => {
  it("reads paid, part paid and unpaid from the record alone", () => {
    expect(paidState({ BalanceDueAmount: 0, Status: "Open", TotalAmount: 10 })).toEqual({ balanceDue: 0, state: "paid" });
    expect(paidState({ BalanceDueAmount: 4, Status: "Open", TotalAmount: 10 })).toEqual({ balanceDue: 4, state: "part_paid" });
    expect(paidState({ BalanceDueAmount: 10, Status: "Open", TotalAmount: 10 })).toEqual({ balanceDue: 10, state: "unpaid" });
    expect(paidState({ Status: "Open" })).toEqual({ balanceDue: null, state: null });
  });
});
