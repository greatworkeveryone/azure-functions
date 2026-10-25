import { computeScheduleRows, type ScheduledRateStep, type ScheduleTerms } from "./scheduledRateStepLogic";

/** Compare the edited row with the rent the previous schedule charged on that day. */
export function manualRentReduction(before: ScheduledRateStep[], after: ScheduledRateStep[], id: string, fallback: number, terms: ScheduleTerms): { before: number; after: number } | null {
  const next = computeScheduleRows(after, fallback, 0, terms).find(row => row.step.id === id);
  if (!next || next.pending) return null;
  const prior = computeScheduleRows(before, fallback, 0, terms).filter(row => row.step.effectiveFrom <= next.step.effectiveFrom).at(-1);
  if (prior?.pending) return null;
  const previous = prior?.annual ?? fallback;
  return Math.round(next.annual * 100) < Math.round(previous * 100) ? { before: previous, after: next.annual } : null;
}
