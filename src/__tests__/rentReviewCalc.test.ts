/// <reference types="jest" />
// The rent review calculation (PLAN §3.2, WP26): cap, floor and ratchet in the
// engine's order, the same-base CPI pair (a rebase never mixes bases), the
// receipt agreeing with the schedule engine to the cent, the cascade, arrears,
// the sanity band, and the fixed and manual methods. Pure.
import {
  boundFactor,
  calculateReview,
  computeArrears,
  DEFAULT_SANITY,
  leaseDepartures,
  parseCalc,
  sanityBandFromEnv,
  sanityOf,
  type CalcInput,
  type RentReviewCalc,
} from "../rentReviewCalc";
import type { CpiIndexRow } from "../rentReview/cpi";
import { computeScheduleRows, type ScheduledRateStep } from "../scheduledRateStepLogic";
import { appliedStep, simulate } from "../rentReview/stepPlan";

const COMMENCE: ScheduledRateStep = {
  baseRentPerAnnum: 120000,
  effectiveFrom: "2024-07-01",
  effectiveTo: "2025-07-01",
  id: "00000000-0000-4000-8000-000000000001",
  methodKind: "commencement",
  ratePercent: 0,
};
const LAST_YEAR: ScheduledRateStep = {
  cpiValue: 100,
  cpiValuePrev: 97,
  effectiveFrom: "2025-07-01",
  effectiveTo: "2026-07-01",
  id: "00000000-0000-4000-8000-000000000002",
  methodKind: "cpi",
  ratePercent: 3.0928,
  resolution: "applied",
};
const REVIEW_STEP: ScheduledRateStep = {
  effectiveFrom: "2026-07-01",
  id: "00000000-0000-4000-8000-000000000003",
  methodKind: "cpi",
  ratePercent: 0,
};
const NEW_ID = "00000000-0000-4000-8000-0000000000ff";

const rows = (indexes: Record<string, [number, string | null]>): CpiIndexRow[] =>
  Object.entries(indexes).map(([period, [indexValue, referenceBase]]) => ({ indexValue, period, referenceBase }));

const BASE = "Sep 2025 = 100.0";

function input(over: Partial<CalcInput> = {}): CalcInput {
  return {
    basis: { capPercent: 5, floorPercent: 1, intervalMonths: 12, method: "cpi", ratchet: true, region: "DARWIN", reviewDate: "2026-07-01" },
    carparkGroups: [],
    computedAt: "2026-07-20T01:00:00.000Z",
    computedBy: { name: "Ann Accounts", userId: 7 },
    cpiRows: rows({ "2025-Q2": [100, BASE], "2026-Q2": [103.2, BASE] }),
    fallbackAnnual: 0,
    fallbackSqm: 400,
    lease: { cpiCapPercent: 5, cpiFloorPercent: 1, reviewRatchet: true },
    method: "cpi",
    miscFees: [],
    newStepId: NEW_ID,
    reviewId: "rev-1",
    sanity: { ...DEFAULT_SANITY },
    scheduledFor: "2026-07-01",
    scheduleVersion: 4,
    stepId: REVIEW_STEP.id,
    steps: [COMMENCE, LAST_YEAR, REVIEW_STEP],
    today: "2026-07-20",
    ...over,
  };
}

function calcOf(over: Partial<CalcInput> = {}): RentReviewCalc {
  const result = calculateReview(input(over));
  if (result.kind !== "calc") throw new Error(`expected a calc, got ${JSON.stringify(result)}`);
  return result.calc;
}

describe("boundFactor: ratio → clamp(1 + floor, 1 + cap) → ratchet", () => {
  it("leaves a ratio inside the bounds alone", () => {
    expect(boundFactor(1.032, { capPercent: 5, floorPercent: 1, ratchet: true })).toEqual({ clampedBy: null, factor: 1.032, ratcheted: false });
  });

  it("caps, floors and ratchets", () => {
    expect(boundFactor(1.08, { capPercent: 5, floorPercent: 1, ratchet: true })).toEqual({ clampedBy: "cap", factor: 1.05, ratcheted: false });
    expect(boundFactor(1.002, { capPercent: 5, floorPercent: 1, ratchet: true })).toEqual({ clampedBy: "floor", factor: 1.01, ratcheted: false });
    expect(boundFactor(0.98, { capPercent: null, floorPercent: null, ratchet: true })).toEqual({ clampedBy: null, factor: 1, ratcheted: true });
    expect(boundFactor(0.98, { capPercent: null, floorPercent: null, ratchet: false })).toEqual({ clampedBy: null, factor: 0.98, ratcheted: false });
  });

  it("applies the floor before the cap, as the schedule engine does", () => {
    // A floor above the cap can't be saved on a basis; if it were, the cap would win.
    expect(boundFactor(1.0, { capPercent: 2, floorPercent: 4, ratchet: false })).toMatchObject({ clampedBy: "cap", factor: 1.02 });
  });

  it("lets a negative floor through a fall, and the ratchet then holds it at no decrease", () => {
    expect(boundFactor(0.97, { capPercent: null, floorPercent: -2, ratchet: false }).factor).toBeCloseTo(0.98, 12);
    expect(boundFactor(0.97, { capPercent: null, floorPercent: -2, ratchet: true })).toMatchObject({ factor: 1, ratcheted: true });
  });
});

describe("computeArrears: from the review date to today, pro rata by day", () => {
  it("is null before the date has passed, or when the rent doesn't change", () => {
    expect(computeArrears("2026-07-01", "2026-07-01", 120000, 123840)).toBeNull();
    expect(computeArrears("2026-07-01", "2026-06-20", 120000, 123840)).toBeNull();
    expect(computeArrears("2026-07-01", "2026-09-01", 120000, 120000)).toBeNull();
  });

  it("owes the difference for the days passed (the end is exclusive, like a schedule row)", () => {
    // 1 Jul to 1 Oct is 92 days.
    expect(computeArrears("2026-07-01", "2026-10-01", 120000, 123650)).toEqual({
      amount: 920,
      from: "2026-07-01",
      lines: [{ amount: 920, kind: "rent", label: "Rent" }],
      months: 3.02,
      to: "2026-10-01",
    });
  });

  it("gives a credit when the rent goes down", () => {
    expect(computeArrears("2026-07-01", "2026-08-01", 120000, 117600)?.amount).toBe(-203.84);
  });
});

describe("the sanity band (C5)", () => {
  it("defaults to −5% … +15%", () => {
    expect(sanityBandFromEnv({})).toEqual({ maxPercent: 15, minPercent: -5 });
  });

  it("reads REVIEW_SANITY_MIN_PERCENT and REVIEW_SANITY_MAX_PERCENT", () => {
    expect(sanityBandFromEnv({ REVIEW_SANITY_MAX_PERCENT: "8", REVIEW_SANITY_MIN_PERCENT: "0" })).toEqual({ maxPercent: 8, minPercent: 0 });
  });

  it("falls back to the default for a value that isn't a percentage, or a min above the max", () => {
    expect(sanityBandFromEnv({ REVIEW_SANITY_MAX_PERCENT: "lots", REVIEW_SANITY_MIN_PERCENT: "-500" })).toEqual({ maxPercent: 15, minPercent: -5 });
    expect(sanityBandFromEnv({ REVIEW_SANITY_MAX_PERCENT: "2", REVIEW_SANITY_MIN_PERCENT: "3" })).toEqual({ maxPercent: 15, minPercent: -5 });
  });

  it("is inclusive at both ends", () => {
    expect(sanityOf(15, DEFAULT_SANITY).inBand).toBe(true);
    expect(sanityOf(-5, DEFAULT_SANITY).inBand).toBe(true);
    expect(sanityOf(15.0001, DEFAULT_SANITY).inBand).toBe(false);
    expect(sanityOf(-5.0001, DEFAULT_SANITY).inBand).toBe(false);
  });
});

describe("a CPI review", () => {
  it("reads the reference quarter (June, before a 1 July review) and the one a year before, and works out the new rent", () => {
    const calc = calcOf();
    expect(calc.cpi).toEqual({
      current: 103.2,
      previous: 100,
      previousQuarter: "2025-Q2",
      ratio: 1.032,
      rawPercent: 3.2,
      referenceBase: BASE,
      referenceQuarter: "2026-Q2",
      region: "DARWIN",
    });
    expect(calc.bounds).toEqual({ capPercent: 5, clampedBy: null, floorPercent: 1, ratchet: true, ratcheted: false });
    // Last year's row took 120,000 to 123,711.34 (100 / 97); this one adds 3.2%.
    expect(calc.currentAnnual).toBe(123711.34);
    expect(calc.newAnnual).toBe(127670.1);
    expect(calc.appliedPercent).toBe(3.2);
    expect(calc.perMonth).toBe(Math.round((127670.1 / 12) * 100) / 100);
    // No area on the schedule: the tenancy's own area is the $/m² fallback, as the register shows it.
    expect(calc.perSqm).toBe(Math.round((127670.1 / 400) * 100) / 100);
    expect(calc).toMatchObject({ method: "cpi", scheduleVersion: 4, computedAt: "2026-07-20T01:00:00.000Z" });
    expect(calc.sanity).toEqual({ inBand: true, maxPercent: 15, minPercent: -5 });
  });

  it("agrees with the schedule engine to the cent once the row is written the way APPLY writes it", () => {
    const calc = calcOf();
    const written = appliedStep(REVIEW_STEP, "rev-1", { cpiValue: 103.2, cpiValuePrev: 100, methodKind: "cpi", ratePercent: 3.2 });
    const engine = computeScheduleRows([COMMENCE, LAST_YEAR, written], 0, 400, { cpiCapPercent: 5, cpiFloorPercent: 1, reviewRatchet: true });
    expect(engine.at(-1)?.annual).toBe(calc.newAnnual);
  });

  it("caps an index rise above the cap, and says so", () => {
    const calc = calcOf({ cpiRows: rows({ "2025-Q2": [100, BASE], "2026-Q2": [108, BASE] }) });
    expect(calc.cpi?.rawPercent).toBe(8);
    expect(calc.bounds).toMatchObject({ clampedBy: "cap", ratcheted: false });
    expect(calc.appliedPercent).toBe(5);
    expect(calc.newAnnual).toBe(129896.91);
  });

  it("floors a small rise, and says so", () => {
    const calc = calcOf({ cpiRows: rows({ "2025-Q2": [100, BASE], "2026-Q2": [100.2, BASE] }) });
    expect(calc.bounds?.clampedBy).toBe("floor");
    expect(calc.appliedPercent).toBe(1);
  });

  it("holds a fall at no change under the ratchet, and lets it through without one", () => {
    const fall = rows({ "2025-Q2": [100, BASE], "2026-Q2": [98, BASE] });
    const ratcheted = calcOf({
      basis: { capPercent: null, floorPercent: null, intervalMonths: 12, ratchet: true, region: "DARWIN" },
      cpiRows: fall,
      lease: { cpiCapPercent: null, cpiFloorPercent: null, reviewRatchet: true },
    });
    expect(ratcheted.bounds).toMatchObject({ clampedBy: null, ratcheted: true });
    expect(ratcheted.appliedPercent).toBe(0);
    expect(ratcheted.newAnnual).toBe(ratcheted.currentAnnual);
    expect(ratcheted.arrears).toBeNull();

    const free = calcOf({
      basis: { capPercent: null, floorPercent: null, intervalMonths: 12, ratchet: false, region: "DARWIN" },
      cpiRows: fall,
      lease: { cpiCapPercent: null, cpiFloorPercent: null, reviewRatchet: false },
    });
    expect(free.appliedPercent).toBe(-2);
    expect(free.newAnnual).toBeLessThan(free.currentAnnual);
    expect(free.arrears?.amount).toBeLessThan(0);
  });

  it("reads the earlier quarter one review interval back (two years for a 24-month interval)", () => {
    const calc = calcOf({
      basis: { capPercent: 5, floorPercent: 1, intervalMonths: 24, ratchet: true, region: "AUS" },
      cpiRows: rows({ "2024-Q2": [99, BASE], "2026-Q2": [103.2, BASE] }),
    });
    expect(calc.cpi).toMatchObject({ previousQuarter: "2024-Q2", referenceQuarter: "2026-Q2", region: "AUS" });
  });

  describe("the same-base pair (a rebase)", () => {
    it("uses the two values as stored on one base, whatever the base is", () => {
      // After an ABS rebase every stored value is restated: the pair is read fresh, on the new base.
      const calc = calcOf({ cpiRows: rows({ "2025-Q2": [91.2, "Jun 2026 = 100.0"], "2026-Q2": [94.12, "Jun 2026 = 100.0"] }) });
      expect(calc.cpi).toMatchObject({ current: 94.12, previous: 91.2, referenceBase: "Jun 2026 = 100.0" });
      expect(calc.cpi?.ratio).toBe(1.032018);
    });

    it("refuses two values on different bases rather than compare them", () => {
      const result = calculateReview(input({ cpiRows: rows({ "2025-Q2": [100, "Sep 2025 = 100.0"], "2026-Q2": [94.12, "Jun 2026 = 100.0"] }) }));
      expect(result).toMatchObject({ code: "cpi_base_mismatch", kind: "refused" });
    });

    it("refuses a value whose base is unknown", () => {
      expect(calculateReview(input({ cpiRows: rows({ "2025-Q2": [100, null], "2026-Q2": [103.2, null] }) }))).toMatchObject({ code: "cpi_base_mismatch" });
    });
  });

  describe("an unpublished quarter is INDEX_PENDING, not an error", () => {
    it("waits for the reference quarter, expected at its end + 30 days", () => {
      expect(calculateReview(input({ cpiRows: rows({ "2025-Q2": [100, BASE] }) }))).toEqual({
        expectedIndexAt: "2026-07-30",
        kind: "index_pending",
        missing: ["2026-Q2"],
        previousQuarter: "2025-Q2",
        referenceQuarter: "2026-Q2",
        region: "DARWIN",
      });
    });

    it("waits for a missing earlier quarter too, expected at the later of the two", () => {
      expect(calculateReview(input({ cpiRows: [] }))).toMatchObject({ expectedIndexAt: "2026-07-30", kind: "index_pending", missing: ["2026-Q2", "2025-Q2"] });
    });
  });

  it("needs a region on the basis", () => {
    expect(calculateReview(input({ basis: { capPercent: 5, floorPercent: 1, ratchet: true, region: null } }))).toMatchObject({ code: "basis_incomplete" });
  });

  it("adds a row on the review date when the schedule has none, closing the row before it", () => {
    const open = { ...LAST_YEAR, effectiveTo: undefined };
    const calc = calcOf({ stepId: null, steps: [COMMENCE, open] });
    expect(calc.currentAnnual).toBe(123711.34);
    expect(calc.newAnnual).toBe(127670.1);
  });

  it("works from the schedule's starting rent (RentPerAnnum) when there is no commencement row", () => {
    const calc = calcOf({ fallbackAnnual: 100000, stepId: null, steps: [] });
    expect(calc.currentAnnual).toBe(100000);
    expect(calc.newAnnual).toBe(103200);
  });

  it("refuses while an earlier review on the schedule is still unsettled", () => {
    const pending = { ...LAST_YEAR, cpiValue: undefined, resolution: undefined };
    expect(calculateReview(input({ steps: [COMMENCE, pending, REVIEW_STEP] }))).toMatchObject({ code: "earlier_review_pending", kind: "refused" });
  });

  it("refuses a schedule with no rent on the date", () => {
    expect(calculateReview(input({ fallbackAnnual: 0, stepId: null, steps: [] }))).toMatchObject({ code: "no_current_rent" });
  });

  it("refuses when another review already settled the row on its date", () => {
    const settled = { ...REVIEW_STEP, cpiValue: 103.2, reviewId: "someone-else", resolution: "applied" as const };
    expect(calculateReview(input({ steps: [COMMENCE, LAST_YEAR, settled] }))).toMatchObject({ code: "step_settled" });
  });

  it("works on the review's basis when it departs from the lease, at the review's own bounds", () => {
    // The basis caps at 3%; the lease (and so the schedule engine) at 5%.
    const calc = calcOf({ basis: { capPercent: 3, floorPercent: 1, intervalMonths: 12, ratchet: true, region: "DARWIN" } });
    expect(calc.bounds?.clampedBy).toBe("cap");
    expect(calc.appliedPercent).toBe(3);
    expect(calc.newAnnual).toBe(Math.round(123711.34 * 1.03 * 100) / 100);
  });

  it("works the rent per m² from the row's own area, and has none with no area anywhere", () => {
    const withArea = { ...COMMENCE, sqm: 250 };
    const calc = calcOf({ fallbackSqm: 0, steps: [withArea, LAST_YEAR, REVIEW_STEP] });
    expect(calc.perSqm).toBe(Math.round((calc.newAnnual / 250) * 100) / 100);
    expect(calcOf({ fallbackSqm: 0 }).perSqm).toBeNull();
  });
});

describe("the cascade", () => {
  const steps = [{ ...COMMENCE, ahacBasePerAnnum: 6000 }, LAST_YEAR, REVIEW_STEP];
  const cascadeOf = (over: Partial<CalcInput>) => calcOf({ steps, ...over }).cascade;

  it("takes AHAC with the rent", () => {
    const [ahac] = cascadeOf({});
    expect(ahac).toMatchObject({ appliedPercent: 3.2, kind: "ahac", label: "After-hours air-conditioning", note: null });
    expect(ahac.currentAnnual).toBe(6185.57);
    expect(ahac.newAnnual).toBe(6383.51);
  });

  it("takes a car park group with the rent's increase, after the cap", () => {
    const group = { baseMonthlyRate: 150, carparkIds: ["c1"], commencedAt: "2024-07-01", id: "11111111-1111-4111-8111-111111111111", label: "Basement bays" };
    const capped = rows({ "2025-Q2": [100, BASE], "2026-Q2": [108, BASE] });
    const row = cascadeOf({ carparkGroups: [group], cpiRows: capped }).find((r) => r.kind === "carpark");
    // 150 × (100/97) = 154.64 a month before; × 1.05 (capped) after.
    expect(row).toMatchObject({ appliedPercent: 5, currentAnnual: 1855.68, kind: "carpark", label: "Basement bays", newAnnual: 1948.44, note: null });
  });

  it("keeps a car park's own CPI override unclamped, and says it goes past the cap", () => {
    const group = {
      baseMonthlyRate: 150,
      carparkIds: ["c1"],
      commencedAt: "2024-07-01",
      id: "11111111-1111-4111-8111-111111111111",
      label: "Basement bays",
      rateSteps: [{ cpiValue: 110, cpiValuePrev: 100, effectiveFrom: "2026-07-01", id: "22222222-2222-4222-8222-222222222222", methodKind: "cpi" as const }],
    };
    const row = cascadeOf({ carparkGroups: [group] }).find((r) => r.kind === "carpark");
    expect(row?.appliedPercent).toBeCloseTo(10, 1);
    expect(row?.note).toMatch(/Own CPI override \(110 ÷ 100 = 10\.00%\): not limited by the lease's cap or floor — above the lease's 5\.00% cap/);
  });

  it("keeps a misc fee's own rate and its own new amount, and leaves out a fee that only starts at the review", () => {
    const fees = [
      { baseAmount: 300, commencedAt: "2024-07-01", frequency: "quarterly" as const, id: "33333333-3333-4333-8333-333333333333", rateSteps: [{ effectiveFrom: "2026-07-01", id: "44444444-4444-4444-8444-444444444444", ratePercent: 2 }], title: "Cleaning" },
      { baseAmount: 1200, commencedAt: "2024-07-01", frequency: "annual" as const, id: "55555555-5555-4555-8555-555555555555", rateSteps: [{ effectiveFrom: "2026-07-01", id: "66666666-6666-4666-8666-666666666666", newAmount: 1500 }], title: "Signage" },
      { baseAmount: 50, commencedAt: "2026-07-01", frequency: "monthly" as const, id: "77777777-7777-4777-8777-777777777777", title: "New storage" },
      { baseAmount: 20, commencedAt: "2024-07-01", endsAt: "2026-06-30", frequency: "monthly" as const, id: "88888888-8888-4888-8888-888888888888", title: "Ended" },
    ];
    const cascade = cascadeOf({ miscFees: fees }).filter((r) => r.kind === "misc_fee");
    expect(cascade.map((r) => r.label)).toEqual(["Cleaning", "Signage"]);
    expect(cascade[0]).toMatchObject({ appliedPercent: 2 });
    expect(cascade[0].note).toBe("Own rate of 2.00% for this date: not limited by the lease's cap or floor");
    expect(cascade[1]).toMatchObject({ newAnnual: 1500 });
    expect(cascade[1].note).toMatch(/Set to \$1,500\.00 a year by its own amount/);
  });

  it("is empty on a schedule with nothing that follows the rent", () => {
    expect(calcOf().cascade).toEqual([]);
  });
});

describe("arrears on the receipt", () => {
  it("run from the review date to today", () => {
    const calc = calcOf({ today: "2026-10-01" });
    const amount = Math.round((((127670.1 - 123711.34) * 92) / 365) * 100) / 100;
    expect(calc.arrears).toEqual({ amount, from: "2026-07-01", lines: [{ amount, kind: "rent", label: "Rent" }], months: 3.02, to: "2026-10-01" });
  });

  it("are null when the review is worked out ahead of its date", () => {
    expect(calcOf({ today: "2026-06-15" }).arrears).toBeNull();
  });
});

describe("a fixed review", () => {
  const fixed = (over: Partial<CalcInput> = {}) =>
    calculateReview(
      input({
        basis: { fixedPercent: 4, intervalMonths: 12, method: "fixed", ratchet: false },
        lease: { cpiCapPercent: null, cpiFloorPercent: null, reviewRatchet: false },
        method: "fixed",
        steps: [COMMENCE, LAST_YEAR, { ...REVIEW_STEP, methodKind: "fixed", ratePercent: 4 }],
        ...over,
      }),
    );

  it("is old × (1 + the lease %)", () => {
    const result = fixed();
    if (result.kind !== "calc") throw new Error("expected a calc");
    expect(result.calc).toMatchObject({ appliedPercent: 4, fixedPercent: 4, method: "fixed", newAnnual: 128659.79 });
    expect(result.calc.cpi).toBeUndefined();
  });

  it("needs the % on the basis", () => {
    expect(fixed({ basis: { fixedPercent: null, ratchet: false } })).toMatchObject({ code: "basis_incomplete" });
  });

  it("holds a negative % at no change under the ratchet", () => {
    const result = fixed({ basis: { fixedPercent: -2, ratchet: true }, lease: { cpiCapPercent: null, cpiFloorPercent: null, reviewRatchet: true } });
    expect(result).toMatchObject({ calc: { appliedPercent: 0, bounds: { ratcheted: true } } });
  });
});

describe("an `other` review", () => {
  const other = (manual: CalcInput["manual"]) =>
    calculateReview(input({ basis: { description: "Agreed with the tenant", ratchet: true }, manual, method: "other" }));

  it("needs the new rent and an explanation", () => {
    expect(other(null)).toMatchObject({ code: "manual_required" });
    expect(other({ explanation: "  ", newAnnual: 130000 })).toMatchObject({ code: "manual_required" });
    expect(other({ explanation: "Agreed", newAnnual: 0 })).toMatchObject({ code: "manual_required" });
    expect(other({ explanation: "x".repeat(2001), newAnnual: 130000 })).toMatchObject({ code: "manual_required" });
  });

  it("takes the keyed rent as it is, with its explanation", () => {
    const result = other({ explanation: " Agreed after the fit-out ", newAnnual: 130000.004 });
    expect(result).toMatchObject({
      calc: { appliedPercent: 5.0833, manual: { explanation: "Agreed after the fit-out", newAnnual: 130000 }, method: "other", newAnnual: 130000 },
      kind: "calc",
    });
  });
});

describe("leaseDepartures: what keeps a review from applying in one step", () => {
  const lease = { cpiCapPercent: 5, cpiFloorPercent: 1, cpiRegion: "Darwin", fixedPercent: null, reviewIntervalMonths: null, reviewRatchet: true };

  it("is empty for a basis that is the lease", () => {
    expect(leaseDepartures("cpi", { capPercent: 5, floorPercent: 1, intervalMonths: 12, ratchet: true, region: "DARWIN" }, lease)).toEqual([]);
  });

  it("names each term the basis changed", () => {
    expect(leaseDepartures("cpi", { capPercent: 3, floorPercent: null, intervalMonths: 24, ratchet: false, region: "AUS" }, lease)).toEqual([
      "ratchet",
      "capPercent",
      "floorPercent",
      "region",
      "intervalMonths",
    ]);
  });

  it("compares a fixed review's % with the lease's", () => {
    const fixedLease = { ...lease, fixedPercent: 4, reviewRatchet: false };
    expect(leaseDepartures("fixed", { fixedPercent: 4, ratchet: false }, fixedLease)).toEqual([]);
    expect(leaseDepartures("fixed", { fixedPercent: 3.5, ratchet: false }, fixedLease)).toEqual(["fixedPercent"]);
  });
});

describe("parseCalc", () => {
  it("reads back what was stored and refuses anything else", () => {
    const calc = calcOf();
    expect(parseCalc(JSON.stringify(calc))).toEqual(calc);
    expect(parseCalc(null)).toBeNull();
    expect(parseCalc("not json")).toBeNull();
    expect(parseCalc(JSON.stringify({ method: "market", newAnnual: 1, currentAnnual: 1, scheduleVersion: 1 }))).toBeNull();
  });
});

describe("the receipt and the written row are the same engine run", () => {
  it("for every CPI pair in a spread, the engine puts the receipt's figure on the row", () => {
    for (let current = 95; current <= 112; current += 0.37) {
      const value = Math.round(current * 10) / 10;
      const calc = calcOf({ cpiRows: rows({ "2025-Q2": [100, BASE], "2026-Q2": [value, BASE] }) });
      const step = appliedStep(REVIEW_STEP, "rev-1", { cpiValue: value, cpiValuePrev: 100, methodKind: "cpi", ratePercent: calc.appliedPercent });
      const { row } = simulate({ fallbackAnnual: 0, fallbackSqm: 400, lease: { cpiCapPercent: 5, cpiFloorPercent: 1, reviewRatchet: true }, steps: [COMMENCE, LAST_YEAR, REVIEW_STEP] }, step);
      expect(row?.annual).toBe(calc.newAnnual);
    }
  });
});
