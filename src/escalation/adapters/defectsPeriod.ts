// The defects_period adapter (LAUNCH-READINESS §5 behaviour 5; sprint F1): the
// 60- and 30-day reminders before a defects liability period ends. They go to
// the facilities manager and into the morning digest; they are not urgent and
// never move up a level on their own (policies seeded by migration 119). The
// facilities scheduler raises them (src/facilitiesScheduler.ts); the sweep ends
// them once the period has ended or been archived.

import { todayInDarwin } from "../../darwinDate";
import { displayDate, fetchPeriod, periodRowToApi, servicesLabel, toCoveragePeriod, type DefectsPeriodApi } from "../../defectsPeriods";
import { VIEW_FACILITIES_ROLES } from "../../facilitiesRoles";
import { daysFromTo, defectsReminderStage } from "../../facilitiesRules";
import { normaliseRole } from "../roles";
import type { EscalationAdapter } from "./registry";

export const DEFECTS_SUBJECT_TYPE = "defects_period";

export const DEFECTS_POLICIES = {
  endsIn30: "defects_period.ends_in_30",
  endsIn60: "defects_period.ends_in_60",
} as const;

const VIEWERS: ReadonlySet<string> = new Set(VIEW_FACILITIES_ROLES);

export function defectsPeriodLabel(period: Pick<DefectsPeriodApi, "buildingName" | "endsOn" | "works">): string {
  return ["Defects period", period.works, period.buildingName, `ends ${displayDate(period.endsOn)}`]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" · ");
}

/** Spec §5 behaviour 5, in one line. */
export function defectsReminderHeadline(
  period: Pick<DefectsPeriodApi, "contractorName" | "endsOn" | "services">,
  today: string,
): string {
  const days = daysFromTo(today, period.endsOn);
  const when = days === 0 ? "Ends today" : `Ends in ${days} day${days === 1 ? "" : "s"}`;
  const who = period.contractorName ?? "the builder";
  return `${when}: book the end-of-defects inspection, send outstanding defects to ${who}, and put ${servicesLabel(period.services)} back on RP's schedule after ${displayDate(period.endsOn)}`;
}

async function loadPeriod(connection: Parameters<EscalationAdapter["loadSummary"]>[0], subjectId: string, today: string) {
  const id = Number(subjectId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const row = await fetchPeriod(connection, id);
  return row ? periodRowToApi(row, today) : null;
}

export const defectsPeriodAdapter: EscalationAdapter = {
  subjectType: DEFECTS_SUBJECT_TYPE,

  deepLink: (subjectId) => `/maintenance?defectsPeriodId=${encodeURIComponent(subjectId)}`,

  async isConditionActive(connection, ref, now) {
    const today = todayInDarwin(now);
    const period = await loadPeriod(connection, ref.subjectId, today);
    if (!period) return false;
    const stage = defectsReminderStage(toCoveragePeriod(period), today);
    return ref.policyKey === DEFECTS_POLICIES.endsIn30 ? stage === 30 : stage !== null;
  },

  ledgerScope: (escalation) => {
    const tenantId = escalation.context?.tenantId;
    return { tenantId: typeof tenantId === "number" ? tenantId : null };
  },

  async loadSummary(connection, subjectId) {
    const period = await loadPeriod(connection, subjectId, todayInDarwin());
    if (!period) return null;
    return {
      buildingId: period.buildingId,
      context: {
        buildingName: period.buildingName,
        contractorName: period.contractorName,
        defectsPeriodId: period.defectsPeriodId,
        endsOn: period.endsOn,
        services: period.services,
        tenantId: period.tenantId,
        works: period.works,
      },
      summary: defectsPeriodLabel(period),
    };
  },

  visibleTo: (viewer) => viewer.roles.some((role) => VIEWERS.has(normaliseRole(role))),
};
