/// <reference types="jest" />
// WP26c (M2): every backend computation of a schedule takes REVIEW_WORKFLOW_LIVE_FROM
// with the lease's terms, so the register, the review workspace, the review
// maths and the rent cache agree about a review row keyed ahead.
import { toTenancySummary } from "../rentReview/dto";
import { scheduleOf } from "../rentReview/reviewTenancy";
import { scheduleTermsOf } from "../scheduleTerms";

const keyedAhead = JSON.stringify([
  { baseRentPerAnnum: 100000, effectiveFrom: "2024-07-01", id: "aaaaaaaa-0000-4000-8000-000000000001", methodKind: "commencement", ratePercent: 0 },
  { effectiveFrom: "2025-07-01", id: "aaaaaaaa-0000-4000-8000-000000000002", methodKind: "fixed", ratePercent: 3 },
]);
const tenancy = {
  BuildingId: 5,
  CpiCapPercent: 4,
  CpiFloorPercent: null,
  LegalName: "Acme",
  RentPerAnnum: 100000,
  ReviewRatchet: 1,
  ScheduleVersion: 3,
  ScheduledRateSteps: keyedAhead,
  Status: "current",
  TenantId: 7,
};

afterEach(() => {
  delete process.env.REVIEW_WORKFLOW_LIVE_FROM;
});

describe("scheduleTermsOf", () => {
  it("reads the lease's cap, floor and ratchet and the live date", () => {
    process.env.REVIEW_WORKFLOW_LIVE_FROM = "2025-01-01";
    expect(scheduleTermsOf(tenancy)).toEqual({ cpiCapPercent: 4, cpiFloorPercent: null, reviewRatchet: true, workflowLiveFrom: "2025-01-01" });
  });

  it("has no live date while the setting is unset or not a date", () => {
    expect(scheduleTermsOf({}).workflowLiveFrom).toBeNull();
    process.env.REVIEW_WORKFLOW_LIVE_FROM = "next week";
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(scheduleTermsOf({}).workflowLiveFrom).toBeNull();
  });
});

describe("the review's schedule and the workspace's rent today", () => {
  it("both hold a row keyed ahead for its review once the workflow is live", () => {
    process.env.REVIEW_WORKFLOW_LIVE_FROM = "2025-01-01";
    expect(scheduleOf(tenancy, [], 0).context.lease.workflowLiveFrom).toBe("2025-01-01");
    const summary = toTenancySummary(tenancy, 100, "2026-01-15");
    expect(summary.effectiveRentPerAnnum).toBe(100000);
    expect(summary.reviewWorkflowLiveFrom).toBe("2025-01-01");
  });

  it("read the keyed row as settled while it isn't", () => {
    expect(toTenancySummary(tenancy, 100, "2026-01-15").effectiveRentPerAnnum).toBe(103000);
  });
});
