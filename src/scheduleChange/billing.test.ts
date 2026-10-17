/// <reference types="jest" />
// WP26c: billing never bills a pending change. Pinned here for WP29b's run
// builder, which calls billableCharges.
import { billableCharges } from "./billing";
import type { PendingChangeItem } from "./pending";
import { tenancySchedule } from "./relief";

const r2 = (n: number) => Math.round(n * 100) / 100;
const STEPS = [
  { baseRentPerAnnum: 73000, effectiveFrom: "2025-01-01", id: "aaaaaaaa-0000-4000-8000-000000000001", methodKind: "commencement", ratePercent: 0 },
  { effectiveFrom: "2026-07-01", id: "aaaaaaaa-0000-4000-8000-000000000002", methodKind: "fixed", ratePercent: 10 },
];
const tenancy = (over: Record<string, unknown> = {}) => ({
  CarparkScheduleGroups: null,
  CpiCapPercent: null,
  CpiFloorPercent: null,
  MiscFees: null,
  RentPerAnnum: 73000,
  RentReliefs: null,
  ReviewRatchet: 0,
  ScheduledRateSteps: JSON.stringify(STEPS),
  ...over,
});
const pendingRelief: PendingChangeItem = { buildingId: 5, from: "2026-03-01", kind: "relief", requestId: "req-1", summary: "Rent relief", tenantId: 7, tenantName: "Acme", to: "2026-03-31" };
const pendingReview: PendingChangeItem = { buildingId: 5, from: "2026-03-15", kind: "rent_review", requestId: "rev-9", summary: "Rent review", tenantId: 7, tenantName: "Acme", to: null };

afterEach(() => {
  delete process.env.REVIEW_WORKFLOW_LIVE_FROM;
});

describe("billableCharges", () => {
  it("bills the lease's rent and lists a pending relief and a review awaiting approval without billing either", () => {
    const bill = billableCharges(tenancySchedule(tenancy(), 0), [pendingRelief, pendingReview], "2026-03-01", "2026-04-01");
    // 73,000 a year is 200 a day: 31 days.
    expect(bill.charged.rent).toBe(6200);
    expect(bill.lease.rent).toBe(6200);
    expect(bill.excluded.map((item) => item.requestId)).toEqual(["req-1", "rev-9"]);
  });

  it("applies a ratified relief on the days it covers, and only those", () => {
    const ratified = JSON.stringify([{ from: "2026-03-11", id: "rel-1", kind: "percent", scope: ["rent"], to: "2026-03-20", value: 50 }]);
    const bill = billableCharges(tenancySchedule(tenancy({ RentReliefs: ratified }), 0), [], "2026-03-01", "2026-04-01");
    // 10 days at 100 a day, 21 days at 200.
    expect(bill.charged.rent).toBe(r2(1000 + 4200));
    expect(bill.lease.rent).toBe(6200);
    expect(bill.slices.map((slice) => [slice.from, slice.to, slice.reliefIds])).toEqual([
      ["2026-03-01", "2026-03-11", []],
      ["2026-03-11", "2026-03-21", ["rel-1"]],
      ["2026-03-21", "2026-04-01", []],
    ]);
  });

  it("lists only the changes whose dates touch the period", () => {
    const bill = billableCharges(tenancySchedule(tenancy(), 0), [pendingRelief, pendingReview], "2026-04-01", "2026-05-01");
    expect(bill.excluded).toEqual([]);
  });

  it("bills the rent before a review row keyed ahead until a review applies it, once the workflow is live (M2)", () => {
    process.env.REVIEW_WORKFLOW_LIVE_FROM = "2026-01-01";
    const keyedAhead = billableCharges(tenancySchedule(tenancy(), 0), [], "2026-07-01", "2026-08-01");
    expect(keyedAhead.charged.rent).toBe(6200);
    delete process.env.REVIEW_WORKFLOW_LIVE_FROM;
    const keyedByHand = billableCharges(tenancySchedule(tenancy(), 0), [], "2026-07-01", "2026-08-01");
    expect(keyedByHand.charged.rent).toBe(r2((80300 * 31) / 365));
  });
});
