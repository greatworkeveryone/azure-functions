// The lease event escalation policies (seeded by migration 098) and the
// deadline warning, with no imports, so the escalation adapter and the domain
// can both read them without a circular import.

export const LEASE_POLICIES = {
  optionDeadline: "lease.option_deadline",
  optionLapsed: "lease.option_lapsed",
  renewal: "lease.renewal",
} as const;

export type LeasePolicyKey = (typeof LEASE_POLICIES)[keyof typeof LEASE_POLICIES];

/** Days before the notice deadline that an open window with no notice is escalated. */
export const OPTION_DEADLINE_WARNING_DAYS = 30;
