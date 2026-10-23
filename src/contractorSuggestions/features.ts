// Contractor suggestions (SC-AI3): the feature vector for one candidate. Pure:
// the loaders (./load) fetch the rows, this turns them into numbers. Everything
// a ranker sees comes from here, and the vector is logged verbatim with each
// suggestion, so a learned ranker is trained on exactly what a ranker was given.
//
// Rules that keep the vector honest (MAINTENANCE-COMPLETION, 21 Oct 2026):
// coverage and assignments are what people recorded and nothing else. No region
// or trade is worked out from an address or a contractor's name, and a gap in
// what was recorded reads as unknown (null), never as "no".

import { SERVICE_REGIONS } from "../contractorCoverage";
import { normaliseAssetCategory } from "../assetRegister";
import { CERTIFICATE_WARNING_DAYS, certificateNotices, type InsuranceState } from "../complianceReport/insuranceEvidence";
import { addMonthsClamped, daysBetweenIso } from "../darwinDate";
import type { CertificateStatus, FeatureVector } from "./types";

/**
 * Bump this whenever a field's meaning, unit or window changes, or one is added
 * or removed. Logged on every set; the offline evaluation never mixes versions.
 */
export const FEATURE_SCHEMA_VERSION = "cs-features@1";

/** A certificate this close to expiry (or closer) is "expiring": the shared rule's window, as on the schedule warnings. */
export const EXPIRING_WITHIN_DAYS = CERTIFICATE_WARNING_DAYS;

const DARWIN_UTC_OFFSET = "+09:30"; // Darwin has no daylight saving.

const same = (a: string, b: string): boolean => a.trim().toLocaleLowerCase("en-AU") === b.trim().toLocaleLowerCase("en-AU");

/** The job's category in canonical spelling when it is a servicing trade; null for Common Areas, Tenancy Works and the like. */
export function canonicalTrade(category: string | null | undefined): string | null {
  return category ? normaliseAssetCategory(category) : null;
}

/** The building's recorded region when it is one of the three service regions. Source buildings carry "NT", which is not one. */
export function knownServiceRegion(region: string | null | undefined): string | null {
  return region ? (SERVICE_REGIONS.find((known) => same(known, region)) ?? null) : null;
}

/** The instant the 12-month window opens: midnight in Darwin, twelve calendar months before `today`. */
export function twelveMonthsAgo(today: string): Date {
  return new Date(`${addMonthsClamped(today, -12)}T00:00:00${DARWIN_UTC_OFFSET}`);
}

/** The Darwin calendar date of an instant, YYYY-MM-DD. */
function darwinDate(instant: Date): string {
  return new Date(instant.getTime() + 9.5 * 3_600_000).toISOString().slice(0, 10);
}

// ── Inputs ───────────────────────────────────────────────────────────────────

export interface CertificateRecord {
  /** Null: the certificate applies to every building. */
  buildingId: number | null;
  expiresOn: string | null;
  insuranceType: string | null;
  issuedOn: string | null;
}

export interface ContractorProfile {
  regions: readonly string[];
  trades: readonly string[];
}

/** A contractor engaged on a job through a purchase order or the job's approved quote. */
export interface Engagement {
  buildingId: number;
  category: string | null;
  createdAt: Date;
  /** When the job was done; null while it is not. */
  doneAt: Date | null;
  jobId: number;
}

export interface FeatureInputs {
  assignedToBuilding: boolean;
  buildingId: number;
  buildingRegion: string | null;
  certificates: readonly CertificateRecord[];
  engagements: readonly Engagement[];
  profile: ContractorProfile | null;
  /** Statuses of this contractor's quotes raised in the last 12 months. */
  quoteStatuses: readonly string[];
  since: Date;
  today: string;
  trade: string | null;
}

// ── Pieces ───────────────────────────────────────────────────────────────────

/** A trade or region is "covered" only against something recorded; nothing recorded is unknown. */
function listMatch(recorded: readonly string[] | undefined, wanted: string | null): boolean | null {
  if (wanted === null || !recorded || recorded.length === 0) return null;
  return recorded.some((entry) => same(entry, wanted));
}

const STATUS_SEVERITY: Record<CertificateStatus, number> = { expired: 4, missing: 3, expiring: 2, unknown: 1, valid: 0 };

/** The shared rule's name for how a kind of insurance reads, in the vector's own words. */
const STATUS_OF_STATE: Record<InsuranceState, CertificateStatus> = { expired: "expired", expiring: "expiring", missing: "missing", recorded: "valid", undated: "unknown" };

interface CertificateState {
  daysToExpiry: number | null;
  status: CertificateStatus;
}

/**
 * The contractor's certificates of currency as they stand on `today` for this building,
 * read by the one rule the Compliance report and the schedule warnings use
 * (complianceReport/insuranceEvidence.ts, pinned by the vectors both repos share): each
 * insurance type is judged on its own, and the worst decides the status. The days are to
 * the earliest recorded expiry of a certificate in effect.
 */
export function certificateState(certificates: readonly CertificateRecord[], buildingId: number, today: string): CertificateState {
  let worst: CertificateStatus = "valid";
  let earliestExpiry: string | null = null;
  for (const notice of certificateNotices(certificates, today, buildingId)) {
    const status = STATUS_OF_STATE[notice.state];
    if (STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) worst = status;
    // A certificate not yet in effect reads as missing and says nothing about when cover ends.
    const expiry = notice.state === "missing" ? null : notice.document?.expiresOn;
    if (expiry && (earliestExpiry === null || expiry < earliestExpiry)) earliestExpiry = expiry;
  }
  return { daysToExpiry: earliestExpiry === null ? null : daysBetweenIso(today, earliestExpiry), status: worst };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

const round = (value: number, places: number): number => Math.round(value * 10 ** places) / 10 ** places;

/** Accepted and rejected quotes decide acceptance; pending and in-approval ones say nothing yet. */
export function quoteFigures(statuses: readonly string[]): { accepted: number; decided: number; rate: number | null } {
  const accepted = statuses.filter((status) => status === "approved" || status === "completed").length;
  const decided = accepted + statuses.filter((status) => status === "rejected").length;
  return { accepted, decided, rate: decided === 0 ? null : round(accepted / decided, 3) };
}

// ── The vector ───────────────────────────────────────────────────────────────

export function buildFeatureVector(input: FeatureInputs): FeatureVector {
  const { buildingId, since, today, trade } = input;
  const jobs = new Map<number, Engagement>();
  for (const engagement of input.engagements) jobs.set(engagement.jobId, engagement);
  const engaged = [...jobs.values()];

  const here = engaged.filter((job) => job.buildingId === buildingId);
  const lastHere = here.reduce<Date | null>((latest, job) => (latest === null || job.createdAt > latest ? job.createdAt : latest), null);
  const doneRecently = engaged.filter((job): job is Engagement & { doneAt: Date } => job.doneAt !== null && job.doneAt >= since);
  const quotes = quoteFigures(input.quoteStatuses);
  const certificate = certificateState(input.certificates, buildingId, today);
  const completionDays = median(doneRecently.map((job) => Math.max(0, (job.doneAt.getTime() - job.createdAt.getTime()) / 86_400_000)));

  return {
    assignedToBuilding: trade !== null && input.assignedToBuilding,
    certificateDaysToExpiry: certificate.daysToExpiry,
    certificateStatus: certificate.status,
    daysSinceLastJobHere: lastHere === null ? null : Math.max(0, daysBetweenIso(darwinDate(lastHere), today)),
    jobsHere12m: here.filter((job) => job.createdAt >= since).length,
    jobsTrade12m: trade === null ? 0 : engaged.filter((job) => job.createdAt >= since && canonicalTrade(job.category) === trade).length,
    medianDaysToComplete12m: completionDays === null ? null : round(completionDays, 1),
    quoteAcceptanceRate12m: quotes.rate,
    quotesAccepted12m: quotes.accepted,
    quotesDecided12m: quotes.decided,
    regionMatch: listMatch(input.profile?.regions, input.buildingRegion),
    tradeCovered: listMatch(input.profile?.trades, trade),
  };
}

/** The contractors a building's coverage plan names for `trade` (migration 155). Case-insensitive on the trade; a bad row names nobody. */
export function assignedContractorIds(plan: unknown, trade: string | null): Set<number> {
  const ids = new Set<number>();
  if (trade === null || !Array.isArray(plan)) return ids;
  for (const row of plan) {
    if (!row || typeof row !== "object" || typeof (row as { trade?: unknown }).trade !== "string") continue;
    if (!same((row as { trade: string }).trade, trade)) continue;
    const list = (row as { contractorIds?: unknown }).contractorIds;
    if (Array.isArray(list)) for (const id of list) if (Number.isInteger(id)) ids.add(id as number);
  }
  return ids;
}
