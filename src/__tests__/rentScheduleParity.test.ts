import assert from "node:assert";
import { todayInDarwin } from "../darwinDate";
import {
  type Charges,
  chargedOn,
  chargesOver,
  computeCharges,
  type ChargePeriod,
  type PendingChangeMarker,
  reliefForgone,
  type RentRelief,
  type RowAncillaries,
} from "../scheduleCharges";
import {
  computeScheduleRows,
  resolveCurrentRent,
  resolveScheduleAnnual,
  type ScheduledRateStep,
  type ScheduleTerms,
} from "../scheduledRateStepLogic";
import fixtures from "./rent-schedule-parity.fixtures.json";

// The same fixture file sits in command-centre (src/__tests__/helpers/) and is
// asserted there against the frontend engine. Change both or neither.

interface ExpectedRow {
  ahacAnnual: number | null;
  annual: number;
  appliedPercent: number | null;
  areaMissing: boolean;
  capApplied: boolean;
  effectiveFrom: string;
  floorApplied: boolean;
  monthly: number;
  pending: boolean;
  pendingReason: string | null;
  ratchetApplied: boolean;
  rawPercent: number | null;
  sqm: number;
  sqmRate: number;
}

interface CurrentCheck {
  annual?: number;
  effectiveFrom?: string;
  kind: string;
  now: string;
  startsOn?: string;
  today: string;
}

/** WP26c: the charge timeline over the rows (src/scheduleCharges.ts). */
interface ChargesExpected {
  forgone?: Array<{ byCharge: Charges; reliefId: string; total: number }>;
  on?: Array<{ chargedRent: number | null; day: string; leaseRent: number | null; reliefIds: string[]; stepId: string | null }>;
  over?: Array<{ charged: Charges; from: string; lease: Charges; to: string }>;
  periods: ChargePeriod[];
  rowPending: string[][];
}

interface ParityCase {
  expected: { charges?: ChargesExpected; current: CurrentCheck[]; rows: ExpectedRow[] };
  input: {
    ancillaries?: RowAncillaries[];
    fallbackAnnual: number;
    fallbackSqm: number;
    pending?: PendingChangeMarker[];
    reliefs?: RentRelief[];
    steps: ScheduledRateStep[];
    terms?: ScheduleTerms;
  };
  name: string;
}

const cases = (fixtures as unknown as { cases: ParityCase[] }).cases;

describe("rent schedule parity fixtures (backend engine)", () => {
  it("covers at least the 14 cases the plan requires", () => {
    assert.ok(cases.length >= 14, `only ${cases.length} cases`);
  });

  it("covers WP26c: relief, pending changes, a ratchet exemption, rows keyed ahead and a review inside a relief", () => {
    const withCharges = cases.filter((c) => c.expected.charges);
    assert.ok(withCharges.length >= 7, `only ${withCharges.length} charge cases`);
    const kinds = new Set(withCharges.flatMap((c) => (c.input.reliefs ?? []).map((relief) => relief.kind)));
    assert.deepStrictEqual([...kinds].sort(), ["amount", "fixed_rent", "percent"]);
    assert.ok(cases.some((c) => (c.input.pending ?? []).length > 0));
    assert.ok(cases.some((c) => c.input.steps.some((step) => step.ratchetExempt)));
    assert.ok(cases.some((c) => c.expected.rows.some((row) => row.pendingReason === "awaiting_review")));
  });

  describe.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const terms = c.input.terms ?? {};
    const rows = computeScheduleRows(c.input.steps, c.input.fallbackAnnual, c.input.fallbackSqm, terms);

    it("yields the expected rows", () => {
      assert.deepStrictEqual(
        rows.map((row) => ({
          ahacAnnual: row.ahacAnnual,
          annual: row.annual,
          appliedPercent: row.appliedPercent,
          areaMissing: row.areaMissing,
          capApplied: row.capApplied,
          effectiveFrom: row.step.effectiveFrom,
          floorApplied: row.floorApplied,
          monthly: row.monthly,
          pending: row.pending,
          pendingReason: row.pendingReason,
          ratchetApplied: row.ratchetApplied,
          rawPercent: row.rawPercent,
          sqm: row.sqm,
          sqmRate: row.sqmRate,
        })),
        c.expected.rows,
      );
    });

    it.each(c.expected.current.map((check) => [check.now, check] as const))(
      "resolves today's rent at %s (Darwin date)",
      (_now, check) => {
        const today = todayInDarwin(new Date(check.now));
        assert.strictEqual(today, check.today);
        const current = resolveCurrentRent(rows, c.input.fallbackAnnual, today);
        assert.strictEqual(current.kind, check.kind);
        if (current.kind === "row") {
          assert.strictEqual(current.row.step.effectiveFrom, check.effectiveFrom);
          assert.strictEqual(current.row.annual, check.annual);
        }
        if (current.kind === "notStarted") assert.strictEqual(current.startsOn, check.startsOn);
        const resolved = resolveScheduleAnnual(c.input.steps, c.input.fallbackAnnual, c.input.fallbackSqm, today, terms);
        assert.strictEqual(resolved.annual, check.annual ?? 0);
        assert.strictEqual(resolved.startsOn, check.startsOn ?? null);
      },
    );

    const charges = c.expected.charges;
    if (!charges) return;
    const input = {
      ancillaries: c.input.ancillaries,
      fallbackAnnual: c.input.fallbackAnnual,
      pending: c.input.pending ?? [],
      reliefs: c.input.reliefs ?? [],
    };
    const schedule = computeCharges(rows, input);

    it("lays the ratified reliefs over the rows: lease and charged figures, period by period", () => {
      assert.deepStrictEqual(schedule.periods, charges.periods);
      // Every row's own periods are the ones it is in force for.
      for (const row of schedule.rows) {
        assert.deepStrictEqual(row.periods, charges.periods.filter((period) => period.stepId === row.stepId));
      }
    });

    it("marks each row with the pending changes that touch it, and leaves them out of every figure", () => {
      assert.deepStrictEqual(schedule.rows.map((row) => row.pendingChanges.map((marker) => marker.requestId)), charges.rowPending);
      const unrelieved = computeCharges(rows, { ...input, pending: [] });
      assert.deepStrictEqual(unrelieved.periods, schedule.periods);
    });

    const onChecks = charges.on ?? [];
    const overChecks = charges.over ?? [];
    const forgoneChecks = charges.forgone ?? [];

    if (onChecks.length > 0) it.each(onChecks.map((check) => [check.day, check] as const))("charges on %s", (day, check) => {
      const period = chargedOn(schedule, day);
      assert.ok(period, `nothing charged on ${day}`);
      assert.deepStrictEqual(
        { chargedRent: period.charged.rent, leaseRent: period.lease.rent, reliefIds: period.reliefIds, stepId: period.stepId },
        { chargedRent: check.chargedRent, leaseRent: check.leaseRent, reliefIds: check.reliefIds, stepId: check.stepId },
      );
    });

    if (overChecks.length > 0) it.each(overChecks.map((check) => [`${check.from}..${check.to}`, check] as const))("totals %s pro rata", (_label, check) => {
      const totals = chargesOver(schedule, check.from, check.to);
      assert.deepStrictEqual({ charged: totals.charged, lease: totals.lease }, { charged: check.charged, lease: check.lease });
    });

    if (forgoneChecks.length > 0) it.each(forgoneChecks.map((check) => [check.reliefId, check] as const))("works out what relief %s forgoes", (reliefId, check) => {
      const relief = input.reliefs.find((candidate) => candidate.id === reliefId);
      assert.ok(relief, `no relief ${reliefId}`);
      assert.deepStrictEqual(reliefForgone(rows, input, relief), { byCharge: check.byCharge, total: check.total });
    });
  });
});
