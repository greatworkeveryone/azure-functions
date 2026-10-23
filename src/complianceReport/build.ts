// The Compliance report, built from what load.ts read. Pure: the rules the screen
// explains are in the section files and here, and nowhere else.
//
//  - Only the commercial buildings load.ts returned are reported (company reporting
//    covers commercial buildings only, tenancy schedule decision T10), so a row for any
//    other building is dropped here even if a read were ever loosened.
//  - A contractor is on a building when they are on one of its live service schedules
//    (active, not archived) or named in its coverage plan, whatever the trade and
//    whether or not the trade is required. Each is checked for that building only.
//  - Overdue and in-force are decided by the Maintenance page's own rules, for the
//    report's date (see overdue.ts and defects.ts).
//  - The report only describes. Nothing here blocks an assignment, and no required
//    trade or insurance rule is assumed: a building with no plan is "not set up".

import { periodRowToApi } from "../defectsPeriods";
import { scheduleRowToApi } from "../serviceSchedules";
import { certificateFindings } from "./certificates";
import { toContractor } from "./contractors";
import { defectsFindings } from "./defects";
import { overdueFindings } from "./overdue";
import { readPlanTrades } from "./plan";
import { tradeGapFindings } from "./tradeGaps";
import type { SqlRow } from "../db";
import type { InsuranceDocument } from "./insuranceEvidence";
import type { ComplianceBuilding, ComplianceCounts, ComplianceReportResponse, ComplianceScope } from "./types";

export interface ComplianceData {
  /** The commercial buildings in scope, as read. */
  buildings: readonly SqlRow[];
  /** Insurance certificates (not archived) of the contractors in `contractors`. */
  certificates: readonly SqlRow[];
  /** The contractors named by the schedules or the plans. */
  contractors: readonly SqlRow[];
  /** Live defects periods (not archived), with the tenancy and contractor names. */
  periods: readonly SqlRow[];
  /** Coverage plans: BuildingId and PlanJson. */
  plans: readonly SqlRow[];
  /** Live service schedules (active, not archived), as SELECT_SCHEDULE reads them. */
  schedules: readonly SqlRow[];
}

const isoDate = (value: unknown): string | null => {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null;
};

const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

export function toDocument(row: SqlRow): InsuranceDocument {
  return {
    buildingId: numberOrNull(row.BuildingId),
    category: String(row.ServiceCategory ?? ""),
    contractorId: numberOrNull(row.ContractorId),
    expiresOn: isoDate(row.ExpiresOn),
    insuranceType: typeof row.InsuranceType === "string" ? row.InsuranceType : null,
    issuedOn: isoDate(row.IssuedOn),
    kind: String(row.Kind ?? ""),
  };
}

function groupByBuilding<T extends { buildingId: number }>(items: readonly T[]): Map<number, T[]> {
  const groups = new Map<number, T[]>();
  for (const item of items) groups.set(item.buildingId, [...(groups.get(item.buildingId) ?? []), item]);
  return groups;
}

const hasFindings = (building: ComplianceBuilding): boolean =>
  building.certificates.length + building.tradeGaps.length + building.overdueSchedules.length + building.defectsPeriods.length > 0;

export function buildComplianceReport(input: { asOf: string; data: ComplianceData; generatedAt: string; scope: ComplianceScope }): ComplianceReportResponse {
  const { asOf, data, scope } = input;
  // One building asked for: only that one, whatever else was read.
  const asked = (row: SqlRow): boolean => !("buildingId" in scope) || Number(row.BuildingID) === scope.buildingId;
  const commercial = new Map(data.buildings.filter(asked).map((row) => [Number(row.BuildingID), row]));
  const contractorRows = new Map(data.contractors.map((row) => [Number(row.ContractorID), row]));
  const documents = data.certificates.map(toDocument);
  const plans = new Map(data.plans.map((row) => [Number(row.BuildingId), readPlanTrades(row.PlanJson)]));

  const schedules = groupByBuilding(
    data.schedules.map((row) => scheduleRowToApi(row, asOf)).filter((schedule) => commercial.has(schedule.buildingId) && schedule.active && !schedule.archived),
  );
  const periods = groupByBuilding(data.periods.map((row) => periodRowToApi(row, asOf)).filter((period) => commercial.has(period.buildingId)));

  const checked = { buildings: commercial.size, contractors: 0, requiredTrades: 0, schedules: 0 };
  const buildings: ComplianceBuilding[] = [];
  for (const [buildingId, row] of commercial) {
    const live = schedules.get(buildingId) ?? [];
    const plan = plans.get(buildingId) ?? [];
    const assigned = new Set<number>([...live.flatMap((schedule) => (schedule.contractorId === null ? [] : [schedule.contractorId])), ...plan.flatMap((trade) => trade.contractorIds)]);
    checked.contractors += assigned.size;
    checked.requiredTrades += plan.filter((trade) => trade.required).length;
    checked.schedules += live.length;
    buildings.push({
      buildingId,
      certificates: certificateFindings({ asOf, buildingId, contractors: [...assigned].map((id) => toContractor(id, contractorRows.get(id))), documents }),
      defectsPeriods: defectsFindings(periods.get(buildingId) ?? []),
      name: String(row.BuildingName ?? ""),
      overdueSchedules: overdueFindings(live, asOf),
      referenceCode: row.ReferenceCode == null ? null : String(row.ReferenceCode),
      tradeGaps: tradeGapFindings({ contractorRows, plan, schedules: live }),
    });
  }

  const shown = buildings
    .filter((building) => "buildingId" in scope || hasFindings(building))
    .sort((a, b) => a.name.localeCompare(b.name, "en-AU") || a.buildingId - b.buildingId);
  const totals: ComplianceCounts = { certificates: 0, defectsPeriods: 0, overdueSchedules: 0, tradeGaps: 0 };
  for (const building of shown) {
    totals.certificates += building.certificates.length;
    totals.defectsPeriods += building.defectsPeriods.length;
    totals.overdueSchedules += building.overdueSchedules.length;
    totals.tradeGaps += building.tradeGaps.length;
  }
  return {
    asOf,
    buildings: shown,
    checked,
    generatedAt: input.generatedAt,
    totals: { ...totals, buildingsWithFindings: shown.filter(hasFindings).length },
  };
}
