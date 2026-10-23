// The endpoints behind the money-action gate (S11, decision 16). Each one's
// handler calls requireMoneyContext(request) right after requireRole; a guard
// test (src/__tests__/money-gated-routes.test.ts) holds this list and the
// handlers in step both ways, so a route cannot be listed without being gated
// or gated without being listed.
//
// The MYOB routes are here too. Four reach the gate through a shared wrapper
// (`via`): runControllerAction (`moneyGate: true`) and withCaller (a `guard`).
// Read-only MYOB routes (previews, lists, discovery) are not gated. Keep the
// App Insights rule B list in docs/runbooks/monitoring.md in step. WP26's rent
// review decisions that change what a tenant is billed (submit, approve, waive,
// revert) are money actions too.

export interface MoneyGatedRoute {
  /** Source file of the handler, relative to the repo root. */
  file: string;
  /** Wrapper file that makes the call for this handler, when the handler does not. */
  via?: string;
  /** What the person was doing, in plain words, for the access log. */
  label: string;
  /** The app.http registration name (= the /api/<route> path). */
  route: string;
}

export const MONEY_GATED_ROUTES: readonly MoneyGatedRoute[] = [
  { file: "src/functions/approval-limits.ts", label: "Change an approval limit", route: "setApprovalLimit" },
  { file: "src/functions/approval-facts.ts", label: "Change the PO variance margin or cap", route: "setApprovalFact" },
  { file: "src/functions/payments.ts", label: "Record or change a payment", route: "upsertPayment" },
  { file: "src/functions/payments.ts", label: "Mark a payment paid", route: "markPaymentPaid" },
  { file: "src/functions/invoices.ts", label: "Director-approve an invoice", route: "directorApproveJobInvoice" },
  // J6b: the director's approval of a quote is a money decision too (decision 17's step-up, S11).
  { file: "src/functions/quotes.ts", label: "Director-approve a quote", route: "directorApproveQuote" },
  { file: "src/functions/invoices.ts", label: "Mark an invoice created in MYOB", route: "markJobInvoiceMyobCreated" },
  { file: "src/functions/invoices.ts", label: "Undo an invoice's created-in-MYOB mark", route: "unmarkJobInvoiceMyobCreated" },
  { file: "src/functions/purchaseOrders.ts", label: "Mark a purchase order created in MYOB", route: "markPurchaseOrderMyobCreated" },
  { file: "src/functions/purchaseOrders.ts", label: "Undo a purchase order's created-in-MYOB mark", route: "unmarkPurchaseOrderMyobCreated" },
  { file: "src/functions/purchaseOrders.ts", label: "Send a purchase order to a contractor", route: "sendPurchaseOrder" },
  { file: "src/functions/invoices.ts", label: "Undo a director's invoice approval", route: "undoDirectorApproveJobInvoice" },
  { file: "src/functions/submitRentReview.ts", label: "Submit (or apply) a rent review", route: "submitRentReview" },
  { file: "src/functions/approveRentReview.ts", label: "Approve and apply a rent review", route: "approveRentReview" },
  { file: "src/functions/waiveRentReview.ts", label: "Waive a rent review", route: "waiveRentReview" },
  { file: "src/functions/revertRentReview.ts", label: "Revert an applied rent review", route: "revertRentReview" },
  // WP26c: a director's decision on a pending schedule change (rent relief) changes what a tenant is billed.
  { file: "src/functions/ratifyScheduleChange.ts", label: "Approve a schedule change (rent relief)", route: "ratifyScheduleChange" },
  { file: "src/functions/rejectScheduleChange.ts", label: "Reject a schedule change (rent relief)", route: "rejectScheduleChange" },
  // Gated only while EMAIL_REPLY_DECISIONS_ENABLED is on; off, it files the reply and decides nothing.
  { file: "src/functions/emails.ts", label: "Record a director's emailed quote decision", route: "recordEmailQuoteDecision" },
  // MYOB: every route that writes to or reconfigures the MYOB link. pauseMyob is
// deliberately absent: the emergency stop must never wait on a step-up.
  { file: "src/functions/approveAndSendToMyob.ts", label: "Approve and send a record to MYOB", route: "approveAndSendToMyob", via: "src/myob/proposalHttp.ts" },
  { file: "src/functions/proposeToMyob.ts", label: "Propose a record to MYOB", route: "proposeToMyob", via: "src/myob/proposalHttp.ts" },
  { file: "src/functions/setMyobControl.ts", label: "Change a MYOB control", route: "setMyobControl" },
  { file: "src/functions/setMyobFileMode.ts", label: "Change a MYOB company file's mode", route: "setMyobFileMode", via: "src/myob-controller-handler.ts" },
  { file: "src/functions/registerMyobCompanyFile.ts", label: "Register a MYOB company file", route: "registerMyobCompanyFile", via: "src/myob-controller-handler.ts" },
  { file: "src/functions/importMyobMappings.ts", label: "Import MYOB mappings", route: "importMyobMappings", via: "src/myob-controller-handler.ts" },
  { file: "src/functions/acceptMyobBaseline.ts", label: "Accept MYOB's record as the baseline", route: "acceptMyobBaseline", via: "src/myob-controller-handler.ts" },
];

export function isMoneyGatedRoute(route: string): boolean {
  return MONEY_GATED_ROUTES.some((entry) => entry.route === route);
}
