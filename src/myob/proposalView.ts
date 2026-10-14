// What the browser sees of a proposal (plan M10): the row plus the paid status
// MYOB's own record showed at the last read-back. Orders and bills only; a
// quote is never paid. Read from the purchase record itself, never Payments.

import type { ProposalRow } from "./proposalRow";
import { paidState, type PaidState } from "./readbackCompare";

export type ProposalView = ProposalRow & { paid: { balanceDue: number | null; state: Exclude<PaidState, null> } | null };

export function proposalView(row: ProposalRow): ProposalView {
  if (row.operation.startsWith("quotes.") || !row.myobSnapshot) return { ...row, paid: null };
  const paid = paidState(row.myobSnapshot);
  return { ...row, paid: paid.state ? { balanceDue: paid.balanceDue, state: paid.state } : null };
}
