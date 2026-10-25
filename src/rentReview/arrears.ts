// What a rent review owes for the time already passed since its date (PLAN
// §3.1 APPLY: "arrears from scheduledFor to today as an unbilled arrears line"),
// for every charge it changes. Pure.

import { daysBetweenIso } from "../darwinDate";
import { type ChargeScope, relieve, reliefEnd, type RentRelief } from "../scheduleCharges";
import type { CascadeRow } from "./cascade";

const r2 = (n: number): number => Math.round(n * 100) / 100;

/** One charge's part of the arrears: the rent, AHAC, a car park group, a misc fee. */
export interface ArrearsPart {
  amount: number;
  kind: "ahac" | "carpark" | "misc_fee" | "rent";
  label: string;
}

export interface ArrearsLine {
  /** The whole of it: the sum of `lines`. */
  amount: number;
  from: string;
  /** Every charge the review changes, each at the change the schedule makes (A4). */
  lines: ArrearsPart[];
  months: number;
  /** The ratified reliefs that lowered it (WP26c); absent when none did. */
  reliefIds?: string[];
  to: string;
}

export interface ArrearsChange {
  /** Annual amounts before and after the review, as the receipt shows them. */
  after: number;
  before: number;
  kind: ArrearsPart["kind"];
  label: string;
}

const SCOPE_OF: Record<ArrearsPart["kind"], ChargeScope> = { ahac: "ahac", carpark: "carparks", misc_fee: "misc_fees", rent: "rent" };

/** One charge's part over [from, to): the change pro rata by day, on each
 *  stretch the relief covering that charge (if any) left of it. Null when no
 *  relief covers the charge in the window (the plain sum applies). */
function relievedPart(change: ArrearsChange, from: string, to: string, reliefs: readonly RentRelief[], used: Set<string>): number | null {
  const scope = SCOPE_OF[change.kind];
  const covering = reliefs
    .filter((relief) => relief.scope.includes(scope) && relief.from < to && reliefEnd(relief) > from)
    .sort((a, b) => a.from.localeCompare(b.from) || a.id.localeCompare(b.id));
  if (covering.length === 0) return null;
  const cuts = [...new Set(covering.flatMap((relief) => [relief.from, reliefEnd(relief)]))].filter((cut) => cut > from && cut < to).sort();
  const bounds = [from, ...cuts, to];
  let amount = 0;
  for (let k = 0; k < bounds.length - 1; k++) {
    const start = bounds[k];
    const relief = covering.find((candidate) => candidate.from <= start && start < reliefEnd(candidate));
    const before = relief ? (relieve(change.before, relief, scope) as number) : change.before;
    const after = relief ? (relieve(change.after, relief, scope) as number) : change.after;
    if (relief && relieve(change.after, relief, scope) !== change.after) used.add(relief.id);
    amount = r2(amount + r2((r2(after - before) * daysBetweenIso(start, bounds[k + 1])) / 365));
  }
  return amount;
}

/**
 * What the review owes for the time already passed since the review date, for
 * every charge it changes (Connor, 17 Oct: rent, car parks, misc fees and AHAC,
 * each at the change the schedule makes): from the review date to `to`
 * (exclusive, as a schedule row ends), pro rata by day on a 365-day year;
 * months is the same span in months. Each line is to the cent and the amount is
 * their sum. Null when the date hasn't passed or nothing changes. A decrease
 * gives a credit (negative).
 *
 * A ratified relief (WP26c) applies on top of whatever the lease figure is, so
 * on the days it covers a charge the line is the relieved difference: half of
 * it under 50% off, none under a fixed rent. Without one this is the plain sum.
 */
export function arrearsFor(from: string, to: string, changes: readonly ArrearsChange[], reliefs: readonly RentRelief[] = []): ArrearsLine | null {
  const days = daysBetweenIso(from, to);
  if (days <= 0) return null;
  const lines: ArrearsPart[] = [];
  const used = new Set<string>();
  for (const change of changes) {
    const difference = r2(change.after - change.before);
    if (difference === 0) continue;
    const relieved = relievedPart(change, from, to, reliefs, used);
    if (relieved === null) lines.push({ amount: r2((difference * days) / 365), kind: change.kind, label: change.label });
    // A relief that leaves nothing of the change (a fixed rent) leaves no line.
    else if (relieved !== 0) lines.push({ amount: relieved, kind: change.kind, label: change.label });
  }
  if (lines.length === 0) return null;
  return {
    amount: r2(lines.reduce((sum, line) => sum + line.amount, 0)),
    from,
    lines,
    months: r2((days * 12) / 365),
    ...(used.size > 0 ? { reliefIds: [...used].sort() } : {}),
    to,
  };
}

/** The rent's arrears alone, for a review whose charges aren't on record. */
export function computeArrears(from: string, to: string, currentAnnual: number, newAnnual: number): ArrearsLine | null {
  return arrearsFor(from, to, [{ after: newAnnual, before: currentAnnual, kind: "rent", label: "Rent" }]);
}

/** The rent and every cascade row as arrears changes. */
export function reviewChanges(currentAnnual: number, newAnnual: number, cascade: readonly CascadeRow[]): ArrearsChange[] {
  return [
    { after: newAnnual, before: currentAnnual, kind: "rent", label: "Rent" },
    ...cascade.map((row) => ({ after: row.newAnnual, before: row.currentAnnual, kind: row.kind, label: row.label })),
  ];
}
