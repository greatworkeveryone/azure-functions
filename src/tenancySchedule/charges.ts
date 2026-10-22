// One lease's charge lines and future reviews for the Tenancy Schedule report. Pure.
//
// The figures come from the same engine path as the register's charged rent
// (rentReview/dto.ts toTenancySummary): computeScheduleRows, then cascade.ts
// ancillariesByRow, computeCharges and chargedOn(asOf). The rent and after-hours
// A/C lines are the lease's figures, each misc fee and car park group its own
// running figure on the row in force (cascade.ts miscFeeRunning / carparkRunning,
// the functions ancillariesByRow itself sums), and "Rent relief" is the
// difference to what is charged. The engine's output is read, never changed.

import { ancillariesByRow, carparkRunning, miscFeeRunning, PERIODS_PER_YEAR } from "../rentReview/cascade";
import { type Charges, chargedOn, computeCharges, type RentRelief } from "../scheduleCharges";
import {
  type CarparkScheduleGroup,
  computeScheduleRows,
  type MiscFee,
  type ScheduleRow,
  type ScheduleTerms,
  type ScheduledRateStep,
} from "../scheduledRateStepLogic";
import type {
  TenancyScheduleChargeKind,
  TenancyScheduleMoney,
  TenancyScheduleReview,
  TenancyScheduleReviewMethod,
} from "./types";

export const r2 = (n: number): number => Math.round(n * 100) / 100 || 0;

export const money = (annual: number, nlaSqm: number): TenancyScheduleMoney => ({
  annual: r2(annual),
  monthly: r2(annual / 12),
  perSqm: nlaSqm > 0 ? r2(annual / nlaSqm) : null,
});

export interface ChargeLine {
  annual: number;
  bays: number | null;
  effectiveFrom: string | null;
  kind: TenancyScheduleChargeKind;
  label: string;
}

export interface LeaseScheduleInput {
  commencement: string | null;
  fallbackAnnual: number;
  fees: readonly MiscFee[];
  groups: readonly CarparkScheduleGroup[];
  nlaSqm: number;
  reliefs: readonly RentRelief[];
  steps: ScheduledRateStep[];
  terms: ScheduleTerms;
}

export interface LeaseCharges {
  lines: ChargeLine[];
  /** The schedule's rows, for the reviews. */
  rows: ScheduleRow[];
}

const sum = (charges: Charges): number => r2((charges.rent ?? 0) + (charges.ahac ?? 0) + (charges.carparks ?? 0) + (charges.miscFees ?? 0));
const later = (a: string | null, b: string | null): string | null => (a === null ? b : b === null ? a : a > b ? a : b);

/** What the lease's schedule charges on `asOf`, line by line. */
export function leaseCharges(input: LeaseScheduleInput, asOf: string): LeaseCharges {
  const rows = computeScheduleRows(input.steps, input.fallbackAnnual, input.nlaSqm, input.terms);
  const schedule = computeCharges(rows, {
    ancillaries: ancillariesByRow(rows, input.groups, input.fees),
    fallbackAnnual: input.fallbackAnnual,
    reliefs: input.reliefs,
  });
  const period = chargedOn(schedule, asOf);
  if (!period) {
    // The schedule hasn't started (or its rent is unknown): nothing is charged yet.
    return { lines: [{ annual: 0, bays: null, effectiveFrom: rows[0]?.step.effectiveFrom ?? null, kind: "rent", label: "Rent" }], rows };
  }

  const index = period.stepId === null ? -1 : rows.findIndex((row) => row.step.id === period.stepId);
  const rowFrom = index >= 0 ? rows[index].step.effectiveFrom : input.commencement;
  const lines: ChargeLine[] = [{ annual: period.lease.rent ?? 0, bays: null, effectiveFrom: rowFrom, kind: "rent", label: "Rent" }];
  if ((period.lease.ahac ?? 0) > 0) {
    lines.push({ annual: period.lease.ahac ?? 0, bays: null, effectiveFrom: rowFrom, kind: "ahac", label: "After-hours A/C" });
  }

  // The base rent (index -1) carries no fees or car parks, as computeCharges has it.
  if (index >= 0) {
    const through = rows.slice(0, index + 1);
    for (const fee of input.fees) {
      if (fee.commencedAt > asOf || (fee.endsAt && asOf > fee.endsAt)) continue;
      const amount = miscFeeRunning(through, fee);
      if (amount === null) continue;
      const annual = r2(amount * (PERIODS_PER_YEAR[fee.frequency] ?? 1));
      if (annual > 0) lines.push({ annual, bays: null, effectiveFrom: later(rowFrom, fee.commencedAt), kind: "miscFee", label: fee.title.trim() || "Fee" });
    }
    for (const group of input.groups) {
      if (group.commencedAt > asOf) continue;
      const monthly = carparkRunning(through, group);
      if (monthly === null || !(monthly > 0)) continue;
      lines.push({
        annual: r2(r2(monthly) * 12),
        bays: group.carparkIds.length,
        effectiveFrom: later(rowFrom, group.commencedAt),
        kind: "carparkGroup",
        label: group.label.trim() || "Car parks",
      });
    }
  }

  const relieved = r2(sum(period.charged) - sum(period.lease));
  if (relieved !== 0) {
    const from = input.reliefs.filter((relief) => period.reliefIds.includes(relief.id)).map((relief) => relief.from).sort()[0] ?? null;
    lines.push({ annual: relieved, bays: null, effectiveFrom: from, kind: "relief", label: "Rent relief" });
  }
  return { lines, rows };
}

// ── Reviews ──────────────────────────────────────────────────────────────────

const REGION_LABEL: Record<string, string> = { AUS: "Australia", DARWIN: "Darwin" };

const percentText = (value: number): string => `${Number(value.toFixed(4))}%`;

function methodOf(row: ScheduleRow): TenancyScheduleReviewMethod {
  const kind = row.step.methodKind;
  return kind === "cpi" || kind === "fixed" || kind === "market" ? kind : "other";
}

function describe(row: ScheduleRow, method: TenancyScheduleReviewMethod, cpiRegion: string | null): string {
  if (method === "cpi") return cpiRegion && REGION_LABEL[cpiRegion] ? `CPI ${REGION_LABEL[cpiRegion]}` : "CPI";
  if (method === "fixed") return row.step.ratePercent ? `Fixed ${percentText(row.step.ratePercent)}` : "Fixed review";
  if (method === "market") return "Market review";
  return row.step.note?.trim() || "Other review";
}

export interface ReviewInput {
  asOf: string;
  cpiRegion: string | null;
  expiry: string | null;
  fees: readonly MiscFee[];
  groups: readonly CarparkScheduleGroup[];
  /** Dates of rent reviews awaiting a director. */
  pendingReviewDates: ReadonlySet<string>;
  rows: readonly ScheduleRow[];
}

/**
 * Running before the review and changed by it: fees and groups that follow the
 * rent move without a step of their own. A pending row (or one after it) has no
 * figures yet, so everything running before it is listed: each reviews on the
 * rent's date, by its own step or the rent's factor.
 */
const changesOn = <T>(running: (rows: readonly ScheduleRow[], item: T) => number | null, rows: readonly ScheduleRow[], index: number, item: T): boolean => {
  const before = running(rows.slice(0, index), item);
  if (before === null) return false;
  if (rows[index].pending) return true;
  const after = running(rows.slice(0, index + 1), item);
  return after !== null && r2(before) !== r2(after);
};

const ahacOf = (row: ScheduleRow | undefined): number => row?.ahacAnnual ?? 0;

/** The schedule rows after `asOf` and within the term: the date, how it reviews, and every charge whose figure changes on it. */
export function futureReviews(input: ReviewInput): TenancyScheduleReview[] {
  return input.rows
    .map((row, index) => ({ index, row }))
    .filter(({ row }) => row.step.methodKind !== "commencement" && row.step.effectiveFrom > input.asOf)
    .filter(({ row }) => input.expiry === null || row.step.effectiveFrom <= input.expiry)
    .map(({ index, row }): TenancyScheduleReview => {
      const date = row.step.effectiveFrom;
      const method = methodOf(row);
      const fees = input.fees.filter((fee) => (!fee.endsAt || date <= fee.endsAt) && changesOn(miscFeeRunning, input.rows, index, fee));
      const groups = input.groups.filter((group) => changesOn(carparkRunning, input.rows, index, group));
      const ahacBefore = input.rows.slice(0, index).reduce((last, prior) => (prior.pending ? last : ahacOf(prior)), 0);
      const ahacChanges = ahacBefore > 0 && (row.pending || r2(ahacOf(row)) !== r2(ahacBefore));
      return {
        appliesTo: ["Rent", ...fees.map((fee) => fee.title.trim() || "Fee"), ...groups.map((group) => group.label.trim() || "Car parks"), ...(ahacChanges ? ["After-hours A/C"] : [])],
        date,
        description: describe(row, method, input.cpiRegion),
        method,
        pending: input.pendingReviewDates.has(date),
      };
    });
}
