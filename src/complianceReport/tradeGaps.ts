// The Compliance report's second section: trades a building has been set to require
// that have no active contractor. Only trades a manager marked required count; a
// building with no plan, or a trade not marked required, is never flagged. A trade's
// contractors are those named for it in the coverage plan and those on the building's
// live service schedules in that trade, the same union the Maintenance page shows.
// Active and not suspended is what makes a contractor count. Pure.

import { compareTrades, tradeKey, tradeLabel } from "../maintenanceSpend/trades";
import { compareContractors, toContractor } from "./contractors";
import type { CoverageTrade } from "../maintenanceCoverage";
import type { ScheduleApi } from "../serviceSchedules";
import type { ComplianceContractor, TradeGapFinding } from "./types";
import type { SqlRow } from "../db";

interface TradeGapInput {
  /** Every contractor row read, by id. */
  contractorRows: ReadonlyMap<number, SqlRow>;
  plan: readonly CoverageTrade[];
  /** The building's live service schedules. */
  schedules: readonly ScheduleApi[];
}

export function tradeGapFindings({ contractorRows, plan, schedules }: TradeGapInput): TradeGapFinding[] {
  const required = new Map<string, { ids: Set<number>; label: string }>();
  for (const entry of plan) {
    if (!entry.required) continue;
    const key = tradeKey(tradeLabel(entry.trade));
    const found = required.get(key) ?? { ids: new Set<number>(), label: tradeLabel(entry.trade) };
    entry.contractorIds.forEach((id) => found.ids.add(id));
    required.set(key, found);
  }

  const gaps: TradeGapFinding[] = [];
  for (const [key, { ids, label }] of required) {
    const named = new Set(ids);
    for (const schedule of schedules) {
      if (schedule.contractorId !== null && tradeKey(tradeLabel(schedule.category)) === key) named.add(schedule.contractorId);
    }
    const people: ComplianceContractor[] = [...named].map((id) => toContractor(id, contractorRows.get(id))).sort(compareContractors);
    if (people.some((person) => person.standing === "active")) continue;
    gaps.push({ named: people, reason: people.length === 0 ? "none_named" : "none_active", trade: label });
  }
  return gaps.sort((a, b) => compareTrades(a.trade, b.trade));
}
