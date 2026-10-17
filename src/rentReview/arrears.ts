// What a rent review owes for the time already passed since its date (PLAN
// §3.1 APPLY: "arrears from scheduledFor to today as an unbilled arrears line"),
// for every charge it changes. Pure.

import { daysBetweenIso } from "../darwinDate";
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
  to: string;
}

export interface ArrearsChange {
  /** Annual amounts before and after the review, as the receipt shows them. */
  after: number;
  before: number;
  kind: ArrearsPart["kind"];
  label: string;
}

/**
 * What the review owes for the time already passed since the review date, for
 * every charge it changes (Connor, 17 Oct: rent, car parks, misc fees and AHAC,
 * each at the change the schedule makes): from the review date to `to`
 * (exclusive, as a schedule row ends), pro rata by day on a 365-day year;
 * months is the same span in months. Each line is to the cent and the amount is
 * their sum. Null when the date hasn't passed or nothing changes. A decrease
 * gives a credit (negative).
 */
export function arrearsFor(from: string, to: string, changes: readonly ArrearsChange[]): ArrearsLine | null {
  const days = daysBetweenIso(from, to);
  if (days <= 0) return null;
  const lines: ArrearsPart[] = [];
  for (const change of changes) {
    const difference = r2(change.after - change.before);
    if (difference !== 0) lines.push({ amount: r2((difference * days) / 365), kind: change.kind, label: change.label });
  }
  if (lines.length === 0) return null;
  return { amount: r2(lines.reduce((sum, line) => sum + line.amount, 0)), from, lines, months: r2((days * 12) / 365), to };
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
