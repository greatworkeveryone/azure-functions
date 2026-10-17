/// <reference types="jest" />

import type { ProposalRow } from "./proposalRow";
import { proposalView } from "./proposalView";

const row = (over: Partial<ProposalRow>) => ({ myobSnapshot: null, operation: "orders.create", readBack: null, ...over }) as ProposalRow;

describe("proposalView", () => {
  it("adds the paid status MYOB's record showed, for orders and bills", () => {
    expect(proposalView(row({ myobSnapshot: { BalanceDueAmount: 4, Status: "Open", TotalAmount: 10 } })).paid).toEqual({ balanceDue: 4, state: "part_paid" });
    expect(proposalView(row({ myobSnapshot: { BalanceDueAmount: 0, Status: "Closed", TotalAmount: 10 }, operation: "bills.create" })).paid).toEqual({
      balanceDue: 0,
      state: "paid",
    });
  });

  it("never calls an order paid because MYOB closed it; only a zero balance", () => {
    expect(proposalView(row({ myobSnapshot: { BalanceDueAmount: 10, Status: "Closed", TotalAmount: 10 } })).paid).toEqual({ balanceDue: 10, state: "unpaid" });
  });

  it("gives MYOB's own amount and supplier, from the last read-back or, before one, the read-back after sending", () => {
    expect(proposalView(row({ myobSnapshot: { Supplier: { Name: "ACME Air (MYOB)", UID: "s" }, TotalAmount: 4900 } })).inMyob).toEqual({ amount: "$4,900.00 inc GST", supplier: "ACME Air (MYOB)" });
    expect(proposalView(row({ readBack: { Supplier: { UID: "s" }, TotalAmount: 4840 } })).inMyob).toEqual({ amount: "$4,840.00 inc GST", supplier: null });
    expect(proposalView(row({})).inMyob).toBeNull();
  });

  it("says nothing for a quote, a record not yet read back, or one without a balance", () => {
    expect(proposalView(row({ myobSnapshot: { BalanceDueAmount: 0, TotalAmount: 10 }, operation: "quotes.create" })).paid).toBeNull();
    expect(proposalView(row({})).paid).toBeNull();
    expect(proposalView(row({ myobSnapshot: { Status: "Open" } })).paid).toBeNull();
  });
});
