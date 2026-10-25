// A signed-off Darwin CPI lease with a rent review in progress, for the WP26
// endpoint tests: a commencement row two years before the review (120,000 a
// year), last year's review applied at 100 / 97, and this year's CPI row on the
// review date. The review date is 20 days ago (Darwin), so it is overdue and
// carries arrears; the CPI pair is published unless a test takes it away. Every
// date is relative to today.

import { addDaysIso, addMonthsClamped, todayInDarwin } from "../../darwinDate";
import { previousQuarter, referenceQuarter } from "../../rentReview/cpi";
import type { ReviewWorld } from "./rentReviewWorld";

export const TODAY = todayInDarwin();
export const REVIEW_DATE = addDaysIso(TODAY, -20);
export const LAST_YEAR = addMonthsClamped(REVIEW_DATE, -12);
export const COMMENCED = addMonthsClamped(REVIEW_DATE, -24);
export const NEXT_ANNIVERSARY = addMonthsClamped(REVIEW_DATE, 12);
export const REFERENCE = referenceQuarter(REVIEW_DATE);
export const PREVIOUS = previousQuarter(REFERENCE, 12);
export const BASE = "Sep 2025 = 100.0";

export const STEP_IDS = {
  commencement: "aaaaaaaa-0000-4000-8000-000000000001",
  lastYear: "aaaaaaaa-0000-4000-8000-000000000002",
  review: "aaaaaaaa-0000-4000-8000-000000000003",
} as const;

export const PEOPLE = {
  ada: { kind: "user", name: "Ada Admin", role: "admin", userId: 11 },
  ann: { kind: "user", name: "Ann Accounts", role: "accounts", userId: 7 },
  bo: { kind: "user", name: "Bo Manager", role: "accounts_manager", userId: 8 },
  cy: { kind: "user", name: "Cy Finance", role: "cfo", userId: 9 },
  dee: { kind: "user", name: "Dee Director", role: "director", userId: 10 },
} as const;

export type Person = (typeof PEOPLE)[keyof typeof PEOPLE];

export function steps(over: { review?: Record<string, unknown> | null } = {}): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = [
    { baseRentPerAnnum: 120000, effectiveFrom: COMMENCED, effectiveTo: LAST_YEAR, id: STEP_IDS.commencement, methodKind: "commencement", ratePercent: 0 },
    { cpiValue: 100, cpiValuePrev: 97, effectiveFrom: LAST_YEAR, effectiveTo: REVIEW_DATE, id: STEP_IDS.lastYear, methodKind: "cpi", ratePercent: 3.0928, resolution: "applied" },
  ];
  if (over.review !== null) rows.push({ effectiveFrom: REVIEW_DATE, id: STEP_IDS.review, methodKind: "cpi", ratePercent: 0, ...(over.review ?? {}) });
  return rows;
}

export function tenantRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ArchivedAt: null,
    BuildingId: 5,
    CarparkScheduleGroups: null,
    Commencement: COMMENCED,
    CpiCapPercent: 5,
    CpiFloorPercent: 1,
    CpiRegion: "DARWIN",
    Expiry: addMonthsClamped(REVIEW_DATE, 36),
    FixedReviewPercent: null,
    LastReviewDate: LAST_YEAR,
    LastReviewIncreasePercent: 3.0928,
    LegalName: "Acme Pty Ltd",
    MiscFees: null,
    NextReviewDate: REVIEW_DATE,
    RentPerAnnum: 123711.34,
    ReviewIntervalMonths: 12,
    ReviewRatchet: true,
    ReviewType: "CPI Darwin (June)",
    ScheduleSignOffNote: null,
    ScheduleSignedOffAt: new Date("2026-09-01T00:00:00Z"),
    ScheduleSignedOffById: "oid-bo",
    ScheduleSignedOffByName: "Bo Manager",
    ScheduleVersion: 4,
    ScheduledRateSteps: JSON.stringify(steps()),
    Status: "current",
    TenantId: 7,
    TradingName: null,
    UpdatedAt: new Date("2026-09-01T00:00:00Z"),
    UpdatedById: "seed",
    UpdatedByName: "seed",
    ...over,
  };
}

export function basis(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capPercent: 5,
    floorPercent: 1,
    intervalMonths: 12,
    method: "cpi",
    ratchet: true,
    referenceQuarterRule: "quarter_before_review_date",
    region: "DARWIN",
    reviewDate: REVIEW_DATE,
    reviewType: "CPI Darwin (June)",
    ...over,
  };
}

export function reviewRow(world: ReviewWorld, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ApprovalBasis: null,
    ApprovedAt: null,
    ApprovedById: null,
    ApprovedByName: null,
    Basis: JSON.stringify(basis()),
    BillingConfirmedAt: null,
    BillingConfirmedBy: null,
    BuildingId: 5,
    Calc: null,
    CpiBaseValue: null,
    CpiCurrentValue: null,
    CpiIndexUsed: null,
    CreatedAt: new Date("2026-06-01T00:00:00Z"),
    ExpectedIndexAt: null,
    IncreasePercent: null,
    Method: "cpi",
    NewRentPerAnnum: null,
    NoticeIssuedAt: null,
    NoticeIssuedBy: null,
    NoticeMethod: null,
    OldRentPerAnnum: null,
    OwnerUserId: 7,
    PreparedAt: null,
    PreparedById: null,
    PreparedByName: null,
    ReviewId: "rev-1",
    ReviewType: "cpi",
    ScheduledFor: REVIEW_DATE,
    State: "in_progress",
    Status: "due",
    StepId: STEP_IDS.review,
    SubmittedAt: null,
    TenantId: 7,
    UpdatedAt: new Date("2026-06-01T00:00:00Z"),
    Version: world.nextVersion(),
    WaiveReason: null,
    ...over,
  };
}

/** The world for one test: the tenancy, its review, and the CPI pair (3.2% unless given). */
export function seed(
  world: ReviewWorld,
  over: { cpi?: [number, number] | null; review?: Record<string, unknown>; tenant?: Record<string, unknown> } = {},
): void {
  world.state.tenants.push(tenantRow(over.tenant));
  world.state.reviews.push(reviewRow(world, over.review));
  world.state.occupancySqm[7] = 400;
  if (over.cpi !== null) {
    const [previous, current] = over.cpi ?? [100, 103.2];
    world.state.cpi.push(
      { IndexValue: previous, Period: PREVIOUS, ReferenceBase: BASE, Region: "DARWIN" },
      { IndexValue: current, Period: REFERENCE, ReferenceBase: BASE, Region: "DARWIN" },
    );
  }
}

export const versionOf = (world: ReviewWorld, reviewId = "rev-1"): string => String(world.review(reviewId).Version);
