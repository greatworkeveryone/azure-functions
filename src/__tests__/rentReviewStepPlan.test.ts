/// <reference types="jest" />
// Where a review lands on the schedule (rentReview/stepPlan.ts): the row it
// settles, how an approved rent is written so the engine reproduces it to the
// cent, when RentPerAnnum is only a cache, and how REVERT takes a review's
// writes back from the change log. Pure.
import {
  appliedStep,
  exactRate,
  placeStep,
  priorStep,
  rentPerAnnumIsCache,
  representStep,
  reviewRow,
  sameStep,
  simulate,
  stepChanges,
  undoChanges,
  waivedStep,
  type ScheduleContext,
} from "../rentReview/stepPlan";
import { diffSteps, type ScheduledRateStep, type ScheduleTerms } from "../scheduledRateStepLogic";

const COMMENCE: ScheduledRateStep = {
  baseRentPerAnnum: 100000,
  effectiveFrom: "2024-07-01",
  id: "00000000-0000-4000-8000-000000000001",
  methodKind: "commencement",
  ratePercent: 0,
};
const REVIEW: ScheduledRateStep = { effectiveFrom: "2025-07-01", id: "00000000-0000-4000-8000-000000000002", methodKind: "cpi", ratePercent: 0 };
const LATER: ScheduledRateStep = { effectiveFrom: "2026-07-01", id: "00000000-0000-4000-8000-000000000003", methodKind: "fixed", ratePercent: 3 };

const LEASE: ScheduleTerms = { cpiCapPercent: 5, cpiFloorPercent: 2, reviewRatchet: true };
const context = (steps: ScheduledRateStep[], lease: ScheduleTerms = LEASE): ScheduleContext => ({ fallbackAnnual: 0, fallbackSqm: 0, lease, steps });

describe("reviewRow: the row a review settles", () => {
  const target = { method: "cpi" as const, newStepId: "00000000-0000-4000-8000-0000000000aa", reviewId: "rev-1", scheduledFor: "2025-07-01", stepId: null };

  it("is the review row already dated on the review date", () => {
    expect(reviewRow([COMMENCE, REVIEW], target)).toMatchObject({ existing: REVIEW, ok: true });
  });

  it("prefers the linked step when it is still on the date", () => {
    const twin = { ...REVIEW, id: "00000000-0000-4000-8000-0000000000bb" };
    expect(reviewRow([COMMENCE, REVIEW, twin], { ...target, stepId: twin.id })).toMatchObject({ existing: twin });
  });

  it("is a new row on the date, ending where the next row starts, when there is none", () => {
    expect(reviewRow([COMMENCE, LATER], target)).toEqual({
      base: { effectiveFrom: "2025-07-01", effectiveTo: "2026-07-01", id: target.newStepId, methodKind: "cpi", ratePercent: 0 },
      existing: null,
      ok: true,
    });
  });

  it("is refused when another review already settled the row", () => {
    const settled = { ...REVIEW, resolution: "applied" as const, reviewId: "rev-0" };
    expect(reviewRow([COMMENCE, settled], target)).toMatchObject({ ok: false, reason: "step_settled" });
    expect(reviewRow([COMMENCE, { ...settled, reviewId: "rev-1" }], target)).toMatchObject({ ok: true });
  });
});

describe("placeStep writes a row the way upsertScheduledRateStep does", () => {
  it("adds a row and closes the open-ended row before it on its date", () => {
    const added = { ...REVIEW, id: "00000000-0000-4000-8000-0000000000aa" };
    const placed = placeStep([COMMENCE], added);
    expect(placed.closed).toEqual({ after: { ...COMMENCE, effectiveTo: "2025-07-01" }, before: COMMENCE });
    expect(placed.steps).toEqual([{ ...COMMENCE, effectiveTo: "2025-07-01" }, added]);
  });

  it("updates a row in place and closes nothing", () => {
    const placed = placeStep([COMMENCE, REVIEW], { ...REVIEW, ratePercent: 4 });
    expect(placed.closed).toBeNull();
    expect(placed.steps[1].ratePercent).toBe(4);
  });
});

describe("waivedStep and appliedStep", () => {
  it("a waived row keeps the rent where it was", () => {
    const { row } = simulate(context([COMMENCE, REVIEW]), waivedStep(REVIEW, "rev-1"));
    expect(row).toMatchObject({ annual: 100000, factor: 1, pending: false });
    expect(row?.step).toMatchObject({ resolution: "waived", reviewId: "rev-1" });
  });

  it("an applied row written as a rate drops any index pair the row carried", () => {
    const keyed = { ...REVIEW, cpiValue: 110, cpiValuePrev: 100 };
    expect(appliedStep(keyed, "rev-1", { methodKind: "other", ratePercent: 2 })).toEqual({
      effectiveFrom: "2025-07-01",
      id: REVIEW.id,
      methodKind: "other",
      ratePercent: 2,
      resolution: "applied",
      reviewId: "rev-1",
    });
  });
});

describe("representStep: how an approved rent is written", () => {
  const base = REVIEW;
  const represent = (target: number, over: Partial<Parameters<typeof representStep>[0]> = {}) =>
    representStep({
      base,
      context: context([COMMENCE, REVIEW]),
      cpi: { current: 103, previous: 100 },
      currentAnnual: 100000,
      method: "cpi",
      naturalRate: 3,
      reviewId: "rev-1",
      target,
      ...over,
    });

  it("writes a computed CPI result as the CPI row it is, both index values on it", () => {
    const result = represent(103000);
    expect(result).toMatchObject({ ok: true, representation: "natural" });
    if (!result.ok) return;
    expect(result.step).toMatchObject({ cpiValue: 103, cpiValuePrev: 100, methodKind: "cpi", resolution: "applied", reviewId: "rev-1" });
    expect(result.row.annual).toBe(103000);
  });

  it("writes an override inside the lease's bounds as a CPI rate the engine reproduces", () => {
    const result = represent(102500);
    expect(result).toMatchObject({ ok: true, representation: "method_rate" });
    if (!result.ok) return;
    expect(result.step.cpiValue).toBeUndefined();
    expect(result.step.cpiValuePrev).toBe(100);
    expect(result.step.methodKind).toBe("cpi");
    expect(result.row.annual).toBe(102500);
  });

  it("writes an override below the lease's floor as an `other` rate, which nothing clamps, keeping the index pair for the record", () => {
    // The lease floors CPI at 2%; the agreed rent is a 1% rise.
    const result = represent(101000);
    expect(result).toMatchObject({ ok: true, representation: "other_rate" });
    if (!result.ok) return;
    expect(result.step).toMatchObject({ cpiValue: 103, cpiValuePrev: 100, methodKind: "other" });
    expect(result.row.annual).toBe(101000);
  });

  it("can't write a decrease on a ratchet lease at all (the caller refuses it first)", () => {
    expect(represent(99000)).toEqual({ ok: false });
  });

  it("writes a decrease when the lease has no ratchet", () => {
    const result = represent(99000, { context: context([COMMENCE, REVIEW], { cpiCapPercent: null, cpiFloorPercent: null, reviewRatchet: false }) });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) expect(result.row.annual).toBe(99000);
  });

  it("writes a fixed review at its own % when that is the result", () => {
    const result = represent(104000, { cpi: null, method: "fixed", naturalRate: 4 });
    expect(result).toMatchObject({ ok: true, representation: "natural" });
    if (result.ok) expect(result.step).toMatchObject({ methodKind: "fixed", ratePercent: 4 });
  });

  it("writes a manual (`other`) rent as an exact rate", () => {
    const result = represent(107777.77, { cpi: null, method: "other", naturalRate: 0 });
    expect(result).toMatchObject({ ok: true, representation: "other_rate" });
    if (result.ok) expect(result.row.annual).toBe(107777.77);
  });

  it("reproduces any cent-exact rent on an awkward schedule (area, an earlier CPI row, a later row)", () => {
    const withArea = { ...COMMENCE, baseRentPerAnnum: 98765.43, sqm: 333.3 };
    const earlier = { cpiValue: 101.7, cpiValuePrev: 99.3, effectiveFrom: "2024-10-01", id: "00000000-0000-4000-8000-0000000000e1", methodKind: "cpi" as const, ratePercent: 0, resolution: "applied" as const };
    const ctx = context([withArea, earlier, REVIEW, LATER], { cpiCapPercent: null, cpiFloorPercent: null, reviewRatchet: false });
    const current = simulate(ctx, waivedStep(REVIEW, "rev-1")).row?.annual as number;
    for (const delta of [0.01, 0.37, 13.13, 1234.56, 4321.09, -77.77]) {
      const target = Math.round((current + delta) * 100) / 100;
      const result = representStep({ base: REVIEW, context: ctx, cpi: null, currentAnnual: current, method: "other", naturalRate: 0, reviewId: "rev-1", target });
      expect(result).toMatchObject({ ok: true });
      if (result.ok) expect(result.row.annual).toBe(target);
    }
  });
});

describe("exactRate", () => {
  it("is null when the lease clamps every rate away from the target", () => {
    const make = (ratePercent: number) => appliedStep(REVIEW, "rev-1", { methodKind: "cpi", ratePercent });
    // A 9% rise on a lease capped at 5% can't be a CPI row.
    expect(exactRate(context([COMMENCE, REVIEW]), make, 100000, 109000)).toBeNull();
  });
});

describe("rentPerAnnumIsCache", () => {
  it("is true only when a commencement row carries its own starting rent first", () => {
    expect(rentPerAnnumIsCache([COMMENCE, REVIEW])).toBe(true);
    expect(rentPerAnnumIsCache([REVIEW, COMMENCE])).toBe(true); // sorted by date first
    expect(rentPerAnnumIsCache([{ ...COMMENCE, baseRentPerAnnum: undefined }, REVIEW])).toBe(false);
    expect(rentPerAnnumIsCache([REVIEW])).toBe(false);
    expect(rentPerAnnumIsCache([])).toBe(false);
  });
});

describe("stepChanges: everything a write changed goes in the change log", () => {
  it("lists an added row first (the review's own), then the row it closed, and nothing that didn't change", () => {
    const added = { ...REVIEW, id: "00000000-0000-4000-8000-0000000000aa" };
    const placed = placeStep([COMMENCE, LATER], added);
    expect(stepChanges([COMMENCE, LATER], placed.steps, added.id)).toEqual([
      { after: added, before: null, kind: "added" },
      { after: { ...COMMENCE, effectiveTo: "2025-07-01" }, before: COMMENCE, kind: "updated" },
    ]);
  });

  it("is empty when nothing changed", () => {
    expect(stepChanges([COMMENCE, REVIEW], [COMMENCE, REVIEW], REVIEW.id)).toEqual([]);
  });
});

describe("undoChanges: REVERT from the change log", () => {
  const added = appliedStep({ ...REVIEW, id: "00000000-0000-4000-8000-0000000000aa", effectiveTo: "2026-07-01" }, "rev-1", { methodKind: "fixed", ratePercent: 3 });
  const closedBefore = COMMENCE;
  const closedAfter = { ...COMMENCE, effectiveTo: "2025-07-01" };

  it("removes a row the review added and reopens the row it closed", () => {
    const steps = [closedAfter, added, LATER];
    const changes = [
      { changeKind: "added" as const, diff: null, snapshot: added, stepId: added.id },
      { changeKind: "updated" as const, diff: diffSteps(closedBefore, closedAfter), snapshot: closedAfter, stepId: COMMENCE.id },
    ];
    const result = undoChanges(steps, changes);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.steps).toEqual([COMMENCE, LATER]);
      expect(result.restored.map((r) => [r.stepId, r.after === null])).toEqual([
        [COMMENCE.id, false],
        [added.id, true],
      ]);
    }
  });

  it("gives an updated row its earlier values back, removing fields it didn't have", () => {
    const applied = appliedStep(REVIEW, "rev-1", { cpiValue: 103, cpiValuePrev: 100, methodKind: "cpi", ratePercent: 3 });
    const change = { changeKind: "updated" as const, diff: diffSteps(REVIEW, applied), snapshot: applied, stepId: REVIEW.id };
    expect(priorStep(change)).toEqual(REVIEW);
    const result = undoChanges([COMMENCE, applied], [change]);
    expect(result).toEqual({ ok: true, restored: [{ after: REVIEW, before: applied, stepId: REVIEW.id }], steps: [COMMENCE, REVIEW] });
  });

  it("refuses when a row the review wrote has been edited since", () => {
    const applied = appliedStep(REVIEW, "rev-1", { methodKind: "fixed", ratePercent: 3 });
    const change = { changeKind: "updated" as const, diff: diffSteps(REVIEW, applied), snapshot: applied, stepId: REVIEW.id };
    expect(undoChanges([COMMENCE, { ...applied, note: "edited by hand" }], [change])).toEqual({ ok: false, stepId: REVIEW.id });
    expect(undoChanges([COMMENCE], [change])).toEqual({ ok: false, stepId: REVIEW.id });
  });

  it("compares steps by value, whatever the key order", () => {
    expect(sameStep({ effectiveFrom: "2025-07-01", id: "x", ratePercent: 1 }, { id: "x", ratePercent: 1, effectiveFrom: "2025-07-01" })).toBe(true);
    expect(sameStep({ effectiveFrom: "2025-07-01", id: "x", ratePercent: 1 }, { effectiveFrom: "2025-07-01", id: "x", ratePercent: 2 })).toBe(false);
  });
});
