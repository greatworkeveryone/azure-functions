// What a rent review does to the charges that follow the rent (PLAN §3.2, WP23b):
// car park groups, misc fees and after-hours air-conditioning. Pure.
//
// KEEP IN SYNC: the car park and misc fee rules are ports of the frontend's
// command-centre src/helpers/carparkSchedule.ts (carparkMonthlyForRow) and
// src/helpers/miscFeeSchedule.ts (miscFeeScheduleRows), which draw the
// schedule people read. A change to either side changes both.
//
// Each group or fee is walked through the schedule rows before the review the
// way the frontend walks it (the running amount kept unrounded, car park
// overrides rounded where the frontend rounds them), then the review row's rule
// is applied once:
//   an override dated in the review's period    its own rule: a new amount, its
//                                               own CPI index pair, or its own %
//   no override                                 the rent's increase, after the
//                                               lease's cap, floor and ratchet
// Decided per row (the WP23 review's follow-up): a row with its own CPI
// override keeps its own index ratio and is NOT limited by the lease's cap or
// floor, because that is how the schedule computes it; the row's note says so,
// and says when the override goes past the cap or the floor. A group or fee
// that only starts in the review's period is a new charge, not a review, and is
// left out. A row that only follows the rent has no note.

import type {
  CarparkRateStep,
  CarparkScheduleGroup,
  MiscFee,
  MiscFeeFrequency,
  MiscFeeRateStep,
  ScheduleRow,
} from "../scheduledRateStepLogic";

export interface CascadeRow {
  appliedPercent: number | null;
  currentAnnual: number;
  kind: "ahac" | "carpark" | "misc_fee";
  label: string;
  newAnnual: number;
  note: string | null;
}

const r2 = (n: number): number => Math.round(n * 100) / 100;
const r4 = (n: number): number => Math.round(n * 10000) / 10000;

const PERIODS_PER_YEAR: Record<MiscFeeFrequency, number> = { annual: 1, monthly: 12, quarterly: 4 };

/** The override dated inside a row's period (effectiveTo is exclusive), latest first, as the frontend picks it. */
function overrideFor<T extends { effectiveFrom: string }>(row: ScheduleRow, overrides: readonly T[] | undefined): T | undefined {
  const { step } = row;
  return (overrides ?? [])
    .filter((o) => o.effectiveFrom >= step.effectiveFrom && (step.effectiveTo == null || o.effectiveFrom < step.effectiveTo))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
}

function activeInPeriod(row: ScheduleRow, startsOn: string): boolean {
  const { step } = row;
  return startsOn <= step.effectiveFrom || (step.effectiveTo != null && startsOn < step.effectiveTo);
}

// ── Car parks (port of carparkMonthlyForRow) ─────────────────────────────────

/** A group's running monthly rate after `rows`, or null when it hasn't started in them. */
export function carparkRunning(rows: readonly ScheduleRow[], group: CarparkScheduleGroup): number | null {
  let running: number | null = null;
  for (const row of rows) {
    const isRate = row.step.methodKind !== "commencement";
    const factor = row.factor ?? 1;
    if (running === null) {
      if (activeInPeriod(row, group.commencedAt)) running = group.baseMonthlyRate;
      continue;
    }
    const rateStep = overrideFor(row, group.rateSteps);
    const baseline = rateStep?.cpiValuePrev ?? row.cpiBaseline;
    if (rateStep) {
      if (rateStep.newMonthlyRate != null) running = rateStep.newMonthlyRate;
      else if (rateStep.methodKind === "cpi" && rateStep.cpiValue != null && baseline != null) running = r2(running * (rateStep.cpiValue / baseline));
      else if (rateStep.ratePercent != null) running = r2(running * (1 + rateStep.ratePercent / 100));
      else if (isRate) running *= factor;
    } else if (isRate) {
      running *= factor;
    }
  }
  return running;
}

// ── Misc fees (port of miscFeeScheduleRows) ──────────────────────────────────

/** A fee's running amount (in its own frequency) after `rows`; null when it
 *  hasn't started in them, or has ended (endsAt) by the last of them. */
export function miscFeeRunning(rows: readonly ScheduleRow[], fee: MiscFee): number | null {
  let running: number | null = null;
  for (const row of rows) {
    const { step } = row;
    if (running === null && !activeInPeriod(row, fee.commencedAt)) continue;
    if (fee.endsAt && step.effectiveFrom > fee.endsAt) return null;
    if (running === null) {
      running = fee.baseAmount;
      continue;
    }
    if (row.pending) continue;
    const rateStep = overrideFor(row, fee.rateSteps);
    const baseline = rateStep?.cpiValuePrev ?? row.cpiBaseline;
    if (rateStep) {
      if (rateStep.newAmount != null) running = rateStep.newAmount;
      else if (rateStep.methodKind === "cpi" && rateStep.cpiValue != null && baseline != null) running *= rateStep.cpiValue / baseline;
      else if (rateStep.ratePercent != null) running *= 1 + rateStep.ratePercent / 100;
    } else if (step.methodKind !== "commencement" && row.factor !== null) {
      running *= row.factor;
    }
  }
  return running;
}

// ── The review row ───────────────────────────────────────────────────────────

/** The lease's bounds as the review applies them, for the notes. */
export interface CascadeBounds {
  capPercent: number | null;
  floorPercent: number | null;
}

export interface CascadeInput {
  ahac: { after: number | null; before: number | null };
  bounds: CascadeBounds | null;
  carparkGroups: readonly CarparkScheduleGroup[];
  /** The rent's factor after the cap, floor and ratchet: what a following row takes. */
  factor: number;
  miscFees: readonly MiscFee[];
  /** The review row (its period decides which override applies). */
  reviewRow: ScheduleRow;
  /** The CPI baseline on the review row as written: the previous index for a CPI review. */
  reviewBaseline: number | null;
  /** Every row before the review row, in date order. */
  rowsBefore: readonly ScheduleRow[];
}

const pct = (value: number): string => `${r2(value).toFixed(2)}%`;
const money = (value: number): string =>
  new Intl.NumberFormat("en-AU", { currency: "AUD", style: "currency" }).format(value);

function boundsNote(percent: number, bounds: CascadeBounds | null): string {
  if (bounds?.capPercent != null && percent > bounds.capPercent) return ` — above the lease's ${pct(bounds.capPercent)} cap`;
  if (bounds?.floorPercent != null && percent < bounds.floorPercent) return ` — below the lease's ${pct(bounds.floorPercent)} floor`;
  return "";
}

interface Outcome {
  after: number;
  note: string | null;
}

/**
 * The review row's rule applied to a running amount, with what to say about it.
 * Car parks round an override's result and, when their override for the date
 * sets nothing usable, still follow the rent; misc fees keep the unrounded
 * amount and stay as they are. Both as the frontend does it.
 */
function reviewOutcome(
  before: number,
  rateStep: CarparkRateStep | MiscFeeRateStep | undefined,
  newAmount: number | undefined,
  input: CascadeInput,
  kind: "carpark" | "misc_fee",
  unit: string,
): Outcome {
  const round = (n: number) => (kind === "carpark" ? r2(n) : n);
  if (!rateStep) return { after: before * input.factor, note: null };
  if (newAmount != null) {
    return { after: newAmount, note: `Set to ${money(newAmount)} ${unit} by its own amount for this date; the rent's increase doesn't apply` };
  }
  const baseline = rateStep.cpiValuePrev ?? input.reviewBaseline;
  if (rateStep.methodKind === "cpi" && rateStep.cpiValue != null && baseline != null) {
    const ratio = rateStep.cpiValue / baseline;
    const percent = (ratio - 1) * 100;
    return {
      after: round(before * ratio),
      note:
        `Own CPI override (${rateStep.cpiValue} ÷ ${baseline} = ${pct(percent)}): not limited by the lease's cap or floor` +
        boundsNote(percent, input.bounds),
    };
  }
  if (rateStep.ratePercent != null) {
    return {
      after: round(before * (1 + rateStep.ratePercent / 100)),
      note: `Own rate of ${pct(rateStep.ratePercent)} for this date: not limited by the lease's cap or floor` + boundsNote(rateStep.ratePercent, input.bounds),
    };
  }
  if (kind === "carpark") return { after: before * input.factor, note: null };
  return { after: before, note: "Its entry for this date sets no amount or rate, so it stays as it is" };
}

/** One cascade row. The % compares the running amounts, so rounding a monthly
 *  rate to the cent doesn't show a capped 5% as 4.9987%. */
function cascadeRow(
  kind: CascadeRow["kind"],
  label: string,
  amounts: { after: number; afterAnnual: number; before: number; beforeAnnual: number },
  note: string | null,
): CascadeRow {
  return {
    appliedPercent: amounts.before > 0 ? r4((amounts.after / amounts.before - 1) * 100) || 0 : null,
    currentAnnual: r2(amounts.beforeAnnual),
    kind,
    label,
    newAnnual: r2(amounts.afterAnnual),
    note,
  };
}

/** The cascade rows for the review: AHAC first, then car park groups, then misc fees. */
export function computeCascade(input: CascadeInput): CascadeRow[] {
  const rows: CascadeRow[] = [];
  if (input.ahac.before !== null && input.ahac.before > 0) {
    const before = input.ahac.before;
    const after = input.ahac.after ?? before * input.factor;
    rows.push(cascadeRow("ahac", "After-hours air-conditioning", { after, afterAnnual: after, before, beforeAnnual: before }, null));
  }

  // Car parks show a rounded monthly rate (annual = 12 of them); misc fees an
  // annual worked from the unrounded amount. Both as the frontend shows them.
  for (const group of input.carparkGroups) {
    const before = carparkRunning(input.rowsBefore, group);
    if (before === null) continue;
    const rateStep = overrideFor(input.reviewRow, group.rateSteps);
    const { after, note } = reviewOutcome(before, rateStep, rateStep?.newMonthlyRate, input, "carpark", "a month");
    rows.push(cascadeRow("carpark", group.label, { after, afterAnnual: r2(after) * 12, before, beforeAnnual: r2(before) * 12 }, note));
  }

  for (const fee of input.miscFees) {
    if (fee.endsAt && input.reviewRow.step.effectiveFrom > fee.endsAt) continue;
    const before = miscFeeRunning(input.rowsBefore, fee);
    if (before === null) continue;
    const rateStep = overrideFor(input.reviewRow, fee.rateSteps);
    const perYear = PERIODS_PER_YEAR[fee.frequency] ?? 1;
    const unit = fee.frequency === "monthly" ? "a month" : fee.frequency === "quarterly" ? "a quarter" : "a year";
    const { after, note } = reviewOutcome(before, rateStep, rateStep?.newAmount, input, "misc_fee", unit);
    rows.push(cascadeRow("misc_fee", fee.title, { after, afterAnnual: after * perYear, before, beforeAnnual: before * perYear }, note));
  }
  return rows;
}
