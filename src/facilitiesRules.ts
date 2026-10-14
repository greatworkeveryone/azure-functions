// Facilities rules (LAUNCH-READINESS §5, WP47/WP48, WP50): pure, no I/O.
// Mirrored byte for byte in command-centre src/helpers/facilitiesRules.ts and
// pinned on both sides by the same vector file (facilities-rules.vectors.json).
// Change both copies and the vectors together.
//
// Dates are Darwin calendar dates as "YYYY-MM-DD" strings, so no time zone can
// shift a day.

/** The maintenance categories, which are also the services a defects period names. */
export const MAINTENANCE_SERVICES = [
  "Fire & life safety",
  "HVAC / mechanical",
  "Hydraulic",
  "Electrical",
  "Lifts",
  "Cleaning",
  "Compliance",
  "Grounds",
  "Other",
] as const;

export const ALL_SERVICES = "all";
export type DefectsServices = typeof ALL_SERVICES | readonly string[];
export type DefectsScope = "building" | "level" | "tenancy";
export const DEFECTS_SCOPES: readonly DefectsScope[] = ["building", "level", "tenancy"];
export type DefectsEnforcement = "block" | "warn";
export const DEFECTS_ENFORCEMENTS: readonly DefectsEnforcement[] = ["block", "warn"];

/** Reactive jobs carry a myBuildings work-request type; these map to a service.
 *  An unmapped type matches only a period whose services are "all". */
export const WR_TYPE_SERVICE: Readonly<Record<string, string>> = {
  "Air Conditioning": "HVAC / mechanical",
  "Cleaning & Sanitation": "Cleaning",
  "Electrical": "Electrical",
  "Emergency & Exit Lights": "Fire & life safety",
  "Fire Services & Equipment": "Fire & life safety",
  "Gardening": "Grounds",
  "Generators": "Electrical",
  "Hydraulics": "Hydraulic",
  "Lifts": "Lifts",
  "Lighting": "Electrical",
  "Plumbing": "Hydraulic",
};

/** What the rule needs to know about a job (new or existing). */
export interface CoverageJob {
  buildingId: number;
  category: string | null;
  kind: string | null;
  /** The level's Locations id, when the job is tied to one. */
  levelLocationId?: number | null;
  levelName: string | null;
  tenantId: number | null;
  /** The work-request type (reactive jobs). */
  type: string | null;
}

/** What the rule needs to know about a defects period. */
export interface CoveragePeriod {
  archived: boolean;
  buildingId: number;
  endsOn: string;
  levelName: string | null;
  locationId: number | null;
  practicalCompletion: string;
  scope: DefectsScope;
  services: DefectsServices;
  tenantId: number | null;
}

const DAY_MS = 86_400_000;

function utcDay(iso: string): number {
  const [year, month, day] = iso.slice(0, 10).split("-").map(Number);
  return Date.UTC(year, month - 1, day);
}

/** Whole days from `fromIso` to `toIso` (negative when `toIso` is earlier). */
export function daysFromTo(fromIso: string, toIso: string): number {
  return Math.round((utcDay(toIso) - utcDay(fromIso)) / DAY_MS);
}

function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = (a ?? "").trim().toLowerCase();
  return left !== "" && left === (b ?? "").trim().toLowerCase();
}

/** The service a job is for: a maintenance job's category, a reactive job's mapped type. */
export function jobService(job: CoverageJob): string | null {
  if (job.kind === "maintenance") return job.category?.trim() || null;
  return (job.type && WR_TYPE_SERVICE[job.type.trim()]) || null;
}

/** Not archived, and today falls between practical completion and the end, inclusive. */
export function isPeriodActive(period: CoveragePeriod, today: string): boolean {
  return !period.archived && period.practicalCompletion <= today && today <= period.endsOn;
}

function serviceMatches(period: CoveragePeriod, service: string | null): boolean {
  if (period.services === ALL_SERVICES) return true;
  return service !== null && period.services.includes(service);
}

/** Building contains level contains tenancy. A level matches by Locations id
 *  when both sides have one, otherwise by name. */
function scopeContains(period: CoveragePeriod, job: CoverageJob): boolean {
  if (period.scope === "building") return true;
  if (period.scope === "tenancy") return job.tenantId != null && job.tenantId === period.tenantId;
  if (period.locationId != null && job.levelLocationId != null) return period.locationId === job.levelLocationId;
  return sameName(period.levelName, job.levelName);
}

/** A job is covered when it is in the period's building, today is inside the
 *  period, the scope contains the job's location and the service matches. */
export function isJobCovered(job: CoverageJob, period: CoveragePeriod, today: string): boolean {
  return (
    job.buildingId === period.buildingId &&
    isPeriodActive(period, today) &&
    serviceMatches(period, jobService(job)) &&
    scopeContains(period, job)
  );
}

/** Every period that covers the job, the one ending soonest first. */
export function coveringPeriods<P extends CoveragePeriod>(job: CoverageJob, periods: readonly P[], today: string): P[] {
  return periods
    .filter((period) => isJobCovered(job, period, today))
    .sort((a, b) => a.endsOn.localeCompare(b.endsOn));
}

/** A level or tenancy period for this service exists, but the job doesn't say
 *  which level or tenancy it is on: the form asks rather than guessing. */
export function needsLocationChoice(job: CoverageJob, period: CoveragePeriod, today: string): boolean {
  if (period.scope === "building") return false;
  if (job.buildingId !== period.buildingId || !isPeriodActive(period, today)) return false;
  if (!serviceMatches(period, jobService(job))) return false;
  if (period.scope === "tenancy") return job.tenantId == null;
  return job.levelLocationId == null && !(job.levelName ?? "").trim();
}

/** Which end-of-period reminder applies today: 60 (31-60 days left), 30 (0-30
 *  days left) or none. */
export function defectsReminderStage(period: Pick<CoveragePeriod, "archived" | "endsOn">, today: string): 30 | 60 | null {
  if (period.archived) return null;
  const left = daysFromTo(today, period.endsOn);
  if (left < 0 || left > 60) return null;
  return left <= 30 ? 30 : 60;
}
