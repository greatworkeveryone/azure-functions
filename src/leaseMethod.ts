// Reads the free-text review method staff type into the register ("Dec CPI",
// "Fixed 3%", "Market Review") as one of the schedule's method kinds.
//
// A faithful port of mapMethodKind in command-centre src/helpers/scheduleImport.ts,
// which the schedule import and the edit modal use. Keep the two in step: the
// frontend's cases are copied into src/__tests__/leaseMethod.test.ts. Pure.

import type { RentScheduleMethodKind } from "./scheduledRateStepLogic";

export function mapMethodKind(raw: string): RentScheduleMethodKind | null {
  const normalised = raw.trim().toLowerCase();
  if (!normalised) return null;
  if (normalised.includes("commencement")) return "commencement";
  if (normalised.includes("cpi")) return "cpi";
  if (normalised.includes("market")) return "market";
  if (normalised.includes("fixed") || normalised.endsWith("%")) return "fixed"; // bare percentage like "3%"
  return null;
}
