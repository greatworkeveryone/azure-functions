// Whether a tenancy's schedule can carry a rent relief, checked when it is asked
// for and again when a director ratifies it (the schedule may have moved in
// between). Pure: the endpoint loads the tenancy and its other requests.
//
//   outside_lease       422  it runs past the lease's last day (Expiry) or starts
//                            before its first (Commencement). A tenancy holding
//                            over past its expiry is refused too, for now: whether
//                            holdover can carry a relief is Connor's call
//   relief_overlap      409  it shares a day and a charge with a ratified relief
//                            or with another request awaiting a director
//   nothing_to_relieve  422  the schedule charges nothing on its first day (not
//                            started, or the review before it is still open), or
//                            the tenancy has no such charge (no AHAC, no car parks)
//   relief_too_large    422  an amount off is more than the rent on part of it
//   not_a_reduction     422  a fixed rent isn't below the rent on part of it
//
// Otherwise it reports what the relief forgoes over its own days
// (scheduleCharges.ts reliefForgone): the ledger records it, and the director
// sees it before ratifying.

import type { SqlRow } from "../db";
import { formatDisplayDate } from "../digest/format";
import { sqlDateToIso } from "../nextReviewDate";
import { ancillariesByRow } from "../rentReview/cascade";
import {
  type ChargeInput,
  type ChargeScope,
  chargedOn,
  computeCharges,
  parseReliefs,
  reliefEnd,
  type ReliefForgone,
  reliefForgone,
  reliefsOverlap,
  type RentRelief,
} from "../scheduleCharges";
import { computeScheduleRows, parseGroups, parseMiscFees, parseSteps, type ScheduleRow } from "../scheduledRateStepLogic";
import { scheduleTermsOf } from "../scheduleTerms";
import { type ReliefPayload, reliefDates, reliefTerms } from "./types";

export interface TenancySchedule {
  input: ChargeInput;
  /** Tenants.Commencement and Expiry (the lease's first and last days); null when not recorded. */
  lease: { commencement: string | null; expiry: string | null };
  /** The reliefs already ratified (Tenants.RentReliefs). */
  ratified: RentRelief[];
  rows: ScheduleRow[];
}

const decimal = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** The tenancy's schedule as a relief is checked against it: the rows, every charge on them, and the ratified reliefs. */
export function tenancySchedule(row: SqlRow, totalSqm: number): TenancySchedule {
  const fallbackAnnual = decimal(row.RentPerAnnum) ?? 0;
  const rows = computeScheduleRows(parseSteps(row.ScheduledRateSteps as string | null | undefined), fallbackAnnual, totalSqm, scheduleTermsOf(row));
  const ratified = parseReliefs(row.RentReliefs as string | null | undefined);
  return {
    input: {
      ancillaries: ancillariesByRow(rows, parseGroups(row.CarparkScheduleGroups as string | null | undefined), parseMiscFees(row.MiscFees as string | null | undefined)),
      fallbackAnnual,
      reliefs: ratified,
    },
    lease: { commencement: sqlDateToIso(row.Commencement), expiry: sqlDateToIso(row.Expiry) },
    ratified,
    rows,
  };
}

export type ReliefRefusalCode = "not_a_reduction" | "nothing_to_relieve" | "outside_lease" | "relief_overlap" | "relief_too_large";

export interface ReliefRefusal {
  code: ReliefRefusalCode;
  details?: Record<string, unknown>;
  message: string;
}

export type ReliefCheck = { forgone: ReliefForgone; ok: true } | { ok: false; refusal: ReliefRefusal };

const SCOPE_WORDS: Record<ChargeScope, string> = { ahac: "after-hours air-conditioning", carparks: "car parks", misc_fees: "misc fees", rent: "rent" };
const KEY: Record<ChargeScope, "ahac" | "carparks" | "miscFees" | "rent"> = { ahac: "ahac", carparks: "carparks", misc_fees: "miscFees", rent: "rent" };
const money = (value: number): string => new Intl.NumberFormat("en-AU", { currency: "AUD", style: "currency" }).format(value);

const refuse = (code: ReliefRefusalCode, message: string, details?: Record<string, unknown>): ReliefCheck => ({
  ok: false,
  refusal: { code, message, ...(details ? { details } : {}) },
});

export interface OtherRequest {
  relief: ReliefPayload;
  requestId: string;
}

/** The checks in the header, for `relief` (with the id it has or will have) on `schedule`. */
export function checkRelief(relief: ReliefPayload & { id: string }, schedule: TenancySchedule, pending: readonly OtherRequest[]): ReliefCheck {
  const { commencement, expiry } = schedule.lease;
  if (expiry !== null && relief.to > expiry) {
    return refuse("outside_lease", `This relief runs to ${formatDisplayDate(relief.to)}, after the lease ends on ${formatDisplayDate(expiry)}. A relief has to end by the lease's last day.`, {
      leaseExpiry: expiry,
    });
  }
  if (commencement !== null && relief.from < commencement) {
    return refuse("outside_lease", `This relief starts on ${formatDisplayDate(relief.from)}, before the lease starts on ${formatDisplayDate(commencement)}. A relief has to start on or after the lease's first day.`, {
      leaseCommencement: commencement,
    });
  }
  const ratified = schedule.ratified.find((other) => other.id !== relief.id && reliefsOverlap(relief, other));
  if (ratified) {
    return refuse("relief_overlap", `This overlaps the rent relief already approved for ${reliefDates(ratified)} (${reliefTerms(ratified)}). Choose dates or charges that don't overlap it.`, {
      overlaps: { from: ratified.from, requestId: ratified.id, state: "ratified", to: ratified.to },
    });
  }
  const waiting = pending.find((other) => other.requestId !== relief.id && reliefsOverlap(relief, other.relief));
  if (waiting) {
    return refuse("relief_overlap", `This overlaps the rent relief for ${reliefDates(waiting.relief)} that is waiting for a director (${reliefTerms(waiting.relief)}). Wait for that decision, or choose dates or charges that don't overlap it.`, {
      overlaps: { from: waiting.relief.from, requestId: waiting.requestId, state: "pending", to: waiting.relief.to },
    });
  }

  const charges = computeCharges(schedule.rows, { ...schedule.input, pending: [], reliefs: schedule.ratified.filter((other) => other.id !== relief.id) });
  const first = chargedOn(charges, relief.from);
  if (!first) {
    return refuse("nothing_to_relieve", `The schedule charges no rent on ${formatDisplayDate(relief.from)}: it hasn't started, or the review before it isn't settled. A relief can start once there is a rent to relieve.`);
  }
  for (const scope of relief.scope) {
    const amount = first.lease[KEY[scope]];
    if (amount === null || !(amount > 0)) {
      return refuse("nothing_to_relieve", `This tenancy has no ${SCOPE_WORDS[scope]} charged on the relief's first day, so there is nothing of it to relieve.`, { scope });
    }
  }

  if (relief.kind !== "percent") {
    const end = reliefEnd(relief);
    const inside = charges.periods.filter((period) => (period.to === null || period.to > relief.from) && (period.from === null || period.from < end));
    const lowest = inside
      .filter((period) => period.lease.rent !== null)
      .reduce<{ from: string; rent: number } | null>((low, period) => {
        const rent = period.lease.rent as number;
        const from = period.from === null || period.from < relief.from ? relief.from : period.from;
        return low === null || rent < low.rent ? { from, rent } : low;
      }, null);
    if (lowest && relief.kind === "amount" && relief.value > lowest.rent) {
      return refuse("relief_too_large", `${money(relief.value)} a year off is more than the rent from ${formatDisplayDate(lowest.from)} (${money(lowest.rent)} a year). Make it at most that, or relieve a percentage.`, {
        rentFrom: lowest.from,
        rentPerAnnum: lowest.rent,
      });
    }
    if (lowest && relief.kind === "fixed_rent" && relief.value >= lowest.rent) {
      return refuse("not_a_reduction", `A fixed rent of ${money(relief.value)} a year isn't below the lease's rent from ${formatDisplayDate(lowest.from)} (${money(lowest.rent)} a year), so it relieves nothing.`, {
        rentFrom: lowest.from,
        rentPerAnnum: lowest.rent,
      });
    }
  }

  return { forgone: reliefForgone(schedule.rows, { ...schedule.input, reliefs: schedule.ratified.filter((other) => other.id !== relief.id) }, relief), ok: true };
}
