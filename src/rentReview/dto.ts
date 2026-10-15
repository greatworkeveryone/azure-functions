// The wire shape of a review instance (camelCase JSON, like the escalation
// endpoints) and the row it comes from. The frontend's src/types/rentReview.ts
// mirrors RentReviewDto.

import type { SqlRow } from "../db";
import { sqlDateToIso } from "../nextReviewDate";
import {
  isOverdue,
  RENT_REVIEW_STATES,
  type RentReviewMethod,
  type RentReviewState,
} from "../rentReviewMachine";
import { parseSteps, resolveScheduleAnnual } from "../scheduledRateStepLogic";
import { isoTimestamp, rowVersionHex } from "../tenancyScheduleWrite";
import { parseBasis, type RentReviewBasis } from "./basis";

export interface PersonStamp {
  at: string | null;
  name: string | null;
  userId: number | null;
}

export interface RentReviewDto {
  approval: (PersonStamp & { basis: string | null }) | null;
  basis: RentReviewBasis | null;
  billingConfirmed: { at: string | null; by: string | null } | null;
  /** The tenancy's building (from the tenancy, so a moved tenancy reads right). */
  buildingId: number | null;
  calc: RentReviewBasis | null;
  createdAt: string | null;
  /** Set while a CPI review waits for the index (WP26). */
  expectedIndexAt: string | null;
  method: RentReviewMethod | null;
  notice: { at: string | null; by: string | null; method: string | null } | null;
  /** Derived: open and the date has passed (Darwin). */
  overdue: boolean;
  ownerName: string | null;
  ownerUserId: number | null;
  prepared: PersonStamp | null;
  reviewId: string;
  scheduledFor: string;
  state: RentReviewState;
  stepId: string | null;
  submittedAt: string | null;
  tenantId: number;
  /** Trading name, else legal name. */
  tenantName: string;
  tenancyStatus: string | null;
  updatedAt: string | null;
  waiveReason: string | null;
  /** Hex of RentReviews.Version: writes send it back, a mismatch is a 409. */
  rowVersion: string;
}

const METHODS: ReadonlySet<string> = new Set(["cpi", "fixed", "market", "other"]);

const text = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

const whole = (value: unknown): number | null => {
  const n = value === null || value === undefined ? Number.NaN : Number(value);
  return Number.isInteger(n) ? n : null;
};

export function tenantDisplayName(row: SqlRow): string {
  return text(row.TradingName)?.trim() ?? text(row.LegalName)?.trim() ?? `Tenancy ${row.TenantId}`;
}

function stamp(userId: unknown, name: unknown, at: unknown): PersonStamp | null {
  const result: PersonStamp = { at: isoTimestamp(at), name: text(name), userId: whole(userId) };
  return result.at === null && result.name === null && result.userId === null ? null : result;
}

/** A review row as RENT_REVIEW_SELECT returns it. */
export function toReviewDto(row: SqlRow, today: string): RentReviewDto {
  const state = String(row.State) as RentReviewState;
  if (!RENT_REVIEW_STATES.includes(state)) throw new Error(`Review ${row.ReviewId} has an unknown state "${row.State}"`);
  const scheduledFor = sqlDateToIso(row.ScheduledFor) ?? "";
  const approval = stamp(row.ApprovedById, row.ApprovedByName, row.ApprovedAt);
  const noticeAt = isoTimestamp(row.NoticeIssuedAt);
  const noticeBy = text(row.NoticeIssuedBy);
  const noticeMethod = text(row.NoticeMethod);
  const billingAt = isoTimestamp(row.BillingConfirmedAt);
  const billingBy = text(row.BillingConfirmedBy);
  return {
    approval: approval ? { ...approval, basis: text(row.ApprovalBasis) } : null,
    basis: parseBasis(row.Basis),
    billingConfirmed: billingAt === null && billingBy === null ? null : { at: billingAt, by: billingBy },
    buildingId: whole(row.TenantBuildingId) ?? whole(row.BuildingId),
    calc: parseBasis(row.Calc),
    createdAt: isoTimestamp(row.CreatedAt),
    expectedIndexAt: sqlDateToIso(row.ExpectedIndexAt),
    method: METHODS.has(String(row.Method)) ? (row.Method as RentReviewMethod) : null,
    notice:
      noticeAt === null && noticeBy === null && noticeMethod === null
        ? null
        : { at: noticeAt, by: noticeBy, method: noticeMethod },
    overdue: isOverdue(state, scheduledFor, today),
    ownerName: text(row.OwnerName),
    ownerUserId: whole(row.OwnerUserId),
    prepared: stamp(row.PreparedById, row.PreparedByName, row.PreparedAt),
    reviewId: String(row.ReviewId),
    rowVersion: rowVersionHex(row.Version),
    scheduledFor,
    state,
    stepId: text(row.StepId),
    submittedAt: isoTimestamp(row.SubmittedAt),
    tenancyStatus: text(row.TenantStatus),
    tenantId: Number(row.TenantId),
    tenantName: tenantDisplayName(row),
    updatedAt: isoTimestamp(row.UpdatedAt),
    waiveReason: text(row.WaiveReason),
  };
}

// ── Tenancy summary ─────────────────────────────────────────────────────────

/** What the review workspace shows about the tenancy: names, the lease terms
 *  the review reads, today's rent. For tenancy viewers only (they can already
 *  read all of it in the register). */
export interface TenancySummaryDto {
  buildingId: number;
  buildingName: string | null;
  commencement: string | null;
  cpiCapPercent: number | null;
  cpiFloorPercent: number | null;
  cpiRegion: string | null;
  /** The rent in force today, from the schedule (Darwin date). */
  effectiveRentPerAnnum: number;
  expiry: string | null;
  fixedReviewPercent: number | null;
  lastReviewDate: string | null;
  legalName: string;
  reviewIntervalMonths: number | null;
  reviewRatchet: boolean;
  /** Tenants.ReviewType as typed on the lease. */
  reviewType: string | null;
  scheduleVersion: number;
  /** Tenants.Status as stored. */
  status: string;
  tenantId: number;
  tradingName: string | null;
}

const decimalOrNull = (value: unknown): number | null => {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

/** A tenancy row as store.loadTenancyForReview returns it, and the tenancy's total area. */
export function toTenancySummary(row: SqlRow, totalSqm: number, today: string): TenancySummaryDto {
  const rentPerAnnum = decimalOrNull(row.RentPerAnnum);
  const cpiCapPercent = decimalOrNull(row.CpiCapPercent);
  const cpiFloorPercent = decimalOrNull(row.CpiFloorPercent);
  const reviewRatchet = row.ReviewRatchet === true || row.ReviewRatchet === 1;
  const steps = parseSteps(row.ScheduledRateSteps as string | null | undefined);
  return {
    buildingId: Number(row.BuildingId),
    buildingName: text(row.BuildingName),
    commencement: sqlDateToIso(row.Commencement),
    cpiCapPercent,
    cpiFloorPercent,
    cpiRegion: text(row.CpiRegion),
    effectiveRentPerAnnum: resolveScheduleAnnual(steps, rentPerAnnum ?? 0, totalSqm, today, {
      cpiCapPercent,
      cpiFloorPercent,
      reviewRatchet,
    }).annual,
    expiry: sqlDateToIso(row.Expiry),
    fixedReviewPercent: decimalOrNull(row.FixedReviewPercent),
    lastReviewDate: sqlDateToIso(row.LastReviewDate),
    legalName: String(row.LegalName ?? ""),
    reviewIntervalMonths: whole(row.ReviewIntervalMonths),
    reviewRatchet,
    reviewType: text(row.ReviewType),
    scheduleVersion: Number(row.ScheduleVersion ?? 0),
    status: String(row.Status ?? ""),
    tenantId: Number(row.TenantId),
    tradingName: text(row.TradingName),
  };
}
