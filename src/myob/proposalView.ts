// What the browser sees of a proposal (plan M10): the row, plus what MYOB's own
// record showed when Floorplan last read it (the read-back snapshot, or the
// read-back after sending):
//   inMyob  MYOB's amount and supplier name, so the panel shows MYOB's values,
//           not Floorplan's
//   paid    orders by balance due, bills by Status Closed or no balance; a
//           quote is never paid. From the purchase record itself, never Payments.

import { KIND_OF } from "./kinds";
import type { ProposalRow } from "./proposalRow";
import { paidState, type PaidState } from "./readbackCompare";
import { formatAud } from "./render";

export type ProposalView = ProposalRow & {
  inMyob: { amount: string | null; supplier: string | null } | null;
  paid: { balanceDue: number | null; state: Exclude<PaidState, null> } | null;
};

function inMyob(record: Record<string, unknown> | null): ProposalView["inMyob"] {
  if (!record) return null;
  const total = Number(record.TotalAmount);
  const supplier = record.Supplier && typeof record.Supplier === "object" ? (record.Supplier as Record<string, unknown>).Name : null;
  return { amount: Number.isFinite(total) && record.TotalAmount !== null ? formatAud(total) : null, supplier: typeof supplier === "string" && supplier ? supplier : null };
}

export function proposalView(row: ProposalRow): ProposalView {
  const record = row.myobSnapshot ?? row.readBack;
  const paid = record ? paidState(record, KIND_OF[row.operation]) : { balanceDue: null, state: null };
  return { ...row, inMyob: inMyob(record), paid: paid.state ? { balanceDue: paid.balanceDue, state: paid.state } : null };
}
