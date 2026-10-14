// What an approve click does, decided by the approval-authority core
// (approvalAuthority.ts). approveQuote and approveJobInvoice both route
// through here, so a quote and an invoice of the same amount land the same way.
//
// Pure. The handler loads the facts (approvalAuthority-db.ts) and whether the
// record is test data (testRecords.ts).

import {
  canApprove,
  decideAuthority,
  type Approver,
  type AuthorityFacts,
  type AuthorityInput,
  type DenyReason,
  type Identity,
  type Subject,
} from "./approvalAuthority";

export type ApprovalRefusalReason = DenyReason | "admin_test_records_only";

export type ApprovalOutcome =
  /** Fully approved on the caller's own authority. */
  | { kind: "approved"; route: Approver[] }
  /** Above the director threshold, or the amount is unknown: the director's own step decides. */
  | { kind: "awaiting_director"; route: Approver[] }
  /** Beyond the caller's limit; someone further up `route` can approve it. */
  | { actorLimit: number | null | undefined; kind: "awaiting_approval"; route: Approver[] }
  | { kind: "refused"; message: string; reason: ApprovalRefusalReason; route: Approver[] };

const ADMIN = "admin";

const SUBJECT_WORDS: Record<Subject, string> = {
  invoice: "invoice",
  purchase_order: "purchase order",
  quote: "quote",
};

function refusalMessage(reason: ApprovalRefusalReason, subject: Subject): string {
  switch (reason) {
    case "admin_test_records_only":
      return "Admin can approve test records only. Real spend is approved by a manager, the CFO or a director.";
    case "creator":
      return `You raised this ${SUBJECT_WORDS[subject]}, so someone else has to approve it.`;
    case "not_residence_approver":
      return "Only this residence's approvers can approve its spend.";
    case "attribution_required":
    case "attribution_invalid":
      return `Your role can't approve this ${SUBJECT_WORDS[subject]} on its own. Ask a manager to approve it.`;
    default:
      return `Your role can't approve this ${SUBJECT_WORDS[subject]}.`;
  }
}

/**
 * Decision 4 (beta sprint, 13 Oct 2026): admin approves only records flagged
 * as test data. On a real record the admin role counts for nothing; any other
 * role the caller holds still counts.
 */
function withoutAdminUnlessTest(identity: Identity, isTest: boolean): Identity | null {
  const roles = Array.isArray(identity.roles) ? identity.roles : [];
  const others = roles.filter((role) => role.trim().toLowerCase() !== ADMIN);
  if (isTest || others.length === roles.length) return identity;
  return others.length === 0 ? null : { ...identity, roles: others };
}

/**
 * Checks, in order:
 *  1. admin on a real record with no other role → refused (decision 4);
 *  2. above the director threshold or an unknown amount → awaiting_director,
 *     whoever clicked (the director then approves in their own step);
 *  3. within the caller's own authority → approved;
 *  4. beyond the caller's limit → awaiting_approval;
 *  5. anything else canApprove denies → refused, with the reason and a sentence.
 */
export function approvalOutcome(
  identity: Identity,
  input: AuthorityInput,
  facts: AuthorityFacts,
  record: { isTest: boolean },
): ApprovalOutcome {
  const { directorRequired, route } = decideAuthority(input, facts);
  const actor = withoutAdminUnlessTest(identity, record.isTest);
  const refuse = (reason: ApprovalRefusalReason): ApprovalOutcome => ({
    kind: "refused",
    message: refusalMessage(reason, input.subject),
    reason,
    route,
  });

  if (actor === null) return refuse("admin_test_records_only");
  if (directorRequired) return { kind: "awaiting_director", route };
  const decision = canApprove(actor, input, facts);
  if (decision.allowed) return { kind: "approved", route };
  if (decision.reason === "over_limit") return { actorLimit: decision.actorLimit, kind: "awaiting_approval", route };
  return refuse(decision.reason);
}
