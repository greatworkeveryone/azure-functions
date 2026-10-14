// The endpoints behind the money-action gate (S11, decision 16). Each one's
// handler calls requireMoneyContext(request) right after requireRole; a guard
// test (src/__tests__/money-gated-routes.test.ts) holds this list and the
// handlers in step both ways, so a route cannot be listed without being gated
// or gated without being listed.
//
// Lane M adds its MYOB routes here when they exist (proposal approve / push /
// update, controls set), with the same one-line call in each handler. Keep the
// App Insights rule B list in docs/runbooks/monitoring.md in step.

export interface MoneyGatedRoute {
  /** Source file of the handler, relative to the repo root. */
  file: string;
  /** What the person was doing, in plain words, for the access log. */
  label: string;
  /** The app.http registration name (= the /api/<route> path). */
  route: string;
}

export const MONEY_GATED_ROUTES: readonly MoneyGatedRoute[] = [
  { file: "src/functions/approval-limits.ts", label: "Change an approval limit", route: "setApprovalLimit" },
  { file: "src/functions/payments.ts", label: "Record or change a payment", route: "upsertPayment" },
  { file: "src/functions/payments.ts", label: "Mark a payment paid", route: "markPaymentPaid" },
  { file: "src/functions/invoices.ts", label: "Director-approve an invoice", route: "directorApproveJobInvoice" },
  { file: "src/functions/purchaseOrders.ts", label: "Mark a purchase order created in MYOB", route: "markPurchaseOrderMyobCreated" },
];

export function isMoneyGatedRoute(route: string): boolean {
  return MONEY_GATED_ROUTES.some((entry) => entry.route === route);
}
