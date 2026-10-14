/// <reference types="jest" />

import type { ProposalRow } from "./proposalRow";
import { proposalView } from "./proposalView";

const row = (over: Partial<ProposalRow>) => ({ myobSnapshot: null, operation: "orders.create", ...over }) as ProposalRow;

describe("proposalView", () => {
  it("adds the paid status MYOB's record showed, for orders and bills", () => {
    expect(proposalView(row({ myobSnapshot: { BalanceDueAmount: 4, Status: "Open", TotalAmount: 10 } })).paid).toEqual({ balanceDue: 4, state: "part_paid" });
    expect(proposalView(row({ myobSnapshot: { BalanceDueAmount: 0, Status: "Closed", TotalAmount: 10 }, operation: "bills.create" })).paid).toEqual({
      balanceDue: 0,
      state: "paid",
    });
  });

  it("says nothing for a quote, a record not yet read back, or one without a balance", () => {
    expect(proposalView(row({ myobSnapshot: { BalanceDueAmount: 0, TotalAmount: 10 }, operation: "quotes.create" })).paid).toBeNull();
    expect(proposalView(row({})).paid).toBeNull();
    expect(proposalView(row({ myobSnapshot: { Status: "Open" } })).paid).toBeNull();
  });
});
