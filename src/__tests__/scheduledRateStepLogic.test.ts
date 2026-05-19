import assert from "node:assert";
import {
  validateStep,
  parseSteps,
  upsertStep,
  deleteStep,
  resolveScheduleAnnual,
  NOT_FOUND,
} from "../scheduledRateStepLogic";

import type { ScheduledRateStep } from "../scheduledRateStepLogic";

const validId = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

describe("validateStep", () => {
  it("accepts a valid step", () => {
    const r = validateStep({ id: validId, effectiveFrom: "2026-07-01", ratePercent: 6 });
    assert.strictEqual(r.ok, true);
    if (!r.ok) throw new Error();
    assert.strictEqual(r.step.ratePercent, 6);
    assert.strictEqual(r.step.effectiveFrom, "2026-07-01");
  });

  it("accepts a step with a note", () => {
    const r = validateStep({ id: validId, effectiveFrom: "2026-07-01", ratePercent: 5, note: "Year 2" });
    assert.strictEqual(r.ok, true);
    if (!r.ok) throw new Error();
    assert.strictEqual(r.step.note, "Year 2");
  });

  it("mints a UUID when id is blank", () => {
    const r = validateStep({ id: "", effectiveFrom: "2026-07-01", ratePercent: 3 });
    assert.strictEqual(r.ok, true);
    if (!r.ok) throw new Error();
    assert.match(r.step.id, /^[0-9a-f-]{36}$/i);
    assert.notStrictEqual(r.step.id, "");
  });

  it("rejects a non-ISO date", () => {
    const r = validateStep({ id: validId, effectiveFrom: "01/07/2026", ratePercent: 6 });
    assert.strictEqual(r.ok, false);
    if (r.ok) throw new Error();
    assert.match(r.error, /effectiveFrom/);
  });

  it("rejects ratePercent = 0", () => {
    const r = validateStep({ id: validId, effectiveFrom: "2026-07-01", ratePercent: 0 });
    assert.strictEqual(r.ok, false);
  });

  it("rejects ratePercent > 100", () => {
    const r = validateStep({ id: validId, effectiveFrom: "2026-07-01", ratePercent: 150 });
    assert.strictEqual(r.ok, false);
  });

  it("rejects unknown keys", () => {
    const r = validateStep({ id: validId, effectiveFrom: "2026-07-01", ratePercent: 5, mystery: true });
    assert.strictEqual(r.ok, false);
    if (r.ok) throw new Error();
    assert.match(r.error, /Unknown key/);
  });
});

describe("parseSteps", () => {
  it("parses valid JSON array", () => {
    const json = JSON.stringify([{ id: validId, effectiveFrom: "2026-07-01", ratePercent: 5 }]);
    assert.strictEqual(parseSteps(json).length, 1);
  });

  it("returns [] for null", () => {
    assert.deepStrictEqual(parseSteps(null), []);
  });

  it("drops rows missing required fields", () => {
    const json = JSON.stringify([{ id: validId, ratePercent: 5 }]); // missing effectiveFrom
    assert.strictEqual(parseSteps(json).length, 0);
  });
});

describe("upsertStep", () => {
  it("appends when id is new", () => {
    const existing = [{ id: "aaa", effectiveFrom: "2026-07-01", ratePercent: 6 }];
    const incoming = { id: "bbb", effectiveFrom: "2027-07-01", ratePercent: 5 };
    const result = upsertStep(existing, incoming);
    assert.strictEqual(result.length, 2);
  });

  it("replaces in place when id matches", () => {
    const existing = [{ id: "aaa", effectiveFrom: "2026-07-01", ratePercent: 6 }];
    const incoming = { id: "aaa", effectiveFrom: "2026-07-01", ratePercent: 4 };
    const result = upsertStep(existing, incoming);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].ratePercent, 4);
  });
});

describe("deleteStep", () => {
  it("removes by id", () => {
    const existing = [{ id: "aaa", effectiveFrom: "2026-07-01", ratePercent: 6 }];
    const result = deleteStep(existing, "aaa");
    assert.notStrictEqual(result, NOT_FOUND);
    if (result === NOT_FOUND) throw new Error();
    assert.strictEqual(result.length, 0);
  });

  it("returns NOT_FOUND when id is absent", () => {
    assert.strictEqual(deleteStep([], "missing"), NOT_FOUND);
  });
});

// ── resolveScheduleAnnual ─────────────────────────────────────────────────────

function comm(id: string, from: string, base: number, sqm: number, to?: string): ScheduledRateStep {
  return { id, effectiveFrom: from, effectiveTo: to, methodKind: "commencement", baseRentPerAnnum: base, sqm, ratePercent: 0 };
}

function fixed(id: string, from: string, pct: number, sqm: number, to?: string): ScheduledRateStep {
  return { id, effectiveFrom: from, effectiveTo: to, methodKind: "fixed", ratePercent: pct, sqm };
}

describe("resolveScheduleAnnual", () => {
  it("returns fallbackAnnual when steps is empty", () => {
    assert.strictEqual(resolveScheduleAnnual([], 100000, 200, "2026-05-19"), 100000);
  });

  // Regression: Engineers Australia — RentPerAnnum=0 in DB, rent defined only by schedule.
  it("returns schedule annual when fallback is 0 but commencement step has a base", () => {
    const steps: ScheduledRateStep[] = [
      comm("1", "2014-05-01", 126119.87, 210),
    ];
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 210, "2026-05-19"), 126119.87);
  });

  it("selects the period whose effectiveFrom <= today and effectiveTo >= today", () => {
    const steps: ScheduledRateStep[] = [
      comm("1", "2020-01-01", 100000, 100, "2022-12-31"),
      comm("2", "2023-01-01", 120000, 100),
    ];
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2024-06-01"), 120000);
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2022-06-01"), 100000);
  });

  it("falls back to the last non-pending row when today is before the first step", () => {
    const steps: ScheduledRateStep[] = [
      comm("1", "2030-01-01", 999000, 100),
    ];
    // No current row; falls back to last non-pending, not fallback=0
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2026-05-19"), 999000);
  });

  it("falls back to the last non-pending row when all periods have closed", () => {
    const steps: ScheduledRateStep[] = [
      comm("1", "2019-01-01", 100000, 100, "2019-06-30"),
      comm("2", "2019-07-01", 110000, 100, "2019-12-31"),
    ];
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2026-05-19"), 110000);
  });

  it("skips pending CPI steps (no cpiValue) and falls back to last non-pending", () => {
    const steps: ScheduledRateStep[] = [
      comm("1", "2020-01-01", 100000, 100, "2022-12-31"),
      { id: "2", effectiveFrom: "2023-01-01", methodKind: "cpi", ratePercent: 0 },
    ];
    // Step 2 has no cpiValue → pending; fallback to step 1
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2026-05-19"), 100000);
  });

  it("applies a fixed-percent increase on top of the commencement base", () => {
    const steps: ScheduledRateStep[] = [
      comm("1", "2020-01-01", 100000, 100, "2022-12-31"),
      fixed("2", "2023-01-01", 5, 100),
    ];
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2026-05-19"), 105000);
  });

  it("handles sqm changes between periods — rate per m² is preserved, annual scales", () => {
    // Base: $1000/m² on 100 m² = $100,000/yr. Expand to 120 m² — annual should scale.
    const steps: ScheduledRateStep[] = [
      comm("1", "2020-01-01", 100000, 100, "2022-12-31"),
      fixed("2", "2023-01-01", 0, 120),  // 0% increase, but bigger area
    ];
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2026-05-19"), 120000);
  });
});
