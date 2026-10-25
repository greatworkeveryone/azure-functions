import assert from "node:assert";
import {
  closeOpenPredecessor,
  computeScheduleRows,
  validateStep,
  normaliseLegacyEnds,
  parseSteps,
  upsertStep,
  upsertGroup,
  upsertMiscFee,
  deleteStep,
  resolveScheduleAnnual,
  NOT_FOUND,
} from "../scheduledRateStepLogic";

import type { MiscFee, ScheduledRateStep } from "../scheduledRateStepLogic";
import { onlyCategoryChanged } from "../scheduledRateStepLogic";

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

  it("accepts ratePercent = 0 (pending market step)", () => {
    const r = validateStep({ id: validId, effectiveFrom: "2026-07-01", ratePercent: 0 });
    assert.strictEqual(r.ok, true);
  });

  it("rejects ratePercent > 100", () => {
    const r = validateStep({ id: validId, effectiveFrom: "2026-07-01", ratePercent: 150 });
    assert.strictEqual(r.ok, false);
  });

  it("rejects ratePercent < -100", () => {
    const r = validateStep({ id: validId, effectiveFrom: "2026-07-01", ratePercent: -150 });
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

function fixed(id: string, from: string, pct: number, sqm?: number, to?: string): ScheduledRateStep {
  return { id, effectiveFrom: from, effectiveTo: to, methodKind: "fixed", ratePercent: pct, sqm };
}

describe("resolveScheduleAnnual", () => {
  it("returns fallbackAnnual when steps is empty", () => {
    assert.deepStrictEqual(resolveScheduleAnnual([], 100000, 200, "2026-05-19"), { annual: 100000, startsOn: null });
  });

  // Regression: Engineers Australia — RentPerAnnum=0 in DB, rent defined only by schedule.
  it("returns schedule annual when fallback is 0 but commencement step has a base", () => {
    const steps: ScheduledRateStep[] = [comm("1", "2014-05-01", 126119.87, 210)];
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 210, "2026-05-19").annual, 126119.87);
  });

  it("takes the latest row on or before today, whatever effectiveTo says", () => {
    const steps: ScheduledRateStep[] = [
      comm("1", "2020-01-01", 100000, 100, "2023-01-01"),
      comm("2", "2023-01-01", 120000, 100),
    ];
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2024-06-01").annual, 120000);
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2022-06-01").annual, 100000);
  });

  it("with two open-ended rows, the later one is current (not the oldest)", () => {
    const steps: ScheduledRateStep[] = [comm("1", "2024-07-01", 100000, 100), fixed("2", "2025-07-01", 6.09)];
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2026-05-19").annual, 106090);
  });

  it("an all-future schedule has no current rent and says when it starts", () => {
    const steps: ScheduledRateStep[] = [comm("1", "2030-01-01", 999000, 100)];
    assert.deepStrictEqual(resolveScheduleAnnual(steps, 0, 100, "2026-05-19"), { annual: 0, startsOn: "2030-01-01" });
  });

  it("keeps charging the last row after every period has closed (holdover)", () => {
    const steps: ScheduledRateStep[] = [
      comm("1", "2019-01-01", 100000, 100, "2019-07-01"),
      comm("2", "2019-07-01", 110000, 100, "2020-01-01"),
    ];
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2026-05-19").annual, 110000);
  });

  it("skips a pending CPI row (no index yet) and keeps the previous rent", () => {
    const steps: ScheduledRateStep[] = [
      comm("1", "2020-01-01", 100000, 100),
      { id: "2", effectiveFrom: "2023-01-01", methodKind: "cpi", ratePercent: 0 },
    ];
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2026-05-19").annual, 100000);
  });

  it("applies a fixed-percent increase on top of the commencement base", () => {
    const steps: ScheduledRateStep[] = [comm("1", "2020-01-01", 100000, 100), fixed("2", "2023-01-01", 5, 100)];
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2026-05-19").annual, 105000);
  });

  it("an explicit area change on a row rescales from that row at the prevailing $/m²", () => {
    const steps: ScheduledRateStep[] = [comm("1", "2020-01-01", 100000, 100), fixed("2", "2023-01-01", 0, 120)];
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2026-05-19").annual, 120000);
  });

  it("the tenancy's current area never changes the rent (no rescaling of history)", () => {
    const steps: ScheduledRateStep[] = [comm("1", "2020-01-01", 100000, 100), fixed("2", "2023-01-01", 5)];
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2026-05-19").annual, 105000);
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 250, "2026-05-19").annual, 105000);
  });

  it("zero area never zeroes the rent", () => {
    const steps: ScheduledRateStep[] = [comm("1", "2020-01-01", 100000, 0), fixed("2", "2023-01-01", 5)];
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 0, "2026-05-19").annual, 105000);
  });

  it("a schedule with no commencement row is on its stored base until the first review", () => {
    const steps: ScheduledRateStep[] = [fixed("1", "2027-01-01", 3)];
    assert.deepStrictEqual(resolveScheduleAnnual(steps, 90000, 100, "2026-05-19"), { annual: 90000, startsOn: null });
    assert.strictEqual(resolveScheduleAnnual(steps, 90000, 100, "2027-01-01").annual, 92700);
  });
});

describe("computeScheduleRows", () => {
  it("flags why a row is pending", () => {
    const rows = computeScheduleRows(
      [
        comm("1", "2020-01-01", 100000, 100),
        { id: "2", effectiveFrom: "2021-01-01", methodKind: "cpi", ratePercent: 0 },
        fixed("3", "2022-01-01", 3),
        { id: "4", effectiveFrom: "2023-01-01", methodKind: "market", ratePercent: 0 },
      ],
      0,
      100,
    );
    assert.deepStrictEqual(rows.map((r) => r.pendingReason), [null, "cpi_index_missing", "earlier_review_pending", "rate_not_set"]);
    assert.deepStrictEqual(rows.map((r) => r.annual), [100000, 0, 0, 0]);
  });

  it("shows the rent with the area flagged missing instead of $0", () => {
    const [row] = computeScheduleRows([comm("1", "2020-01-01", 100000, 0)], 0, 0);
    assert.strictEqual(row.annual, 100000);
    assert.strictEqual(row.areaMissing, true);
    assert.strictEqual(row.sqmRate, 0);
  });
});

// ── Row ends: effectiveTo is exclusive ───────────────────────────────────────

describe("normaliseLegacyEnds", () => {
  it("reads an inclusive last day (one day before the next row) as ending where the next row starts", () => {
    const out = normaliseLegacyEnds([
      fixed("b", "2026-07-01", 3),
      comm("a", "2025-07-01", 100000, 100, "2026-06-30"),
    ]);
    assert.strictEqual(out.find((s) => s.id === "a")?.effectiveTo, "2026-07-01");
    assert.deepStrictEqual(out.map((s) => s.id), ["b", "a"]);
  });

  it("leaves exclusive ends, real gaps and the last row alone", () => {
    const steps = [
      comm("a", "2024-07-01", 100000, 100, "2025-07-01"),
      fixed("b", "2025-07-01", 3, undefined, "2026-06-01"),
      fixed("c", "2026-07-01", 3, undefined, "2027-06-30"),
    ];
    assert.deepStrictEqual(normaliseLegacyEnds(steps), steps);
  });

  it("parseSteps applies it, so reads (and the next write) carry exclusive ends", () => {
    const parsed = parseSteps(JSON.stringify([
      comm("a", "2025-07-01", 100000, 100, "2026-06-30"),
      fixed("b", "2026-07-01", 3),
    ]));
    assert.strictEqual(parsed[0].effectiveTo, "2026-07-01");
  });
});

describe("closeOpenPredecessor", () => {
  it("closes the open-ended row before a new one at the new row's start", () => {
    const { closed, steps } = closeOpenPredecessor(
      [comm("a", "2025-07-01", 100000, 100), fixed("z", "2028-07-01", 3)],
      fixed("new", "2026-07-01", 3),
    );
    assert.strictEqual(closed?.before.effectiveTo, undefined);
    assert.strictEqual(closed?.after.effectiveTo, "2026-07-01");
    assert.strictEqual(steps.find((s) => s.id === "a")?.effectiveTo, "2026-07-01");
  });

  it("leaves a predecessor that already ends, and edits of an existing row", () => {
    const ended = [comm("a", "2025-07-01", 100000, 100, "2026-07-01")];
    assert.strictEqual(closeOpenPredecessor(ended, fixed("new", "2026-07-01", 3)).closed, null);
    const open = [comm("a", "2025-07-01", 100000, 100), fixed("b", "2026-07-01", 3)];
    assert.strictEqual(closeOpenPredecessor(open, fixed("b", "2026-07-01", 4)).closed, null);
  });
});

describe("validateStep — dates", () => {
  it("rejects an end on or before the start (effectiveTo is exclusive)", () => {
    const same = validateStep({ id: validId, effectiveFrom: "2026-07-01", effectiveTo: "2026-07-01", ratePercent: 3 });
    assert.strictEqual(same.ok, false);
    const ok = validateStep({ id: validId, effectiveFrom: "2026-07-01", effectiveTo: "2027-07-01", ratePercent: 3 });
    assert.strictEqual(ok.ok, true);
  });

  it("rejects an impossible calendar date", () => {
    assert.strictEqual(validateStep({ id: validId, effectiveFrom: "2026-02-30", ratePercent: 3 }).ok, false);
  });
});

// ── Review settlement and lease terms (PLAN WP23b) ──────────────────────────

describe("validateStep — review settlement", () => {
  it("accepts reviewId and an applied or waived resolution on a review row", () => {
    const r = validateStep({
      effectiveFrom: "2026-07-01",
      id: validId,
      methodKind: "cpi",
      ratePercent: 0,
      resolution: "waived",
      reviewId: "rr-2026-07",
    });
    assert.strictEqual(r.ok, true);
    if (!r.ok) throw new Error();
    assert.strictEqual(r.step.resolution, "waived");
    assert.strictEqual(r.step.reviewId, "rr-2026-07");
    assert.strictEqual(validateStep({ effectiveFrom: "2026-07-01", id: validId, ratePercent: 3, resolution: "applied" }).ok, true);
  });

  it("rejects any other resolution, a resolution on a commencement row, and a bad reviewId", () => {
    assert.strictEqual(validateStep({ effectiveFrom: "2026-07-01", id: validId, ratePercent: 3, resolution: "done" }).ok, false);
    const onCommencement = validateStep({
      effectiveFrom: "2026-07-01",
      id: validId,
      methodKind: "commencement",
      ratePercent: 0,
      resolution: "applied",
    });
    assert.strictEqual(onCommencement.ok, false);
    assert.strictEqual(validateStep({ effectiveFrom: "2026-07-01", id: validId, ratePercent: 3, reviewId: "" }).ok, false);
    assert.strictEqual(
      validateStep({ effectiveFrom: "2026-07-01", id: validId, ratePercent: 3, reviewId: "x".repeat(41) }).ok,
      false,
    );
  });
});

describe("computeScheduleRows — lease terms (mirrored in FE scheduleReview tests)", () => {
  const cpiStep = (id: string, from: string, value: number, prev: number): ScheduledRateStep => ({
    cpiValue: value,
    cpiValuePrev: prev,
    effectiveFrom: from,
    id,
    methodKind: "cpi",
    ratePercent: 0,
  });

  it("applies the floor, then the cap: when they cross, the cap wins", () => {
    const [, row] = computeScheduleRows(
      [comm("1", "2024-07-01", 100000, 100), cpiStep("2", "2025-07-01", 101, 100)],
      0,
      100,
      { cpiCapPercent: 2, cpiFloorPercent: 3 },
    );
    assert.deepStrictEqual(
      { annual: row.annual, applied: row.appliedPercent, cap: row.capApplied, floor: row.floorApplied, raw: row.rawPercent },
      { annual: 102000, applied: 2, cap: true, floor: true, raw: 1 },
    );
  });

  it("an increase inside the band is untouched; a null term is no bound", () => {
    const [, row] = computeScheduleRows(
      [comm("1", "2024-07-01", 100000, 100), cpiStep("2", "2025-07-01", 102.5, 100)],
      0,
      100,
      { cpiCapPercent: null, cpiFloorPercent: 2 },
    );
    assert.strictEqual(row.appliedPercent, 2.5);
    assert.strictEqual(row.capApplied || row.floorApplied || row.ratchetApplied, false);
  });

  it("the ratchet applies after the floor and cap, on any review row", () => {
    const rows = computeScheduleRows(
      [
        comm("1", "2023-07-01", 100000, 100),
        cpiStep("2", "2024-07-01", 97, 100),
        { effectiveFrom: "2025-07-01", id: "3", methodKind: "fixed", ratePercent: -1 },
      ],
      0,
      100,
      { cpiFloorPercent: -1, reviewRatchet: true },
    );
    assert.deepStrictEqual(
      rows.slice(1).map((row) => [row.rawPercent, row.appliedPercent, row.floorApplied, row.ratchetApplied]),
      [
        [-3, 0, true, true],
        [-1, 0, false, true],
      ],
    );
    assert.strictEqual(rows[2].annual, 100000);
  });

  it("never reports -0", () => {
    const [, row] = computeScheduleRows(
      [comm("1", "2024-07-01", 100000, 100), cpiStep("2", "2025-07-01", 99.999999, 100)],
      0,
      100,
    );
    assert.ok(Object.is(row.rawPercent, 0));
  });

  it("resolveScheduleAnnual passes the terms through", () => {
    const steps = [comm("1", "2024-07-01", 100000, 100), cpiStep("2", "2025-07-01", 110, 100)];
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2025-08-01").annual, 110000);
    assert.strictEqual(resolveScheduleAnnual(steps, 0, 100, "2025-08-01", { cpiCapPercent: 4 }).annual, 104000);
  });
});

describe("upsertStep — omitted fields", () => {
  it("keeps stored sqm, flagComment, reviewId and resolution the client omitted", () => {
    const stored = { id: "aaa", effectiveFrom: "2026-07-01", ratePercent: 6, sqm: 120, flagComment: "check", reviewId: "r1", resolution: "settled" } as unknown as ScheduledRateStep;
    const [out] = upsertStep([stored], { id: "aaa", effectiveFrom: "2026-07-01", ratePercent: 4 });
    assert.strictEqual(out.ratePercent, 4);
    assert.strictEqual(out.sqm, 120);
    assert.strictEqual(out.flagComment, "check");
    assert.strictEqual(out.reviewId, "r1");
    assert.strictEqual(out.resolution, "settled");
  });

  it("lets the client overwrite sqm when it sends one", () => {
    const [out] = upsertStep([{ id: "aaa", effectiveFrom: "2026-07-01", ratePercent: 6, sqm: 120 }], { id: "aaa", effectiveFrom: "2026-07-01", ratePercent: 6, sqm: 90 });
    assert.strictEqual(out.sqm, 90);
  });
});

describe("upsertGroup — rateSteps", () => {
  const gid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const steps = [{ id: "cccccccc-cccc-cccc-cccc-cccccccccccc", effectiveFrom: "2027-07-01" }];
  const stored = { id: gid, label: "A", carparkIds: ["1"], baseMonthlyRate: 100, commencedAt: "2026-07-01", rateSteps: steps };
  const edit = { id: gid, label: "B", carparkIds: ["1"], baseMonthlyRate: 110, commencedAt: "2026-07-01" };

  it("carries stored rateSteps forward when the edit omits them", () => {
    const [out] = upsertGroup([stored] as never, edit);
    assert.strictEqual(out.label, "B");
    assert.deepStrictEqual(out.rateSteps, steps);
  });

  it("clears them on an explicit empty array", () => {
    const [out] = upsertGroup([stored] as never, { ...edit, rateSteps: [] });
    assert.deepStrictEqual(out.rateSteps, []);
  });

  it("misc fees keep stored rateSteps too", () => {
    const fee = { id: "f1", title: "T", frequency: "monthly" as const, baseAmount: 5, commencedAt: "2026-07-01", rateSteps: [{ id: "s1", effectiveFrom: "2027-07-01" }] };
    const [out] = upsertMiscFee([fee], { id: "f1", title: "T2", frequency: "monthly", baseAmount: 6, commencedAt: "2026-07-01" });
    assert.strictEqual(out.title, "T2");
    assert.strictEqual(out.rateSteps?.length, 1);
  });
});

describe("onlyCategoryChanged", () => {
  const FEE: MiscFee = { baseAmount: 500, commencedAt: "2024-07-01", frequency: "monthly", id: "f1", note: "Cage 4", title: "Storage cage" };

  it("is true when only the category moved, whatever the key order", () => {
    expect(onlyCategoryChanged({ ...FEE }, { title: "Storage cage", id: "f1", category: "other", frequency: "monthly", commencedAt: "2024-07-01", baseAmount: 500, note: "Cage 4" })).toBe(true);
    expect(onlyCategoryChanged({ ...FEE, category: "cleaning" }, { ...FEE, category: undefined })).toBe(true);
  });

  it("is false for a new fee, an unchanged category, or any other change alongside it", () => {
    expect(onlyCategoryChanged(null, { ...FEE, category: "cleaning" })).toBe(false);
    expect(onlyCategoryChanged({ ...FEE, category: "cleaning" }, { ...FEE, category: "cleaning" })).toBe(false);
    expect(onlyCategoryChanged({ ...FEE }, { ...FEE, baseAmount: 550, category: "cleaning" })).toBe(false);
    expect(onlyCategoryChanged({ ...FEE }, { ...FEE, category: "cleaning", rateSteps: [{ effectiveFrom: "2025-07-01", id: "r1", ratePercent: 3 }] })).toBe(false);
  });
});
