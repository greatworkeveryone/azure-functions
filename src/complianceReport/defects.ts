// The Compliance report's fourth section: defects periods in force on the report date.
// While one is, planned maintenance it covers is blocked (a manager may book anyway
// with a reason; a warn-only period never refuses), so facilities needs to see them
// beside what is overdue. The rule is the Maintenance page's own: a live period is in
// force from practical completion to its end, both days included (periodRowToApi, over
// isPeriodActive). Pure.

import type { DefectsPeriodApi } from "../defectsPeriods";
import type { DefectsPeriodFinding } from "./types";

/** `periods` come from periodRowToApi(row, asOf), which decides `active` for the date. */
export function defectsFindings(periods: readonly DefectsPeriodApi[]): DefectsPeriodFinding[] {
  return periods
    .filter((period) => period.active)
    .sort((a, b) => a.endsOn.localeCompare(b.endsOn) || a.defectsPeriodId - b.defectsPeriodId)
    .map((period) => ({
      contractorName: period.contractorName?.trim() || null,
      defectsPeriodId: period.defectsPeriodId,
      endsOn: period.endsOn,
      enforcement: period.enforcement,
      levelName: period.levelName,
      scope: period.scope,
      services: period.services,
      startsOn: period.practicalCompletion,
      tenantName: period.tenantName,
      works: period.works,
    }));
}
