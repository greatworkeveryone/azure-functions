import assert from "node:assert";
import { todayInDarwin } from "../darwinDate";
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

interface ParityCase {
  expected: { current: CurrentCheck[]; rows: ExpectedRow[] };
  input: { fallbackAnnual: number; fallbackSqm: number; steps: ScheduledRateStep[]; terms?: ScheduleTerms };
  name: string;
}

const cases = (fixtures as unknown as { cases: ParityCase[] }).cases;

describe("rent schedule parity fixtures (backend engine)", () => {
  it("covers at least the 14 cases the plan requires", () => {
    assert.ok(cases.length >= 14, `only ${cases.length} cases`);
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
  });
});
