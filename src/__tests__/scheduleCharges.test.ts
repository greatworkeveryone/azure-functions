import { ancillariesByRow } from "../rentReview/cascade";
import {
  chargedOn,
  chargesOver,
  computeCharges,
  parseReliefs,
  reliefEnd,
  reliefsOverlap,
  type RentRelief,
  validateReliefShape,
} from "../scheduleCharges";
import {
  type CarparkScheduleGroup,
  computeScheduleRows,
  diffSteps,
  type MiscFee,
  type ScheduledRateStep,
  stepPendingReason,
  validateStep,
} from "../scheduledRateStepLogic";
import fixtures from "./rent-schedule-parity.fixtures.json";

const COMMENCEMENT: ScheduledRateStep = { baseRentPerAnnum: 100000, effectiveFrom: "2025-01-01", id: "a", methodKind: "commencement", ratePercent: 0, sqm: 100 };
const relief = (over: Partial<RentRelief> = {}): RentRelief => ({
  from: "2025-03-01",
  id: "rel-1",
  kind: "percent",
  scope: ["rent"],
  to: "2025-03-31",
  value: 50,
  ...over,
});

describe("validateReliefShape", () => {
  it("accepts a percentage over any charges, in the engine's scope order", () => {
    expect(validateReliefShape({ from: "2025-03-01", kind: "percent", scope: ["misc_fees", "rent"], to: "2025-03-01", value: 12.5 })).toEqual({
      ok: true,
      relief: { from: "2025-03-01", kind: "percent", scope: ["rent", "misc_fees"], to: "2025-03-01", value: 12.5 },
    });
  });

  it("rounds an amount or a fixed rent to the cent", () => {
    expect(validateReliefShape({ from: "2025-03-01", kind: "amount", scope: ["rent"], to: "2025-04-30", value: 1000.005 })).toMatchObject({ relief: { value: 1000.01 } });
    expect(validateReliefShape({ from: "2025-03-01", kind: "fixed_rent", scope: ["rent"], to: "2025-04-30", value: 0 })).toMatchObject({ ok: true, relief: { value: 0 } });
  });

  it.each([
    ["not an object", null, "relief must be"],
    ["an unknown key", { extra: 1, from: "2025-03-01", kind: "percent", scope: ["rent"], to: "2025-03-31", value: 5 }, 'relief has no "extra"'],
    ["a date that doesn't exist", { from: "2025-02-30", kind: "percent", scope: ["rent"], to: "2025-03-31", value: 5 }, "relief.from must be a date"],
    ["a missing last day", { from: "2025-03-01", kind: "percent", scope: ["rent"], value: 5 }, "relief.to must be a date"],
    ["an end before the start", { from: "2025-03-01", kind: "percent", scope: ["rent"], to: "2025-02-28", value: 5 }, "can't be before"],
    ["more than five years", { from: "2025-01-01", kind: "percent", scope: ["rent"], to: "2030-01-01", value: 5 }, "at most five years"],
    ["five years and a day", { from: "2025-03-01", kind: "percent", scope: ["rent"], to: "2030-03-01", value: 5 }, "at most five years"],
    ["an unknown kind", { from: "2025-03-01", kind: "rebate", scope: ["rent"], to: "2025-03-31", value: 5 }, "relief.kind must be one of"],
    ["no scope", { from: "2025-03-01", kind: "percent", scope: [], to: "2025-03-31", value: 5 }, "relief.scope must list"],
    ["an unknown scope", { from: "2025-03-01", kind: "percent", scope: ["outgoings"], to: "2025-03-31", value: 5 }, "relief.scope must list"],
    ["a charge twice", { from: "2025-03-01", kind: "percent", scope: ["rent", "rent"], to: "2025-03-31", value: 5 }, "lists a charge twice"],
    ["0%", { from: "2025-03-01", kind: "percent", scope: ["rent"], to: "2025-03-31", value: 0 }, "more than 0% and at most 100%"],
    ["more than 100%", { from: "2025-03-01", kind: "percent", scope: ["rent"], to: "2025-03-31", value: 100.5 }, "more than 0% and at most 100%"],
    ["an amount off AHAC", { from: "2025-03-01", kind: "amount", scope: ["ahac"], to: "2025-03-31", value: 5 }, "relieves the rent only"],
    ["a fixed rent over two charges", { from: "2025-03-01", kind: "fixed_rent", scope: ["rent", "ahac"], to: "2025-03-31", value: 5 }, "relieves the rent only"],
    ["an amount of $0", { from: "2025-03-01", kind: "amount", scope: ["rent"], to: "2025-03-31", value: 0 }, "more than $0"],
    ["a negative fixed rent", { from: "2025-03-01", kind: "fixed_rent", scope: ["rent"], to: "2025-03-31", value: -1 }, "$0 a year or more"],
    ["a value that isn't a number", { from: "2025-03-01", kind: "percent", scope: ["rent"], to: "2025-03-31", value: "50" }, "must be a number"],
  ])("refuses %s", (_label, raw, message) => {
    const result = validateReliefShape(raw);
    expect(result.ok).toBe(false);
    expect(result.ok ? "" : result.error).toContain(message);
  });
});

describe("reliefsOverlap", () => {
  it("needs a shared day and a shared charge", () => {
    expect(reliefsOverlap(relief(), relief({ from: "2025-03-31", to: "2025-04-30" }))).toBe(true);
    expect(reliefsOverlap(relief(), relief({ from: "2025-04-01", to: "2025-04-30" }))).toBe(false);
    expect(reliefsOverlap(relief(), relief({ scope: ["ahac"] }))).toBe(false);
    expect(reliefsOverlap(relief({ scope: ["rent", "carparks"] }), relief({ scope: ["carparks"] }))).toBe(true);
  });
});

describe("parseReliefs", () => {
  it("keeps the reliefs and their display fields, and drops anything else", () => {
    const raw = JSON.stringify([
      { ...relief(), ratifiedAt: "2025-02-20T01:00:00.000Z", ratifiedByName: "Dana", reason: "Fit-out works" },
      { ...relief({ id: "bad id!" }) },
      { ...relief({ id: "rel-2", kind: "amount", scope: ["ahac"] }) },
      "nonsense",
    ]);
    expect(parseReliefs(raw)).toEqual([{ ...relief(), ratifiedAt: "2025-02-20T01:00:00.000Z", ratifiedByName: "Dana", reason: "Fit-out works" }]);
  });

  it.each([null, undefined, "", "{}", "not json"])("reads %p as none", (raw) => {
    expect(parseReliefs(raw as string | null | undefined)).toEqual([]);
  });
});

describe("computeCharges at the edges", () => {
  const rows = computeScheduleRows([COMMENCEMENT], 0, 100);

  it("ends a relief the day after its last day", () => {
    expect(reliefEnd(relief())).toBe("2025-04-01");
    expect(reliefEnd(relief({ to: "2024-02-28" }))).toBe("2024-02-29");
  });

  it("breaks a tie between two reliefs starting the same day by id", () => {
    const schedule = computeCharges(rows, { fallbackAnnual: 0, reliefs: [relief({ id: "rel-z", value: 10 }), relief({ id: "rel-m", value: 20 })] });
    expect(chargedOn(schedule, "2025-03-10")).toMatchObject({ charged: { rent: 80000 }, reliefIds: ["rel-m"] });
  });

  it("charges nothing before a schedule that opens with its commencement", () => {
    const schedule = computeCharges(rows, { fallbackAnnual: 0, reliefs: [relief({ from: "2024-12-01", to: "2025-01-31" })] });
    expect(chargedOn(schedule, "2024-12-15")).toBeNull();
    expect(schedule.periods[0]).toMatchObject({ from: "2025-01-01", reliefIds: ["rel-1"], to: "2025-02-01" });
    expect(chargesOver(schedule, "2024-12-01", "2025-02-01").slices.map((slice) => slice.days)).toEqual([31]);
  });

  it("gives a tenancy without a schedule its stored rent, relieved", () => {
    const schedule = computeCharges([], { fallbackAnnual: 36500, reliefs: [relief()] });
    expect(schedule.rows).toEqual([]);
    expect(chargedOn(schedule, "2020-01-01")).toMatchObject({ charged: { rent: 36500 }, from: null, stepId: null });
    expect(chargedOn(schedule, "2025-03-15")).toMatchObject({ charged: { rent: 18250 }, reliefIds: ["rel-1"] });
    expect(chargesOver(schedule, "2025-03-01", "2025-04-01")).toMatchObject({ charged: { rent: 1550 }, lease: { rent: 3100 } });
  });

  it("knows no rent while a schedule's first review is pending and it has no base rent", () => {
    const pendingFirst = computeScheduleRows([{ effectiveFrom: "2025-01-01", id: "p", methodKind: "cpi", ratePercent: 0 }], 0, 0);
    expect(computeCharges(pendingFirst, { fallbackAnnual: 0 }).periods).toEqual([]);
  });

  it("never lets a row the same-day row replaces be in force", () => {
    const twice = computeScheduleRows(
      [COMMENCEMENT, { effectiveFrom: "2026-01-01", id: "x", methodKind: "fixed", ratePercent: 3 }, { effectiveFrom: "2026-01-01", id: "y", methodKind: "fixed", ratePercent: 5 }],
      0,
      100,
    );
    expect(computeCharges(twice, { fallbackAnnual: 0 }).periods.map((period) => period.stepId)).toEqual(["a", "y"]);
  });

  it("marks a pending change only on rows, never before the first one", () => {
    const schedule = computeCharges(rows, {
      fallbackAnnual: 0,
      pending: [
        { from: "2024-11-01", kind: "relief", requestId: "early", summary: "", to: "2024-11-30" },
        { from: null, kind: "relief", requestId: "undated", summary: "", to: null },
        { from: "2024-12-01", kind: "relief", requestId: "spans", summary: "", to: "2025-01-01" },
      ],
    });
    expect(schedule.rows[0].pendingChanges.map((marker) => marker.requestId)).toEqual(["spans"]);
  });
});

describe("the per-row ratchet exemption and rows keyed ahead (scheduledRateStepLogic.ts)", () => {
  const exempt = { at: "2025-07-15T02:00:00.000Z", byName: "Dana Director", reason: "Agreed with the tenant" };

  it("validates a step's exemption and keeps it", () => {
    const step = { effectiveFrom: "2025-07-01", methodKind: "cpi", ratchetExempt: { ...exempt, byName: "  Dana Director " }, ratePercent: 0 };
    expect(validateStep(step)).toMatchObject({ ok: true, step: { ratchetExempt: exempt } });
  });

  it.each([
    [{ at: "2025-07-15", byName: "", reason: "x" }, "byName"],
    [{ at: "soon", byName: "Dana", reason: "x" }, "ISO date"],
    [{ at: "2025-07-15", byName: "Dana", reason: " " }, "reason"],
    [{ at: "2025-07-15", byName: "Dana", reason: "x", by: 1 }, "Unknown key"],
    ["yes", "must be { byName, at, reason }"],
  ])("refuses the exemption %p", (ratchetExempt, message) => {
    const result = validateStep({ effectiveFrom: "2025-07-01", methodKind: "cpi", ratchetExempt, ratePercent: 0 });
    expect(result.ok ? "" : result.error).toContain(message);
  });

  it("accepts five years to the day before", () => {
    expect(validateReliefShape({ from: "2025-03-01", kind: "percent", scope: ["rent"], to: "2030-02-28", value: 5 }).ok).toBe(true);
  });

  it("refuses an exemption on a commencement row", () => {
    const result = validateStep({ ...COMMENCEMENT, id: "aaaaaaaa-0000-4000-8000-000000000001", ratchetExempt: exempt });
    expect(result.ok ? "" : result.error).toContain("review rows");
  });

  it("diffs an exemption by what it holds, not by object identity", () => {
    const base: ScheduledRateStep = { effectiveFrom: "2025-07-01", id: "s", methodKind: "cpi", ratchetExempt: exempt, ratePercent: 0 };
    expect(diffSteps(base, { ...base, ratchetExempt: { reason: exempt.reason, byName: exempt.byName, at: exempt.at } })).toBeNull();
    expect(diffSteps({ ...base, ratchetExempt: undefined }, base)).toEqual({ ratchetExempt: { from: null, to: exempt } });
  });

  it("holds an unsettled row dated on or after the live date for its review, and nothing else", () => {
    const row = (over: Partial<ScheduledRateStep>): ScheduledRateStep => ({ effectiveFrom: "2026-07-01", id: "r", methodKind: "fixed", ratePercent: 3, ...over });
    expect(stepPendingReason(row({}), "2026-07-01")).toBe("awaiting_review");
    expect(stepPendingReason(row({}), "2026-07-02")).toBeNull();
    expect(stepPendingReason(row({}))).toBeNull();
    expect(stepPendingReason(row({ resolution: "waived" }), "2026-01-01")).toBeNull();
    expect(stepPendingReason(row({ methodKind: "cpi", ratePercent: 0 }), "2027-01-01")).toBe("cpi_index_missing");
    expect(stepPendingReason(row({ methodKind: "commencement" }), "2026-01-01")).toBeNull();
  });
});

// The car park and misc fee port (rentReview/cascade.ts) against the shared
// fixtures' frontend blocks: what each row shows, a year's worth.
describe("ancillariesByRow against the frontend's car park and misc fee rows", () => {
  interface FrontendBlock {
    carparkGroups?: CarparkScheduleGroup[];
    carparkRows?: Array<Record<string, number>>;
    miscFees?: MiscFee[];
    miscRows?: Record<string, Array<{ annual: number }>>;
  }
  const withBlocks = (fixtures as unknown as { cases: Array<{ frontend?: FrontendBlock; input: { fallbackAnnual: number; fallbackSqm: number; steps: ScheduledRateStep[]; terms?: Record<string, unknown> }; name: string }> }).cases
    .filter((c) => c.frontend?.carparkRows || c.frontend?.miscRows);

  it("has blocks to check", () => {
    expect(withBlocks.length).toBeGreaterThanOrEqual(3);
  });

  it.each(withBlocks.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const rows = computeScheduleRows(c.input.steps, c.input.fallbackAnnual, c.input.fallbackSqm, c.input.terms ?? {});
    const block = c.frontend as FrontendBlock;
    const got = ancillariesByRow(rows, block.carparkGroups ?? [], block.miscFees ?? []);
    if (block.carparkRows && block.carparkRows.length === rows.length) {
      const want = block.carparkRows.map((perGroup) => Math.round(Object.values(perGroup).reduce((sum, monthly) => sum + monthly * 12, 0) * 100) / 100);
      expect(got.map((entry) => entry.carparks ?? 0)).toEqual(want);
    }
    for (const [feeId, feeRows] of Object.entries(block.miscRows ?? {})) {
      if (feeRows.length !== rows.length || (block.miscFees ?? []).length !== 1) continue;
      expect({ feeId, got: got.map((entry) => entry.miscFees) }).toEqual({ feeId, got: feeRows.map((feeRow) => feeRow.annual) });
    }
  });
});
