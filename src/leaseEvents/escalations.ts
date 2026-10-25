// The lease event escalations (PLAN §3.5, §3.6, §3.7), through WP20's engine
// with the policies migration 098 seeded:
//
//   lease.option_deadline  attention: the option window is open, no notice has
//                          been recorded and the deadline is OPTION_DEADLINE_WARNING_DAYS
//                          away or less (accounts manager, then the directors)
//   lease.option_lapsed    attention: the deadline passed with no notice (directors)
//   lease.renewal          authority: a renewal event is open; it ends with the
//                          directors' outcome (renewed, vacating, holdover)
//
// The engine never decides for the event: an attention escalation ends when its
// condition clears (the sweep asks the lease_event adapter) or when the event's
// own decision concludes it; the renewal ends only through the outcome. A
// failure here never undoes the decision that asked for it: it is logged, and
// the generator or the sweep catches up.

import type { Connection } from "tedious";
import { concludeForSubject, raise } from "../escalation";
import type { LedgerActor } from "../ledger";

import { type LeasePolicyKey } from "./policies";

export { LEASE_POLICIES, OPTION_DEADLINE_WARNING_DAYS, type LeasePolicyKey } from "./policies";

export interface LeaseEscalationTarget {
  buildingId: number | null;
  leaseEventId: string;
  tenantId: number;
}

const HEADLINES: Record<LeasePolicyKey, string> = {
  "lease.option_deadline": "Option notice deadline coming up, no notice recorded",
  "lease.option_lapsed": "Option deadline passed with no notice",
  "lease.renewal": "Lease expiring: decide renew, vacate or hold over",
};

/** Raises one; true when a new escalation was written (an existing live one is left as it is). */
export async function raiseLeaseEscalation(
  connection: Connection,
  input: { actor: LedgerActor; log: (message: string) => void; policyKey: LeasePolicyKey; target: LeaseEscalationTarget },
): Promise<boolean> {
  try {
    const result = await raise(connection, {
      actor: input.actor,
      buildingId: input.target.buildingId,
      context: { leaseEventId: input.target.leaseEventId, tenantId: input.target.tenantId },
      headline: HEADLINES[input.policyKey],
      policyKey: input.policyKey,
      subjectId: input.target.leaseEventId,
      subjectType: "lease_event",
    });
    return result.created;
  } catch (error) {
    input.log(`lease events: could not raise ${input.policyKey} on ${input.target.leaseEventId}: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

/** Ends the event's live escalations with its decision, after the decision committed. Never throws. */
export async function concludeLeaseEscalations(
  connection: Connection,
  input: { actor: LedgerActor; code: string; leaseEventId: string; log: (message: string) => void; note?: string | null; policyKeys?: readonly LeasePolicyKey[] },
): Promise<number> {
  try {
    const ended = await concludeForSubject(connection, {
      actor: input.actor,
      code: input.code,
      note: input.note ?? null,
      policyKeys: input.policyKeys,
      subjectId: input.leaseEventId,
      subjectType: "lease_event",
    });
    return ended.length;
  } catch (error) {
    input.log(`lease events: could not end the escalations on ${input.leaseEventId}: ${error instanceof Error ? error.message : String(error)}`);
    return 0;
  }
}
