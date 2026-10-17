// Which MYOB purchase document each proposal operation is about.

import type { ProposalOperation } from "./proposalRow";

/** The same names as myob-purchase-order's PurchaseKind, without importing the write client. */
export const KIND_OF: Record<ProposalOperation, "Bill" | "Order" | "Quote"> = {
  "bills.create": "Bill",
  "orders.create": "Order",
  "orders.update": "Order",
  "quotes.create": "Quote",
  "quotes.update": "Quote",
};
