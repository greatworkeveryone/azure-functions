// The Maintenance page's overview (WP51; sprint F3), assembled server-side by
// getMaintenanceOverview: what is due in the next N days (default 90), what is
// overdue (against the service's own due date, not a job's chase date), when
// each asset was last serviced and its history, and the defects periods in
// force, grouped by building then asset. assembleOverview is pure; the handler
// does the reads.

import { addDays, nextDueAfter } from "./facilitiesRules";
import type { DefectsPeriodApi } from "./defectsPeriods";
import type { SchedulerMode } from "./schedulerMode";
import { seriesOf, type ScheduleApi } from "./serviceSchedules";

export type ServiceStatus = "job_open" | "overdue" | "scheduled";

export interface OverviewService {
  /** The job made for this overdue due date was archived: there is nothing to chase, only the outcome to record. */
  archivedJobId: number | null;
  category: string;
  contractorName: string | null;
  dueDate: string;
  generatesOn: string;
  intervalCount: number;
  intervalUnit: ScheduleApi["intervalUnit"];
  isContract: boolean;
  jobId: number | null;
  jobStatus: string | null;
  /** The last time this schedule was serviced: a done job or a manager's record. A one-off job linked to the asset counts for the asset, not here. */
  lastDone: { date: string; jobId: number | null } | null;
  name: string;
  /** 0 = the next due date (the one with a real status); later ones are previews. */
  occurrence: number;
  serviceScheduleId: number;
  status: ServiceStatus;
  urgent: boolean;
}

export interface OverviewHistoryItem {
  date: string;
  jobId: number | null;
  jobStatus: string | null;
  jobTitle: string | null;
  /** A manager's note: why a due date was skipped, or how it was serviced. */
  note: string | null;
  outcome: "done" | "open" | "skipped" | "skipped_defects";
  source: "linked_job" | "schedule";
}

export interface OverviewAsset {
  assetId: number | null;
  assetName: string | null;
  assetTag: string | null;
  history: OverviewHistoryItem[];
  /** "asset-12", or "schedule-40" for a service with no asset. */
  key: string;
  lastServiced: { date: string; jobId: number | null } | null;
  locationName: string | null;
  scope: string | null;
  services: OverviewService[];
}

export interface OverviewBuilding {
  assets: OverviewAsset[];
  buildingId: number;
  buildingName: string;
  counts: { jobOpen: number; overdue: number; scheduled: number };
  defectsPeriods: DefectsPeriodApi[];
}

export interface MaintenanceOverview {
  buildings: OverviewBuilding[];
  days: number;
  /** Any live schedule exists (in this scope): the page may say "scheduled servicing". */
  hasSchedules: boolean;
  /** What the daily scheduler is doing: the page only promises jobs when this is "live". */
  schedulerMode: SchedulerMode;
  /** Live schedules set up in this scope, whether or not anything is due in the window. */
  scheduleCount: number;
  /** Jobs the scheduler created, so the plain jobs list can leave them out. */
  scheduledJobIds: number[];
  today: string;
  until: string;
}

export interface OverviewRun {
  completedAt: string | null;
  dueDate: string;
  jobArchived: boolean;
  jobId: number | null;
  jobStatus: string | null;
  jobTitle: string | null;
  note: string | null;
  outcome: "job_created" | "recorded" | "skipped" | "skipped_defects";
  serviceScheduleId: number;
}

export interface OverviewLinkedJob {
  assetId: number;
  completedOn: string;
  jobId: number;
  jobStatus: string;
  jobTitle: string;
}

export interface OverviewInput {
  days: number;
  hasSchedules: boolean;
  linkedJobs: OverviewLinkedJob[];
  periods: DefectsPeriodApi[];
  runs: OverviewRun[];
  scheduleCount: number;
  schedulerMode: SchedulerMode;
  schedules: ScheduleApi[];
  today: string;
}

const MAX_OCCURRENCES = 26;
const HISTORY_LIMIT = 10;
const isOpenJob = (run: OverviewRun | undefined): run is OverviewRun =>
  Boolean(run && run.jobId !== null && !run.jobArchived && run.jobStatus !== "Done");
const isDoneRun = (run: OverviewRun): boolean => run.outcome === "recorded" || (run.outcome === "job_created" && run.jobStatus === "Done");
const doneDate = (run: OverviewRun): string => (run.completedAt ? run.completedAt.slice(0, 10) : run.dueDate);

function lastDoneFor(scheduleId: number, runs: OverviewRun[]): OverviewService["lastDone"] {
  const [latest] = runs
    .filter((run) => run.serviceScheduleId === scheduleId && !run.jobArchived && isDoneRun(run))
    .sort((a, b) => doneDate(b).localeCompare(doneDate(a)));
  return latest ? { date: doneDate(latest), jobId: latest.jobId } : null;
}

function servicesFor(schedule: ScheduleApi, runs: OverviewRun[], today: string, until: string): OverviewService[] {
  const current = runs.find((run) => run.serviceScheduleId === schedule.serviceScheduleId && run.dueDate === schedule.nextDue);
  const open = isOpenJob(current) ? current : undefined;
  const archivedJobId = schedule.overdue && current?.jobId != null && current.jobArchived ? current.jobId : null;
  const base = {
    archivedJobId: null,
    category: schedule.category,
    contractorName: schedule.contractorName,
    intervalCount: schedule.intervalCount,
    intervalUnit: schedule.intervalUnit,
    isContract: schedule.isContract,
    lastDone: lastDoneFor(schedule.serviceScheduleId, runs),
    name: schedule.name,
    serviceScheduleId: schedule.serviceScheduleId,
    urgent: schedule.urgent,
  };
  const services: OverviewService[] = [
    {
      ...base,
      dueDate: schedule.nextDue,
      generatesOn: schedule.generatesOn,
      archivedJobId,
      jobId: open?.jobId ?? (schedule.overdue && archivedJobId === null ? current?.jobId ?? null : null),
      jobStatus: open?.jobStatus ?? null,
      occurrence: 0,
      status: schedule.overdue ? "overdue" : open ? "job_open" : "scheduled",
    },
  ];
  let due = schedule.nextDue;
  while (services.length < MAX_OCCURRENCES) {
    due = nextDueAfter(seriesOf(schedule), due);
    if (due > until) break;
    if (due < today) continue;
    services.push({ ...base, dueDate: due, generatesOn: addDays(due, -schedule.leadDays), jobId: null, jobStatus: null, occurrence: services.length, status: "scheduled" });
  }
  return services;
}

function historyFor(schedules: ScheduleApi[], assetId: number | null, runs: OverviewRun[], linkedJobs: OverviewLinkedJob[]): OverviewHistoryItem[] {
  const ids = new Set(schedules.map((s) => s.serviceScheduleId));
  const fromRuns: OverviewHistoryItem[] = runs
    .filter((run) => ids.has(run.serviceScheduleId) && !run.jobArchived)
    .map((run): OverviewHistoryItem => {
      const done = isDoneRun(run);
      return {
        date: done ? doneDate(run) : run.dueDate,
        jobId: run.jobId,
        jobStatus: run.jobStatus,
        jobTitle: run.jobTitle,
        note: run.note,
        outcome: run.outcome === "skipped_defects" || run.outcome === "skipped" ? run.outcome : done ? "done" : "open",
        source: "schedule",
      };
    });
  const seen = new Set(fromRuns.map((item) => item.jobId).filter((id): id is number => id !== null));
  const fromLinks: OverviewHistoryItem[] = assetId === null ? [] : linkedJobs
    .filter((job) => job.assetId === assetId && !seen.has(job.jobId))
    .map((job) => ({ date: job.completedOn, jobId: job.jobId, jobStatus: job.jobStatus, jobTitle: job.jobTitle, note: null, outcome: "done", source: "linked_job" }));
  return [...fromRuns, ...fromLinks].sort((a, b) => b.date.localeCompare(a.date)).slice(0, HISTORY_LIMIT);
}

function assetGroups(schedules: ScheduleApi[], input: OverviewInput, until: string): OverviewAsset[] {
  const groups = new Map<string, ScheduleApi[]>();
  for (const schedule of schedules) {
    const key = schedule.assetId !== null ? `asset-${schedule.assetId}` : `schedule-${schedule.serviceScheduleId}`;
    groups.set(key, [...(groups.get(key) ?? []), schedule]);
  }
  const assets = [...groups.entries()].map(([key, group]): OverviewAsset => {
    const [first] = group;
    const services = group
      .flatMap((schedule) => servicesFor(schedule, input.runs, input.today, until))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.serviceScheduleId - b.serviceScheduleId);
    const history = historyFor(group, first.assetId, input.runs, input.linkedJobs);
    const done = history.find((item) => item.outcome === "done");
    return {
      assetId: first.assetId,
      assetName: first.assetName,
      assetTag: first.assetTag,
      history,
      key,
      lastServiced: done ? { date: done.date, jobId: done.jobId } : null,
      locationName: first.locationName,
      scope: first.assetId === null ? first.scope : null,
      services,
    };
  });
  return assets.sort((a, b) => (a.services[0]?.dueDate ?? "").localeCompare(b.services[0]?.dueDate ?? "") || a.key.localeCompare(b.key));
}

export function assembleOverview(input: OverviewInput): MaintenanceOverview {
  const until = addDays(input.today, input.days);
  const inWindow = input.schedules.filter((s) => s.active && !s.archived && s.nextDue <= until);
  const buildingIds = new Set([...inWindow.map((s) => s.buildingId), ...input.periods.map((p) => p.buildingId)]);
  const buildings = [...buildingIds].map((buildingId): OverviewBuilding => {
    const assets = assetGroups(inWindow.filter((s) => s.buildingId === buildingId), input, until);
    const current = assets.flatMap((asset) => asset.services.filter((service) => service.occurrence === 0));
    const periods = input.periods.filter((p) => p.buildingId === buildingId);
    return {
      assets,
      buildingId,
      buildingName: inWindow.find((s) => s.buildingId === buildingId)?.buildingName ?? periods[0]?.buildingName ?? `Building ${buildingId}`,
      counts: {
        jobOpen: current.filter((s) => s.status === "job_open").length,
        overdue: current.filter((s) => s.status === "overdue").length,
        scheduled: current.filter((s) => s.status === "scheduled").length,
      },
      defectsPeriods: periods,
    };
  });
  return {
    buildings: buildings.sort((a, b) => a.buildingName.localeCompare(b.buildingName)),
    days: input.days,
    hasSchedules: input.hasSchedules,
    scheduleCount: input.scheduleCount,
    schedulerMode: input.schedulerMode,
    scheduledJobIds: [...new Set(input.runs.map((run) => run.jobId).filter((id): id is number => id !== null))],
    today: input.today,
    until,
  };
}
