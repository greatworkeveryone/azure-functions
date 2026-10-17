// Pending schedule changes (PLAN WP26c, D24): what a request is, how it reads,
// and the words for it. Pure.
//
// Staff ask for a change to a tenancy's rent schedule; it reaches the schedule
// only when a director ratifies it, and until then it is pending: on the
// schedule and in the warnings of every read of rent, never in a figure.
//
//   kind    relief            rent relief for a defined period, an overlay on the
//                             schedule (scheduleCharges.ts). The one kind asked
//                             for today.
//           ratchet_override  reserved. A director overrides the lease's ratchet
//                             for one review row while approving the review
//                             (rentReview/directorOverride.ts, C9), so no request
//                             is needed for it.
//           manual_change     reserved, not asked for: a manual edit corrects the
//                             record to the lease, and D7 already guards it (it
//                             clears the sign-off with a ledgered reason, and the
//                             schedule is unverified until someone signs it off
//                             again). A change of rent is a decision, made by a
//                             review (a reduction goes to the directors, A3) or a
//                             relief request.
//   state   pending -> ratified | rejected (a director, never admin), or withdrawn
//           (the person who asked)

import { formatDisplayDate } from "../digest/format";
import type { RentRelief } from "../scheduleCharges";

export const SCHEDULE_CHANGE_KINDS = ["relief", "ratchet_override", "manual_change"] as const;
export type ScheduleChangeKind = (typeof SCHEDULE_CHANGE_KINDS)[number];

/** The kinds requestScheduleChange takes. */
export const REQUESTABLE_KINDS: readonly ScheduleChangeKind[] = ["relief"];

export const SCHEDULE_CHANGE_STATES = ["pending", "ratified", "rejected", "withdrawn"] as const;
export type ScheduleChangeState = (typeof SCHEDULE_CHANGE_STATES)[number];

/** The ledger's and the escalation engine's subject type. */
export const SCHEDULE_CHANGE_SUBJECT = "schedule_change";

/** Raised when a change is asked for (migration 099): authority, the directors. */
export const RATIFICATION_POLICY = "schedule.change_ratification";

/** What ended the ratification escalation, stored as its ResolutionCode. */
export const CHANGE_DECISION_CODES = { ratified: "ratified", rejected: "rejected", withdrawn: "withdrawn" } as const;

export type ReliefPayload = Omit<RentRelief, "id" | "ratifiedAt" | "ratifiedByName" | "reason">;

const SCOPE_WORDS: Record<string, string> = { ahac: "AHAC", carparks: "car parks", misc_fees: "misc fees", rent: "rent" };

const money = (value: number): string => new Intl.NumberFormat("en-AU", { currency: "AUD", style: "currency" }).format(value);

function list(words: string[]): string {
  if (words.length <= 1) return words.join("");
  return `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`;
}

/** "01/03/2026 to 31/08/2026". */
export const reliefDates = (relief: Pick<ReliefPayload, "from" | "to">): string =>
  `${formatDisplayDate(relief.from)} to ${formatDisplayDate(relief.to)}`;

/** What the relief does, in words: "50% off the rent and AHAC". */
export function reliefTerms(relief: Pick<ReliefPayload, "kind" | "scope" | "value">): string {
  if (relief.kind === "amount") return `${money(relief.value)} a year off the rent`;
  if (relief.kind === "fixed_rent") return `the rent fixed at ${money(relief.value)} a year`;
  const percent = Number.isInteger(relief.value) ? String(relief.value) : relief.value.toFixed(2).replace(/0+$/, "");
  return relief.value === 100
    ? `no ${list(relief.scope.map((scope) => SCOPE_WORDS[scope] ?? scope))} (100% off)`
    : `${percent}% off the ${list(relief.scope.map((scope) => SCOPE_WORDS[scope] ?? scope))}`;
}

/**
 * One line for a relief. With figures for the readers who may see the rent
 * (tenancy viewers); `datesOnly` for the reads that never carry rent (the Next
 * 90 days feed, the portfolio figures facilities read).
 */
export function reliefSummary(relief: ReliefPayload, options: { datesOnly?: boolean } = {}): string {
  return options.datesOnly ? `Rent relief, ${reliefDates(relief)}` : `Rent relief: ${reliefTerms(relief)}, ${reliefDates(relief)}`;
}
