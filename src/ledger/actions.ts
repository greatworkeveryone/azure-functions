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

  // Job lifecycle decisions (beta sprint J2). Done is final: reopening one is
  // a manager's exception with a reason. The MYOB read-back closing a job
  // whose invoices are all paid is a system decision.
  "job.invoices_paid": { exception: false, reasonRequired: false, subjects: ["job"] },
  "job.reopen": { exception: true, reasonRequired: true, subjects: ["job"] },

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

  // Escalations (WP20). The subject is the escalation itself; the row carries
  // the job or tenant it is about in its scope columns. A withdrawal is the one
  // exception: a person decided the escalation was not needed.
  "escalation.acknowledge": { exception: false, reasonRequired: false, subjects: ["escalation"] },
  "escalation.auto_resolve": { exception: false, reasonRequired: false, subjects: ["escalation"] },
  "escalation.raise": { exception: false, reasonRequired: false, subjects: ["escalation"] },
  "escalation.resolve": { exception: false, reasonRequired: false, subjects: ["escalation"] },
  "escalation.supersede": { exception: false, reasonRequired: false, subjects: ["escalation"] },
  "escalation.withdraw": { exception: true, reasonRequired: true, subjects: ["escalation"] },

  // Access-pattern monitoring (beta sprint S10, decision 15). The subject is the
  // person (UserID, or Entra oid when they have no AppUsers row); the actor of an
  // anomaly is the monitor. A profile change loosens or tightens what counts as
  // unusual, so it is an exception too.
  "access.anomaly": { exception: true, reasonRequired: false, subjects: ["app_user"] },
  "access.profile_change": { exception: true, reasonRequired: false, subjects: ["app_user"] },
  // MYOB link (sprint M0). Link, re-link and unlink share one code; RuleApplied
  // says which. Always an exception: a change of who Floorplan acts as in MYOB
  // is the first thing the CFO audits.
  "myob.link": { exception: true, reasonRequired: false, subjects: ["myob_link"] },
  // The CFO's switches (sprint M1): set, pause, resume. Her note is the reason.
  "myob.control_change": { exception: true, reasonRequired: true, subjects: ["myob_control"] },
  // The proposal pipeline (sprint M3, decision 12): one row per step. An
  // exception (MYOB said no, the outcome is unknown, or the read-back differs)
  // and a withdrawal are exceptions; a withdrawal needs its reason.
  "myob.approve": { exception: false, reasonRequired: false, subjects: ["myob_proposal"] },
  "myob.exception": { exception: true, reasonRequired: false, subjects: ["myob_proposal"] },
  "myob.propose": { exception: false, reasonRequired: false, subjects: ["myob_proposal"] },
  "myob.push": { exception: false, reasonRequired: false, subjects: ["myob_proposal"] },
  "myob.withdraw": { exception: true, reasonRequired: true, subjects: ["myob_proposal"] },
  // Incoming triage (S3, SEC-05): hiding an email from Incoming names who did it.
  "email.archive": { exception: false, reasonRequired: false, subjects: ["email"] },
} as const satisfies Record<string, ActionDefinition>;

export type LedgerAction = keyof typeof LEDGER_ACTIONS;

export function ledgerActionDefinition(action: string): ActionDefinition | undefined {
  return (LEDGER_ACTIONS as Record<string, ActionDefinition>)[action];
}
