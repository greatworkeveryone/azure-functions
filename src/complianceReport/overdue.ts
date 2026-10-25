// The Compliance report's third section: live service schedules overdue on the report
// date. The rule is the Maintenance page's own: a schedule is overdue when its next due
// date is before the date (scheduleRowToApi, over isServiceOverdue), so a service due on
// the date itself is not overdue yet, and an open job doesn't hide an overdue service.
// Pure.

import { daysFromTo } from "../facilitiesRules";
import { tradeLabel } from "../maintenanceSpend/trades";
import { scheduleTarget, type ScheduleApi } from "../serviceSchedules";
import type { OverdueScheduleFinding } from "./types";

/** `schedules` come from scheduleRowToApi(row, asOf), which decides `overdue` for the date. */
export function overdueFindings(schedules: readonly ScheduleApi[], asOf: string): OverdueScheduleFinding[] {
  return schedules
    .filter((schedule) => schedule.overdue)
    .sort((a, b) => a.nextDue.localeCompare(b.nextDue) || a.serviceScheduleId - b.serviceScheduleId)
    .map((schedule) => ({
      contractorName: schedule.contractorName?.trim() || null,
      daysOverdue: daysFromTo(schedule.nextDue, asOf),
      dueDate: schedule.nextDue,
      name: schedule.name,
      serviceScheduleId: schedule.serviceScheduleId,
      target: scheduleTarget(schedule),
      trade: tradeLabel(schedule.category),
    }));
}
