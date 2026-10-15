/// <reference types="jest" />
// C2: the method comes from the schedule step's methodKind, else the tenancy's
// free-text review type read with mapMethodKind, else "other".
import { METHOD_RULE_APPLIED, resolveReviewMethod, stepOnDate } from "../rentReview/method";
import type { ScheduledRateStep } from "../scheduledRateStepLogic";

const step = (over: Partial<ScheduledRateStep> = {}): ScheduledRateStep => ({
  effectiveFrom: "2027-07-01",
  id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  ratePercent: 3,
  ...over,
});

describe("resolveReviewMethod", () => {
  it("takes the step's methodKind first", () => {
    expect(resolveReviewMethod({ reviewType: "Fixed 3%", step: step({ methodKind: "cpi" }) })).toEqual({
      method: "cpi",
      source: "step",
    });
    expect(resolveReviewMethod({ reviewType: null, step: step({ methodKind: "market" }) })).toEqual({
      method: "market",
      source: "step",
    });
    expect(resolveReviewMethod({ reviewType: "CPI", step: step({ methodKind: "other" }) })).toEqual({
      method: "other",
      source: "step",
    });
  });

  it("falls back to the tenancy's review type, however it is spelled", () => {
    for (const [reviewType, method] of [
      ["CPI Darwin (June)", "cpi"],
      ["Fixed", "fixed"],
      ["Market on Expiry", "market"],
      ["fixedPercent", "fixed"],
      ["marketReview", "market"],
      ["cpi", "cpi"],
    ] as const) {
      expect(resolveReviewMethod({ reviewType, step: null })).toEqual({ method, source: "review_type" });
    }
  });

  it("uses the review type when the step names no method", () => {
    expect(resolveReviewMethod({ reviewType: "Fixed 3%", step: step() })).toEqual({ method: "fixed", source: "review_type" });
  });

  it("does not take a commencement row for a review method", () => {
    expect(resolveReviewMethod({ reviewType: "Fixed 3%", step: step({ methodKind: "commencement" }) })).toEqual({
      method: "fixed",
      source: "review_type",
    });
    expect(resolveReviewMethod({ reviewType: "Lease commencement", step: null })).toEqual({
      method: "other",
      source: "fallback",
    });
  });

  it("ends at other when nothing says otherwise, and never refuses", () => {
    for (const reviewType of ["none", "", "   ", "Special arrangement", null, undefined]) {
      expect(resolveReviewMethod({ reviewType, step: null })).toEqual({ method: "other", source: "fallback" });
    }
  });

  it("names a ledger rule for each way the method was found", () => {
    expect(METHOD_RULE_APPLIED).toEqual({
      fallback: "method_other_fallback",
      review_type: "method_from_review_type",
      step: "method_from_step",
    });
    for (const rule of Object.values(METHOD_RULE_APPLIED)) expect(rule.length).toBeLessThanOrEqual(64);
  });
});

describe("stepOnDate", () => {
  const steps = [
    step({ effectiveFrom: "2026-07-01", id: "11111111-1111-1111-1111-111111111111", methodKind: "commencement" }),
    step({ effectiveFrom: "2027-07-01", id: "22222222-2222-2222-2222-222222222222", methodKind: "cpi" }),
    step({ effectiveFrom: "2028-07-01", id: "33333333-3333-3333-3333-333333333333" }),
  ];

  it("finds the review step dated that day", () => {
    expect(stepOnDate(steps, "2027-07-01")?.id).toBe("22222222-2222-2222-2222-222222222222");
    expect(stepOnDate(steps, "2028-07-01")?.id).toBe("33333333-3333-3333-3333-333333333333");
  });

  it("ignores a commencement row and a day with no step", () => {
    expect(stepOnDate(steps, "2026-07-01")).toBeNull();
    expect(stepOnDate(steps, "2029-07-01")).toBeNull();
    expect(stepOnDate([], "2027-07-01")).toBeNull();
  });
});
