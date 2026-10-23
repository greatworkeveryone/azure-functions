// Recurring-fault signals (SC-AI5): the same thing breaking again and again,
// found by counting jobs. No model and no I/O: the route reads the jobs and
// their approved invoices, this decides which jobs belong together.
//
// A job is grouped by, in order:
//   1. the asset it is linked to (a job linked to two assets counts for both);
//   2. otherwise its building + level + trade;
//   3. with no level either, its building + trade, said to have no location.
// A job with no asset and no trade has nothing to say what kind of fault it
// was, so it is left out; so is one linked only to archived assets, because
// the thing was retired. Three or more jobs in a group is a signal.

import { addDaysIso, todayInDarwin } from "./darwinDate";
import { jobService, MAINTENANCE_SERVICES } from "./facilitiesRules";
import { RECURRING_FAULT_MIN_JOBS, RECURRING_FAULT_WINDOW_DAYS } from "./recurringFaultConstants";

/** Darwin is UTC+9:30 all year: the Northern Territory has no daylight saving. */
const DARWIN_OFFSET_MS = (9 * 60 + 30) * 60_000;
const DONE = "Done";

export interface FaultAsset {
  id: number;
  /** Name, with the tag when it has one: "Chiller 1 (CH-01)". */
  label: string;
  /** "Level 2 › Plant room", or null when the asset is not placed. */
  locationName: string | null;
}

export interface FaultJob {
  /** Live links to assets that are not archived. */
  assets: readonly FaultAsset[];
  buildingId: number;
  buildingName: string;
  category: string | null;
  createdAt: Date;
  id: number;
  kind: string;
  levelName: string | null;
  /** Linked to assets, all of them archived. */
  retiredAssetsOnly: boolean;
  status: string;
  title: string;
  type: string | null;
}

export interface FaultInvoice {
  amount: number | null;
  jobId: number;
  status: string;
}

export interface RecurringFaultJob {
  /** Darwin date, YYYY-MM-DD. */
  createdOn: string;
  id: number;
  status: string;
  title: string;
}

/** What the jobs were grouped on: their asset; their building, level and trade; or building and trade alone. */
export type FaultBasis = "asset" | "building" | "location";

export interface RecurringFaultSignal {
  assetId: number | null;
  basis: FaultBasis;
  buildingId: number;
  buildingName: string;
  firstOn: string;
  jobCount: number;
  /** Newest first. */
  jobs: RecurringFaultJob[];
  /** Stable for a deep link and a React key: "asset:12", or the place's own key. */
  key: string;
  /** Asset name, or building · location · trade. */
  label: string;
  lastOn: string;
  locationName: string | null;
  openCount: number;
  /** Approved invoices on these jobs, in dollars excluding GST. */
  spendExGst: number;
  trade: string | null;
}

export interface FaultGroup {
  asset: FaultAsset | null;
  basis: FaultBasis;
  buildingId: number;
  buildingName: string;
  jobs: FaultJob[];
  key: string;
  level: string | null;
  trade: string | null;
}

/** The instant the window opens: midnight at the start of the Darwin day `windowDays` before `today`. */
export function windowStartUtc(today: string, windowDays: number = RECURRING_FAULT_WINDOW_DAYS): Date {
  const [year, month, day] = addDaysIso(today, -windowDays).split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day) - DARWIN_OFFSET_MS);
}

const clean = (value: string | null | undefined): string => (value ?? "").trim().replace(/\s+/g, " ");
const sameText = (value: string): string => value.toLowerCase();
const newestFirst = (a: FaultJob, b: FaultJob): number => b.createdAt.getTime() - a.createdAt.getTime() || b.id - a.id;

/**
 * What kind of work the job was: a maintenance job's category, a reactive job's
 * mapped work-request type (the same rule defects periods use). A reactive job
 * that was given a maintenance category directly keeps it; a work-request type
 * with no category yet is used as written. "Common Areas" and "Tenancy Works"
 * say where, not what, so they are never a trade.
 */
export function tradeOfJob(job: Pick<FaultJob, "buildingId" | "category" | "kind" | "levelName" | "type">): string | null {
  const service = jobService({ buildingId: job.buildingId, category: job.category, kind: job.kind, levelName: job.levelName, tenantId: null, type: job.type });
  if (service) return service;
  const category = clean(job.category);
  const known = MAINTENANCE_SERVICES.find((trade) => sameText(trade) === sameText(category));
  return known ?? (clean(job.type) || null);
}

function addTo(groups: Map<string, FaultGroup>, job: FaultJob, start: Omit<FaultGroup, "jobs">): void {
  const group = groups.get(start.key) ?? { ...start, jobs: [] };
  group.jobs.push(job);
  groups.set(start.key, group);
}

/** Every group of jobs, whatever its size. Jobs are taken newest first, so a level's or trade's spelling is the newest job's. */
export function groupFaultJobs(jobs: readonly FaultJob[]): FaultGroup[] {
  const groups = new Map<string, FaultGroup>();
  for (const job of [...jobs].sort(newestFirst)) {
    const where = { buildingId: job.buildingId, buildingName: job.buildingName };
    if (job.assets.length > 0) {
      for (const asset of job.assets) addTo(groups, job, { ...where, asset, basis: "asset", key: `asset:${asset.id}`, level: null, trade: null });
      continue;
    }
    const trade = job.retiredAssetsOnly ? null : tradeOfJob(job);
    if (!trade) continue;
    const level = clean(job.levelName) || null;
    const key = `place:${JSON.stringify([job.buildingId, level === null ? "" : sameText(level), sameText(trade)])}`;
    addTo(groups, job, { ...where, asset: null, basis: level === null ? "building" : "location", key, level, trade });
  }
  return [...groups.values()];
}

/** The groups big enough to be a signal. */
export function recurringGroups(jobs: readonly FaultJob[], minJobs: number = RECURRING_FAULT_MIN_JOBS): FaultGroup[] {
  return groupFaultJobs(jobs).filter((group) => group.jobs.length >= minJobs);
}

/** Floorplan holds invoice amounts GST inclusive (MYOB bills go out tax inclusive), so ex GST is 10/11 of them. */
export const exGstCents = (incGstCents: number): number => Math.round((incGstCents * 10) / 11);

/**
 * Cents inc GST of the approved invoices on each job. Approved means what the
 * transition guard means: director-approved, or stage-1 approved where no
 * director is needed for its amount, so an invoice still waiting on a director
 * is not spend yet.
 */
export function approvedCentsByJob(invoices: readonly FaultInvoice[], directorNeeded: (amount: number) => boolean): Map<number, number> {
  const cents = new Map<number, number>();
  for (const invoice of invoices) {
    const { amount } = invoice;
    if (amount === null || !Number.isFinite(amount)) continue;
    const approved = invoice.status === "director_approved" || (invoice.status === "approved" && !directorNeeded(amount));
    if (approved) cents.set(invoice.jobId, (cents.get(invoice.jobId) ?? 0) + Math.round(amount * 100));
  }
  return cents;
}

function toSignal(group: FaultGroup, centsByJob: ReadonlyMap<number, number>): RecurringFaultSignal {
  const jobs = group.jobs.map((job) => ({ createdOn: todayInDarwin(job.createdAt), id: job.id, status: job.status, title: job.title }));
  const spendCents = group.jobs.reduce((sum, job) => sum + (centsByJob.get(job.id) ?? 0), 0);
  const label = group.asset ? group.asset.label : [group.buildingName, group.level, group.trade].filter(Boolean).join(" · ");
  return {
    assetId: group.asset?.id ?? null,
    basis: group.basis,
    buildingId: group.buildingId,
    buildingName: group.buildingName,
    firstOn: jobs[jobs.length - 1].createdOn,
    jobCount: jobs.length,
    jobs,
    key: group.key,
    label,
    lastOn: jobs[0].createdOn,
    locationName: group.asset ? group.asset.locationName : group.level,
    openCount: group.jobs.filter((job) => job.status !== DONE).length,
    spendExGst: exGstCents(spendCents) / 100,
    trade: group.trade,
  };
}

/** Signals most jobs first, then most spent, then most recent. */
export function toSignals(groups: readonly FaultGroup[], centsByJob: ReadonlyMap<number, number>): RecurringFaultSignal[] {
  return groups
    .map((group) => toSignal(group, centsByJob))
    .sort((a, b) => b.jobCount - a.jobCount || b.spendExGst - a.spendExGst || b.lastOn.localeCompare(a.lastOn) || a.label.localeCompare(b.label));
}
