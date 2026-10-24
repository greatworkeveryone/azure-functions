// Inbound email triage (EB3): who may be chosen, and each person's feature vector. Pure over the
// facts load.ts reads, so every rule is testable without a database. The vector is versioned
// (FEATURE_SCHEMA_VERSION) and logged verbatim with every set; change a field's meaning only by
// adding a new version.

import { canonicalTrade } from "../contractorSuggestions/features";
import type { ActivityFacts, AssignedJob, StaffRow } from "./load";
import type { Candidate, FeatureVector, Lane, RoleFit, TriageContext } from "./types";

export const FEATURE_SCHEMA_VERSION = "triage-features@1";
export const JOB_WINDOW_DAYS = 90;
const DAY_MS = 86_400_000;

const FACILITIES_ROLES: readonly string[] = ["facilities", "facilities_manager"];
const ACCOUNTS_ROLES: readonly string[] = ["accounts", "accounts_manager"];

export function roleFit(role: string, lane: Lane): RoleFit {
  const manager = role === "facilities_manager" || role === "accounts_manager";
  const inLane = lane === "facilities" ? FACILITIES_ROLES.includes(role) : lane === "accounts" ? ACCOUNTS_ROLES.includes(role) : [...FACILITIES_ROLES, ...ACCOUNTS_ROLES].includes(role);
  if (!inLane) return "none";
  if (lane === "both") return manager ? "either_manager" : "either_staff";
  return manager ? "lane_manager" : "lane_staff";
}

export type Exclusion = "leave" | "inactive";

export interface Eligibility {
  eligible: StaffRow[];
  excluded: { reason: Exclusion; userId: number }[];
}

export interface EligibilityFacts {
  /** Null when access logging is off or cannot be read: nobody is excluded as inactive then. */
  activity: ActivityFacts | null;
  inactivityDays: number;
  /** Id of the person who sent the send being answered: kept in the pool whatever their role, unless away. */
  linkedSenderId: number | null;
  now: Date;
  onLeave: ReadonlySet<number>;
}

/**
 * Active staff whose role fits the work (or who sent the send being answered), without anyone on
 * approved leave covering today or anyone who has not been seen for the inactivity threshold. "Not
 * seen" is only held against a person when the access log is older than the threshold itself: a log
 * that began yesterday cannot say anyone has been away a week.
 */
export function chooseEligible(staff: readonly StaffRow[], lane: Lane, facts: EligibilityFacts): Eligibility {
  const excluded: Eligibility["excluded"] = [];
  const eligible: StaffRow[] = [];
  const thresholdMs = facts.inactivityDays * DAY_MS;
  const logOldEnough = facts.activity?.logStartedAt != null && facts.now.getTime() - facts.activity.logStartedAt.getTime() >= thresholdMs;

  for (const person of staff) {
    const fits = roleFit(person.role, lane) !== "none" || person.userId === facts.linkedSenderId;
    if (!fits) continue;
    if (facts.onLeave.has(person.userId)) {
      excluded.push({ reason: "leave", userId: person.userId });
      continue;
    }
    const last = facts.activity?.lastActive.get(person.userId);
    if (logOldEnough && (!last || facts.now.getTime() - last.getTime() >= thresholdMs)) {
      excluded.push({ reason: "inactive", userId: person.userId });
      continue;
    }
    eligible.push(person);
  }
  return { eligible, excluded };
}

const sameCategory = (a: string | null, b: string | null): boolean => {
  const left = canonicalTrade(a);
  return left !== null && left === canonicalTrade(b);
};

/** One vector per person, from their assigned jobs (open ones, and any raised in the last 90 days). */
export function buildVectors(
  people: readonly StaffRow[],
  jobs: readonly AssignedJob[],
  context: TriageContext,
  options: { activity: ActivityFacts | null; namedJobAssignee: number | null; now: Date },
): Map<number, FeatureVector> {
  const since = options.now.getTime() - JOB_WINDOW_DAYS * DAY_MS;
  const out = new Map<number, FeatureVector>();
  for (const person of people) {
    const mine = jobs.filter((job) => job.assignedToUserId === person.userId);
    const here = (job: AssignedJob) => context.buildingId !== null && job.buildingId === context.buildingId;
    const recent = (job: AssignedJob) => job.createdAt.getTime() >= since;
    const last = options.activity?.lastActive.get(person.userId);
    out.set(person.userId, {
      daysSinceActive: last ? Math.max(0, Math.floor((options.now.getTime() - last.getTime()) / DAY_MS)) : null,
      jobsHere90d: mine.filter((job) => here(job) && recent(job)).length,
      jobsHereCategory90d: mine.filter((job) => here(job) && recent(job) && sameCategory(job.category, context.category)).length,
      openJobs: mine.filter((job) => job.open).length,
      ownsNamedJob: options.namedJobAssignee === person.userId,
      ownsOpenJobForTenancy: context.tenancyId !== null && mine.some((job) => job.open && job.tenancyId === context.tenancyId),
      ownsOpenJobHere: mine.some((job) => job.open && here(job)),
      roleFit: roleFit(person.role, context.lane),
      sentLinkedSend: context.linkedSend?.sentByUserId === person.userId,
    });
  }
  return out;
}

export function toCandidates(people: readonly StaffRow[], vectors: ReadonlyMap<number, FeatureVector>): Candidate[] {
  return people.flatMap((person) => {
    const features = vectors.get(person.userId);
    return features ? [{ features, name: person.name, role: person.role, userId: person.userId }] : [];
  });
}
