// REV-04: archiving takes a job out of every list and makes every money action
// on it refuse (jobMoneyRefusal), so a job with live money is not archived: its
// purchase orders and invoices would be stranded, and the close rules (D3) would
// be bypassed. Decided from the same facts the transition guard reads.

import type { GuardFacts } from "./jobTransitionGuard";

export const JOB_HAS_LIVE_MONEY = "job_has_live_money";

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** What is still in progress on the job, in plain words. Empty when nothing is. */
export function liveMoneyOutstanding(facts: Pick<GuardFacts, "approvedInvoicesNotInMyob" | "hasApprovedQuote" | "hasCompletePurchaseOrder" | "incomingInvoicesAwaitingApproval" | "purchaseOrdersNotInMyob">): string[] {
  const out: string[] = [];
  if (facts.hasApprovedQuote && !facts.hasCompletePurchaseOrder) out.push("an approved quote with no completed purchase order");
  if (facts.purchaseOrdersNotInMyob > 0) out.push(`${plural(facts.purchaseOrdersNotInMyob, "purchase order", "purchase orders")} not recorded in MYOB`);
  if (facts.incomingInvoicesAwaitingApproval > 0) {
    out.push(`${plural(facts.incomingInvoicesAwaitingApproval, "invoice", "invoices")} waiting for approval (including any with the director)`);
  }
  if (facts.approvedInvoicesNotInMyob > 0) out.push(`${plural(facts.approvedInvoicesNotInMyob, "approved invoice", "approved invoices")} not recorded in MYOB`);
  return out;
}

/** The refusal sentence naming what is outstanding. */
export function liveMoneyMessage(outstanding: readonly string[]): string {
  return `This job has purchase orders or invoices still in progress: ${outstanding.join("; ")}. Finish or reject them before archiving.`;
}
