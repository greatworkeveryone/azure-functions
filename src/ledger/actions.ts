import type { LedgerSubjectType } from "./types";

export interface ActionDefinition {
  /** When true, an entry without `attributedTo` is refused: the decision rests
   *  on a named second person's say-so. */
  attributionRequired?: boolean;
  /** Shown by default in Decisions & exceptions ("exceptions only"). */
  exception: boolean;
  /** A missing or blank reason is refused. */
  reasonRequired: boolean;
  subjects: readonly LedgerSubjectType[] | "any";
}

// Every decision code, `domain.verb`. Each package adds its codes in its own
// block so parallel branches don't collide. Packages still to add theirs:
// WP25–WP26 (rent reviews), WP26b (billing holds), WP29b (billing runs), WP32
// (lease events), WP60–WP62 (comms).
export const LEDGER_ACTIONS = {
  // Refusals, any subject (WP19b)
  denied: { exception: true, reasonRequired: false, subjects: "any" },
  sod_blocked: { exception: true, reasonRequired: false, subjects: "any" },

  // Quote, invoice, purchase order and payment decisions (WP19b). Mirrors of
  // decisions Floorplan already made. The ones that undo or remove a money
  // record are exceptions, because they are what an audit looks for first. None
  // demands a reason: the endpoints don't ask for one yet (LAUNCH-READINESS WP42).
  "invoice.approve": { exception: false, reasonRequired: false, subjects: ["invoice"] },
  "invoice.delete": { exception: true, reasonRequired: false, subjects: ["invoice"] },
  "invoice.director_approve": { exception: false, reasonRequired: false, subjects: ["invoice"] },
  "invoice.myob_created": { exception: false, reasonRequired: false, subjects: ["invoice"] },
  "invoice.reject": { exception: false, reasonRequired: false, subjects: ["invoice"] },
  "invoice.undo_director_approve": { exception: true, reasonRequired: false, subjects: ["invoice"] },
  "invoice.unmark_myob_created": { exception: true, reasonRequired: false, subjects: ["invoice"] },
  "payment.create": { exception: false, reasonRequired: false, subjects: ["payment"] },
  "payment.myob_applied": { exception: false, reasonRequired: false, subjects: ["payment"] },
  "po.complete": { exception: false, reasonRequired: false, subjects: ["purchase_order"] },
  "po.create": { exception: false, reasonRequired: false, subjects: ["purchase_order"] },
  "po.delete": { exception: true, reasonRequired: false, subjects: ["purchase_order"] },
  "po.myob_created": { exception: false, reasonRequired: false, subjects: ["purchase_order"] },
  "po.send": { exception: false, reasonRequired: false, subjects: ["purchase_order"] },
  "po.uncomplete": { exception: true, reasonRequired: false, subjects: ["purchase_order"] },
  "po.unmark_myob_created": { exception: true, reasonRequired: false, subjects: ["purchase_order"] },
  "quote.approve": { exception: false, reasonRequired: false, subjects: ["quote"] },
  "quote.complete": { exception: false, reasonRequired: false, subjects: ["quote"] },
  "quote.delete": { exception: true, reasonRequired: false, subjects: ["quote"] },
  "quote.director_approve": { exception: false, reasonRequired: false, subjects: ["quote"] },
  "quote.director_reject": { exception: false, reasonRequired: false, subjects: ["quote"] },
  "quote.reject": { exception: false, reasonRequired: false, subjects: ["quote"] },
  "quote.unapprove": { exception: true, reasonRequired: false, subjects: ["quote"] },
  "quote.uncomplete": { exception: true, reasonRequired: false, subjects: ["quote"] },

  // Role, limit and attribution decisions (WP19b)
  "approval_limit.change": { exception: true, reasonRequired: false, subjects: ["approval_limit"] },
  "quote.approve_attributed": {
    attributionRequired: true,
    exception: false,
    reasonRequired: false,
    subjects: ["quote"],
  },
  // Raised later by the manager who was named (WP20).
  "quote.attribution_disputed": { exception: true, reasonRequired: true, subjects: ["quote"] },
  "user.role_change": { exception: true, reasonRequired: false, subjects: ["app_user"] },

  // Register and schedule writes (WP23a, WP23b)
  "occupancy.reassign": { exception: true, reasonRequired: true, subjects: ["occupancy"] },
  "schedule.manual_edit": {
    exception: false,
    reasonRequired: false,
    subjects: ["carpark_group", "incentive", "misc_fee", "rate_step"],
  },
  "schedule.recompute_next_review": { exception: false, reasonRequired: false, subjects: ["tenancy"] },
  "schedule.terms_edit": { exception: false, reasonRequired: false, subjects: ["tenancy"] },

  // Stored-holdover reset, run once after deploy (WP23a)
  "tenancy.holdover_reset": { exception: false, reasonRequired: false, subjects: ["tenancy"] },

  // Schedule sign-off (WP24)
  "schedule.sign_off": { exception: false, reasonRequired: false, subjects: ["tenancy"] },
  "schedule.sign_off_cleared": { exception: true, reasonRequired: true, subjects: ["tenancy"] },
  "schedule.sign_off_revoke": { exception: true, reasonRequired: true, subjects: ["tenancy"] },

  // Defects liability periods (sprint F1, LAUNCH-READINESS §5). Booking planned
  // maintenance inside a blocking period is an exception with a reason: RP may
  // be paying for work the builder owes.
  "defects_period.archive": { exception: true, reasonRequired: false, subjects: ["defects_period"] },
  "defects_period.create": { exception: false, reasonRequired: false, subjects: ["defects_period"] },
  "defects_period.restore": { exception: false, reasonRequired: false, subjects: ["defects_period"] },
  "defects_period.update": { exception: false, reasonRequired: false, subjects: ["defects_period"] },
  "job.defects_override": { exception: true, reasonRequired: true, subjects: ["job"] },

  // Escalations (WP20). The subject is the escalation itself; the row carries
  // the job or tenant it is about in its scope columns. A withdrawal is the one
  // exception: a person decided the escalation was not needed.
  "escalation.acknowledge": { exception: false, reasonRequired: false, subjects: ["escalation"] },
  "escalation.auto_resolve": { exception: false, reasonRequired: false, subjects: ["escalation"] },
  "escalation.raise": { exception: false, reasonRequired: false, subjects: ["escalation"] },
  "escalation.resolve": { exception: false, reasonRequired: false, subjects: ["escalation"] },
  "escalation.supersede": { exception: false, reasonRequired: false, subjects: ["escalation"] },
  "escalation.withdraw": { exception: true, reasonRequired: true, subjects: ["escalation"] },
} as const satisfies Record<string, ActionDefinition>;

export type LedgerAction = keyof typeof LEDGER_ACTIONS;

export function ledgerActionDefinition(action: string): ActionDefinition | undefined {
  return (LEDGER_ACTIONS as Record<string, ActionDefinition>)[action];
}
