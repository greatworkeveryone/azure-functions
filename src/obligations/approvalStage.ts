// Whose move a quote or an invoice is at, and whether one viewer may make it. Pure: the authority facts come in.
// The digest and the inbox both read this, so a line in one is a line in the other.

import { canApprove, decideAuthority, type AuthorityFacts } from "../approvalAuthority";
import { roleLabel } from "../escalation/roles";
import type { Viewer } from "./types";

export type ApprovalSubject = "invoice" | "quote";

export interface ApprovalSubjectFacts {
  amount: number | null;
  buildingId: number | null;
  jobId: number;
  /** Quotes.Status or JobInvoices.Status as stored. */
  status: string;
  subject: ApprovalSubject;
}

/** The first approver (anyone with authority for the amount) or the director; null when nothing is waiting. */
export function approvalStage(facts: ApprovalSubjectFacts, authority: AuthorityFacts): "director" | "first" | null {
  if (facts.status === "pending" || facts.status === "awaiting_approval") return "first";
  if (facts.subject === "quote") return facts.status === "awaiting_director" ? "director" : null;
  if (facts.status !== "approved") return null;
  // A stage-1 approved invoice only waits for someone when its amount needs the director.
  const route = decideAuthority({ amount: amountOf(facts), buildingId: facts.buildingId ?? 0, jobId: facts.jobId, subject: "invoice" }, authority);
  return route.directorRequired ? "director" : null;
}

/** An unknown amount is NaN, which the rules treat as "needs the director". */
export const amountOf = (facts: Pick<ApprovalSubjectFacts, "amount">): number => (facts.amount === null ? Number.NaN : facts.amount);

/** Whether the viewer may make the move now, by the approval-authority rules the action itself uses. Admin is never asked. */
export function mayApprove(viewer: Viewer, facts: ApprovalSubjectFacts, authority: AuthorityFacts): boolean {
  if (viewer.roles.includes("admin")) return false;
  const stage = approvalStage(facts, authority);
  if (stage === null) return false;
  if (stage === "director") return viewer.roles.includes("director");
  const identity = { email: viewer.email ?? undefined, roles: viewer.roles, userId: viewer.userId ?? undefined };
  return canApprove(identity, { amount: amountOf(facts), buildingId: facts.buildingId ?? 0, jobId: facts.jobId, subject: facts.subject }, authority).allowed;
}

/** Who has it, in words: "a director", or the first role in the route. */
export function approverWords(facts: ApprovalSubjectFacts, authority: AuthorityFacts): string {
  if (approvalStage(facts, authority) === "director") return "a director";
  const route = decideAuthority({ amount: amountOf(facts), buildingId: facts.buildingId ?? 0, jobId: facts.jobId, subject: facts.subject }, authority).route;
  const first = route[0];
  if (!first) return "a manager";
  if (first.kind === "user") return first.displayName ?? "a manager";
  return first.role === "director" ? "a director" : `a ${roleLabel(first.role).toLowerCase()}`;
}
