// What a billing run may bill a tenancy for one period (PLAN §3.13, WP26c,
// D24). WP29b's run builder calls this; until it exists the rule is pinned by
// tests (billing.test.ts) so it can't drift. Pure.
//
//   charged    the charges for [from, to): the lease figure in force each day,
//              with every ratified relief applied on the days it covers. A review
//              row still pending (its index unknown, or keyed ahead and not yet
//              applied once the workflow is live, M2) bills the rent before it;
//              the review's arrears are billed once, when it is applied
//   excluded   the changes awaiting a decision whose dates touch the period: a
//              relief request (in no figure until a director ratifies it) and a
//              review awaiting approval (not on the schedule until it is
//              approved). The run lists them beside the bill and bills none of them
//   lease      the same days at the lease's own figures, for the run's receipt
//
// Amounts are pro rata by day on a 365-day year, each slice to the cent
// (scheduleCharges.ts chargesOver); the run decides its own periods.

import { addDaysIso } from "../darwinDate";
import { type Charges, type ChargeSlice, chargesOver, computeCharges } from "../scheduleCharges";
import type { PendingChangeItem } from "./pending";
import type { TenancySchedule } from "./relief";

export interface BillableCharges {
  charged: Charges;
  /** Changes awaiting a decision that touch the period: never billed. */
  excluded: PendingChangeItem[];
  lease: Charges;
  slices: ChargeSlice[];
}

/** A pending item's dates touch [from, to): a relief by its days, a review by its date. */
function touches(item: PendingChangeItem, from: string, to: string): boolean {
  if (item.from === null) return false;
  const end = addDaysIso(item.to ?? item.from, 1);
  return item.from < to && end > from;
}

/** The bill for [from, to) (to exclusive) under the schedule as it stands. */
export function billableCharges(schedule: TenancySchedule, pending: readonly PendingChangeItem[], from: string, to: string): BillableCharges {
  // Only the ratified reliefs reach a figure; a pending one is never laid over the rows.
  const charges = computeCharges(schedule.rows, { ...schedule.input, pending: [], reliefs: schedule.ratified });
  const totals = chargesOver(charges, from, to);
  return { charged: totals.charged, excluded: pending.filter((item) => touches(item, from, to)), lease: totals.lease, slices: totals.slices };
}
