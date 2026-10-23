// A building's coverage plan as stored (dbo.MaintenanceCoverage.PlanJson, migration
// 155): the trades its managers named, whether each is required, and who is named for
// it. Written by saveMaintenanceCoverage, which validates the shape; read here
// leniently, so one odd row can't take the whole report down.
//
// A trade is required only when a manager set it so. An absent plan, or a trade not
// marked required, means nothing is expected: Floorplan never assumes a required trade.

import type { CoverageTrade } from "../maintenanceCoverage";

const isPositiveId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/** The plan's trades, in stored order. Anything that isn't a plan reads as no trades. */
export function readPlanTrades(planJson: unknown): CoverageTrade[] {
  let plan: unknown = planJson;
  if (typeof plan === "string") {
    try {
      plan = JSON.parse(plan);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(plan)) return [];
  return plan.flatMap((entry): CoverageTrade[] => {
    if (!entry || typeof entry !== "object") return [];
    const { contractorIds, required, trade } = entry as Record<string, unknown>;
    if (typeof trade !== "string" || trade.trim() === "") return [];
    return [
      {
        contractorIds: Array.isArray(contractorIds) ? [...new Set(contractorIds.filter(isPositiveId))] : [],
        required: required === true,
        trade: trade.trim(),
      },
    ];
  });
}
