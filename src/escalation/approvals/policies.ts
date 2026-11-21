// The approval and chase policies added by migration 199, and the subjects they hang on. No imports, so adapters
// and handlers can both read them. Each policy is seeded inactive: switching one on is one row,
//   UPDATE dbo.EscalationPolicies SET Active = 1, UpdatedBy = N'<who>' WHERE PolicyKey = N'<key>'
// (or the admin screen), and takes effect within five minutes on every instance.

export const APPROVAL_POLICIES = {
  broadcast: "comms.broadcast_approval",
  holdOverdue: "job.hold_overdue",
  approvalWaiting: "job.approval_waiting",
  leave: "leave.decision",
  optionApproval: "lease.option_approval",
  procedure: "procedure.approval",
  scheduleUnsigned: "tenancy.schedule_unsigned",
} as const;

export type ApprovalPolicyKey = (typeof APPROVAL_POLICIES)[keyof typeof APPROVAL_POLICIES];

export const APPROVAL_SUBJECTS = {
  broadcast: "correspondence",
  leave: "leave_request",
  procedure: "procedure",
} as const;

/** Policies whose escalation ends only with the subject's own decision, so nobody withdraws it by hand. */
export const DECISION_ONLY_POLICIES: ReadonlySet<string> = new Set([
  APPROVAL_POLICIES.broadcast,
  APPROVAL_POLICIES.leave,
  APPROVAL_POLICIES.optionApproval,
  APPROVAL_POLICIES.procedure,
]);
