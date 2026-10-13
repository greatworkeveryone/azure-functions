import type { Connection } from "tedious";
import type { LedgerAction } from "./actions";

// Decision ledger contract (PLAN §3.12, D17). Committed ahead of the store so
// packages that record decisions can code against it while WP19b builds the
// table. Every caller depends on these shapes — change them only in WP19b.

/** A connection with an open transaction. `record()` never begins or commits:
 *  the caller owns the transaction, so a decision and its ledger row commit or
 *  roll back together ("no ledger row, no decision"). */
export type LedgerTx = Connection;

export type LedgerSubjectType =
  | "app_user"
  | "approval_limit"
  | "billing_hold"
  | "billing_run"
  | "carpark_group"
  | "comm_sequence"
  | "comm_template"
  | "correspondence"
  | "escalation"
  | "incentive"
  | "invoice"
  | "job"
  | "lease_event"
  | "misc_fee"
  | "occupancy"
  | "payment"
  | "purchase_order"
  | "quote"
  | "rate_step"
  | "rent_review"
  | "tenancy";

export type LedgerActor =
  /** A signed-in person; `role` is their AppUsers.Role when they decided. */
  | { kind: "user"; name: string; role: string; userId: number | null }
  /** A timer, webhook or other unattended process, named by its function. */
  | { kind: "system"; name: string };

export interface LedgerEntryInput {
  action: LedgerAction;
  actor: LedgerActor;
  /** Denormalised scope so history filters without joins (§3.12 indexes). */
  buildingId?: number | null;
  /** What the system computed when a person chose something else. */
  computed?: unknown;
  /** Shared by every row of one operation: a bulk override, a billing run, or a
   *  decision and the MYOB calls it triggers (LAUNCH-READINESS WP55). */
  correlationId?: string;
  /** JSON-serialisable snapshots of the fields the decision changed. */
  after?: unknown;
  before?: unknown;
  /** Annualised AUD; positive = money forgone or at risk. */
  financialImpact?: number | null;
  jobId?: number | null;
  /** Required when the action's registry entry says so; a plain sentence. */
  reason?: string | null;
  /** The rule that decided the outcome, e.g. "auto_in_bounds". */
  ruleApplied?: string | null;
  subject: { id: number | string; type: LedgerSubjectType };
  tenantId?: number | null;
}
