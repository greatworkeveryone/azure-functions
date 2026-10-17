// The service_schedule adapter (WP50; sprint F2): overdue servicing, measured
// against the service's own due date. Fire & life safety and Lifts escalate as
// urgent (wall clock, facilities manager then directors); everything else goes
// to the facilities manager and the morning digest (policies seeded by migration
// 120). The facilities scheduler raises them; the sweep ends one once the
// service is done (NextDue moved on), the schedule is paused or archived.

import { todayInDarwin } from "../../darwinDate";
import { VIEW_FACILITIES_ROLES } from "../../facilitiesRoles";
import { isServiceOverdue } from "../../facilitiesRules";
import { fetchSchedule, scheduleRowToApi, scheduleTarget, type ScheduleApi } from "../../serviceSchedules";
import { normaliseRole } from "../roles";
import type { EscalationAdapter } from "./registry";

export const SCHEDULE_SUBJECT_TYPE = "service_schedule";

export const SCHEDULE_POLICIES = {
  overdue: "service_schedule.overdue",
  overdueUrgent: "service_schedule.overdue_urgent",
} as const;

const VIEWERS: ReadonlySet<string> = new Set(VIEW_FACILITIES_ROLES);

const ddmmyyyy = (isoDay: string): string => isoDay.split("-").reverse().join("/");

export function schedulePolicyFor(schedule: Pick<ScheduleApi, "urgent">): string {
  return schedule.urgent ? SCHEDULE_POLICIES.overdueUrgent : SCHEDULE_POLICIES.overdue;
}

/** "Service · Six-monthly chiller service · Chiller 1 (CH-01) · Tower A · was due 28/02/2027" */
export function scheduleLabel(schedule: ScheduleApi): string {
  return ["Service", schedule.name, scheduleTarget(schedule), schedule.buildingName, `was due ${ddmmyyyy(schedule.nextDue)}`]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" · ");
}

async function loadSchedule(connection: Parameters<EscalationAdapter["loadSummary"]>[0], subjectId: string, today: string) {
  const id = Number(subjectId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await fetchSchedule(connection, id);
  return row ? scheduleRowToApi(row, today) : null;
}

export const serviceScheduleAdapter: EscalationAdapter = {
  subjectType: SCHEDULE_SUBJECT_TYPE,

  deepLink: (subjectId) => `/maintenance?scheduleId=${encodeURIComponent(subjectId)}`,

  async isConditionActive(connection, ref, now) {
    const today = todayInDarwin(now);
    const schedule = await loadSchedule(connection, ref.subjectId, today);
    if (!schedule || !schedule.active || schedule.archived) return false;
    return isServiceOverdue(schedule.nextDue, today);
  },

  async loadSummary(connection, subjectId) {
    const schedule = await loadSchedule(connection, subjectId, todayInDarwin());
    if (!schedule) return null;
    return {
      buildingId: schedule.buildingId,
      context: {
        assetId: schedule.assetId,
        buildingName: schedule.buildingName,
        category: schedule.category,
        name: schedule.name,
        nextDue: schedule.nextDue,
        serviceScheduleId: schedule.serviceScheduleId,
      },
      summary: scheduleLabel(schedule),
    };
  },

  visibleTo: (viewer) => viewer.roles.some((role) => VIEWERS.has(normaliseRole(role))),
};
