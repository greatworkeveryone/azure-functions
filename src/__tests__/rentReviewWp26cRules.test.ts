/// <reference types="jest" />
// WP26c on the review flow, through the real handlers against the in-memory
// database (fixtures/rentReviewWorld.ts):
//   C9 (D23)  a rent below the lease's ratchet: anyone may submit it, it waits for
//             a director, who overrides the ratchet for that review with a reason
//             (at approve, or at submit when a director submits); the applied row
//             carries ratchetExempt and the engine honours it for that row alone;
//             a rent_review.director_override row records it
//   M4        the lease's CPI reference-quarter rule is used by the calculation,
//             and a basis on another rule is a departure
//   Q19       waive's and revert's financialImpact include AHAC, car parks and misc fees
import type { InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { approveRentReview } from "../functions/approveRentReview";
import { calculateRentReview } from "../functions/calculateRentReview";
import { getRentReview } from "../functions/getRentReview";
import { revertRentReview } from "../functions/revertRentReview";
import { submitRentReview } from "../functions/submitRentReview";
import { waiveRentReview } from "../functions/waiveRentReview";
import { previousQuarter, referenceQuarterFor } from "../rentReview/cpi";
import { calculateReview, LEASE_RATCHET_MESSAGE, leaseDepartures } from "../rentReviewCalc";
import { computeScheduleRows, parseSteps, type ScheduledRateStep } from "../scheduledRateStepLogic";
import { getRequest, postRequest } from "./fixtures/rentReviewFakes";
import { basis, COMMENCED, PEOPLE, REVIEW_DATE, seed, steps, versionOf, type Person } from "./fixtures/rentReviewScenario";
import { ReviewWorld, useWorld } from "./fixtures/rentReviewWorld";

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn() }));
jest.mock("../tenant-register-cache", () => ({ invalidateTenantAndBuilding: jest.fn() }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../rentReview/escalations", () => ({
  ...jest.requireActual("../rentReview/escalations"),
  raiseApprovalEscalation: jest.fn().mockResolvedValue(null),
  settleReviewEscalations: jest.fn().mockResolvedValue(0),
}));

const db = require("../db") as Record<string, jest.Mock>;
const { resolveLedgerActor } = require("../ledger/actor") as { resolveLedgerActor: jest.Mock };
const escalations = require("../rentReview/escalations") as { raiseApprovalEscalation: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

/** A second director, so one can approve what another submitted. */
const DAN = { kind: "user", name: "Dan Director", role: "director", userId: 12 } as const;
const LEASE = { cpiCapPercent: 5, cpiFloorPercent: 1, reviewRatchet: true };
const CUT = { newAnnual: 120000, reason: "Hardship agreed with the tenant" };
const RATCHET = { checks: ["ratchet"], reason: "Directors pass the fall on for this review" };
const r2 = (n: number) => Math.round(n * 100) / 100;

let world: ReviewWorld;
let caller: Person | typeof DAN = PEOPLE.ann;
const as = (person: Person | typeof DAN) => {
  caller = person;
};
type Handler = typeof submitRentReview;
const call = (handler: Handler, body: Record<string, unknown> = {}) =>
  handler(postRequest({ reviewId: "rev-1", rowVersion: versionOf(world), ...body }, caller.role), ctx);
const json = (res: { jsonBody?: unknown }) => res.jsonBody as Record<string, any>;
const ledger = (action: string) => world.ledgerRows().filter((row) => row.Action === action);
const storedCalc = () => JSON.parse(String(world.review("rev-1").Calc)) as Record<string, any>;
const tenancySteps = () => parseSteps(String(world.tenant(7).ScheduledRateSteps));
const reviewStep = () => tenancySteps().find((step) => step.effectiveFrom === REVIEW_DATE);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  delete process.env.REVIEW_WORKFLOW_LIVE_FROM;
  delete process.env.REVIEW_SANITY_MAX_PERCENT;
  delete process.env.REVIEW_SANITY_MIN_PERCENT;
  world = new ReviewWorld();
  useWorld(() => world, db);
  resolveLedgerActor.mockImplementation(async () => caller);
  as(PEOPLE.ann);
});

/** Calculates as Ann, then hands the review on with an empty ledger. */
async function calculated(over: Parameters<typeof seed>[1] = {}): Promise<void> {
  seed(world, over);
  as(PEOPLE.ann);
  expect((await call(calculateRentReview)).status).toBe(200);
  world.state.ledger = [];
  jest.clearAllMocks();
}

/** The review's row under the lease's ratchet, and the same row without its exemption. */
function rowWithAndWithout(step: ScheduledRateStep | undefined) {
  const all = tenancySteps();
  const exempt = computeScheduleRows(all, 0, 400, LEASE).find((row) => row.step.id === step?.id);
  const stripped = all.map((candidate) => (candidate.id === step?.id ? { ...candidate, ratchetExempt: undefined } : candidate));
  const held = computeScheduleRows(stripped, 0, 400, LEASE).find((row) => row.step.id === step?.id);
  return { exempt, held };
}

describe("C9: a rent below the lease's ratchet waits for a director's override of it (D23, WP26c)", () => {
  it("accounts submit it; it waits for a director, marked as needing the ratchet overridden, and nothing reaches the schedule", async () => {
    await calculated();
    const res = await call(submitRentReview, { override: CUT });
    expect(res.status).toBe(200);
    expect(json(res)).toMatchObject({ applied: false, review: { state: "awaiting_approval" } });
    expect(storedCalc()).toMatchObject({ override: { newAnnual: 120000 }, ratchetOverrideNeeded: true });
    expect(escalations.raiseApprovalEscalation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ reasons: ["override", "reduction", "ratchet"], startAtRole: "director" }),
    );
    expect(ledger("rent_review.director_override")).toEqual([]);
    expect(reviewStep()?.resolution).toBeUndefined();
  });

  it("a director approving without the override is told a director can override it, and nothing is written", async () => {
    await calculated();
    await call(submitRentReview, { override: CUT });
    as(PEOPLE.dee);
    const before = world.picture();
    const res = await call(approveRentReview);
    expect(res.status).toBe(422);
    expect(json(res)).toEqual({ code: "ratchet", directorCanOverride: true, error: LEASE_RATCHET_MESSAGE });
    expect(LEASE_RATCHET_MESSAGE).toMatch(/can't go down on review unless a director overrides the ratchet for this review, with a reason\.$/);
    expect(world.picture()).toBe(before);
  });

  it("no one below a director can approve it (A3)", async () => {
    await calculated();
    await call(submitRentReview, { override: CUT });
    for (const person of [PEOPLE.bo, PEOPLE.cy]) {
      as(person);
      expect(json(await call(approveRentReview, {}))).toMatchObject({ code: "approval_level", requiredRole: "director" });
    }
    as(PEOPLE.bo);
    expect(json(await call(approveRentReview, { directorOverride: RATCHET }))).toMatchObject({ code: "forbidden" });
    expect(reviewStep()?.resolution).toBeUndefined();
  });

  it("the approving director overrides it with a reason: the row is written exempt, and only that row", async () => {
    await calculated();
    await call(submitRentReview, { override: CUT });
    as(DAN);
    const res = await call(approveRentReview, { directorOverride: RATCHET });
    expect(res.status).toBe(200);
    const step = reviewStep();
    expect(step).toMatchObject({ ratchetExempt: { at: expect.any(String), byName: "Dan Director", reason: RATCHET.reason }, resolution: "applied" });
    const { exempt, held } = rowWithAndWithout(step);
    expect(exempt).toMatchObject({ annual: 120000, ratchetApplied: false });
    // Without the exemption the lease's ratchet holds the same row at the rent before it.
    expect(held).toMatchObject({ ratchetApplied: true });
    expect(held?.annual).toBeGreaterThan(120000);
    expect(tenancySteps().filter((candidate) => candidate.ratchetExempt)).toHaveLength(1);

    const [override] = ledger("rent_review.director_override");
    expect(override).toMatchObject({ ActorUserId: 12, IsException: true, Reason: RATCHET.reason, RuleApplied: "C9_ratchet" });
    expect(override.after).toMatchObject({ check: "C9", code: "ratchet" });
    expect(override.computed).toMatchObject({ chosenAnnual: 120000, leaseRatchet: true });
    expect(ledger("rent_review.apply")[0].after).toMatchObject({ outcome: { newAnnual: 120000 }, step: { ratchetExempt: { byName: "Dan Director" } } });
    const order = world.ledgerRows().map((row) => row.Action);
    const decided = order.indexOf("rent_review.approve");
    expect(order.slice(decided, decided + 3)).toEqual(["rent_review.approve", "rent_review.director_override", "rent_review.apply"]);
  });

  it("a director submitting overrides it then: it rides in the calc and APPLY honours it at approve", async () => {
    await calculated();
    as(PEOPLE.dee);
    const submitted = await call(submitRentReview, { directorOverride: RATCHET, override: CUT });
    expect(json(submitted)).toMatchObject({ applied: false, review: { state: "awaiting_approval" } });
    const calc = storedCalc();
    expect(calc.ratchetOverrideNeeded).toBeUndefined();
    expect(calc.directorOverrides).toEqual([expect.objectContaining({ by: { name: "Dee Director", userId: 10 }, check: "ratchet", reason: RATCHET.reason })]);
    expect(escalations.raiseApprovalEscalation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reasons: ["override", "reduction"] }));
    expect(ledger("rent_review.director_override")).toEqual([expect.objectContaining({ ActorUserId: 10, RuleApplied: "C9_ratchet" })]);

    as(DAN);
    expect((await call(approveRentReview)).status).toBe(200);
    expect(reviewStep()?.ratchetExempt).toMatchObject({ byName: "Dee Director", reason: RATCHET.reason });
    // The one override row: the one made at submit rode through.
    expect(ledger("rent_review.director_override")).toHaveLength(1);
  });

  it("the submitting director may approve it too (D23: never blocked by separation of duties)", async () => {
    await calculated();
    as(PEOPLE.dee);
    await call(submitRentReview, { directorOverride: RATCHET, override: CUT });
    expect((await call(approveRentReview)).status).toBe(200);
    expect(reviewStep()?.ratchetExempt).toMatchObject({ byName: "Dee Director" });
  });

  it("is a director's alone to send", async () => {
    await calculated();
    as(PEOPLE.bo);
    expect(json(await call(submitRentReview, { directorOverride: RATCHET, override: CUT }))).toMatchObject({ code: "forbidden" });
    expect(ledger("denied")).toEqual([expect.objectContaining({ RuleApplied: "director_override_not_director" })]);
  });

  it("calculates a decrease below the lease's ratchet, marked as needing the override, instead of refusing it", async () => {
    seed(world, { review: { Basis: JSON.stringify({ method: "other", ratchet: true }), Method: "other" } });
    const res = await call(calculateRentReview, { manual: { explanation: "Agreed at mediation", newAnnual: 118000 } });
    expect(res.status).toBe(200);
    expect(storedCalc()).toMatchObject({ newAnnual: 118000, ratchetOverrideNeeded: true });
    // The receipt is the row as APPLY writes it once a director overrides the ratchet.
    expect(storedCalc().arrears.lines[0].amount).toBeLessThan(0);
  });

  it("leaves a rise on a ratchet lease as it was: no override needed, one step", async () => {
    await calculated();
    expect(storedCalc().ratchetOverrideNeeded).toBeUndefined();
    expect(json(await call(submitRentReview))).toMatchObject({ applied: true });
    expect(reviewStep()?.ratchetExempt).toBeUndefined();
  });
});

describe("M4: the lease's CPI reference quarter", () => {
  it.each([
    ["2026-07-15", "quarter_before_review_date", "2026-Q2"],
    ["2026-07-15", "latest_published_before_review", "2026-Q1"],
    // A quarter released on the review date itself isn't published before it.
    ["2026-07-30", "latest_published_before_review", "2026-Q1"],
    ["2026-07-31", "latest_published_before_review", "2026-Q2"],
    ["2026-10-01", "latest_published_before_review", "2026-Q2"],
    ["2026-10-01", "quarter_before_review_date", "2026-Q3"],
  ])("a review on %s under %s reads %s", (date, rule, quarter) => {
    expect(referenceQuarterFor(rule as never, date)).toBe(quarter);
  });

  it("is what the calculation reads its index pair by", () => {
    const run = (rule: string) =>
      calculateReview({
        basis: { capPercent: null, floorPercent: null, intervalMonths: 12, method: "cpi", ratchet: false, referenceQuarterRule: rule, region: "AUS" },
        carparkGroups: [],
        computedAt: "2026-07-20T00:00:00.000Z",
        computedBy: { name: "Ann", userId: 7 },
        cpiRows: [
          { indexValue: 100, period: "2025-Q1", referenceBase: "B" },
          { indexValue: 102, period: "2026-Q1", referenceBase: "B" },
          { indexValue: 100, period: "2025-Q2", referenceBase: "B" },
          { indexValue: 104, period: "2026-Q2", referenceBase: "B" },
        ],
        fallbackAnnual: 0,
        fallbackSqm: 0,
        lease: { cpiCapPercent: null, cpiFloorPercent: null, reviewRatchet: false },
        method: "cpi",
        miscFees: [],
        newStepId: "aaaaaaaa-0000-4000-8000-0000000000aa",
        reviewId: "rev",
        sanity: { maxPercent: 15, minPercent: -5 },
        scheduledFor: "2026-07-15",
        scheduleVersion: 1,
        stepId: null,
        steps: [{ baseRentPerAnnum: 100000, effectiveFrom: "2025-07-15", id: "aaaaaaaa-0000-4000-8000-0000000000bb", methodKind: "commencement", ratePercent: 0 }],
        today: "2026-07-20",
      });
    const latest = run("latest_published_before_review");
    const before = run("quarter_before_review_date");
    expect(latest).toMatchObject({ calc: { cpi: { previousQuarter: "2025-Q1", referenceQuarter: "2026-Q1" }, newAnnual: 102000 }, kind: "calc" });
    expect(before).toMatchObject({ calc: { cpi: { previousQuarter: "2025-Q2", referenceQuarter: "2026-Q2" }, newAnnual: 104000 }, kind: "calc" });
    expect(previousQuarter("2026-Q1", 12)).toBe("2025-Q1");
  });

  it("makes a basis on another rule a departure, and the lease's own rule none", () => {
    const lease = { cpiCapPercent: 5, cpiFloorPercent: 1, cpiReferenceRule: "latest_published_before_review", cpiRegion: "DARWIN", fixedPercent: null, reviewIntervalMonths: 12, reviewRatchet: true };
    expect(leaseDepartures("cpi", basis({ referenceQuarterRule: "latest_published_before_review" }), lease)).toEqual([]);
    expect(leaseDepartures("cpi", basis(), lease)).toEqual(["referenceQuarterRule"]);
    // A tenancy that names no rule has the default one.
    expect(leaseDepartures("cpi", basis(), { ...lease, cpiReferenceRule: null })).toEqual([]);
    expect(leaseDepartures("cpi", basis({ referenceQuarterRule: "latest_published_before_review" }), { ...lease, cpiReferenceRule: null })).toEqual([
      "referenceQuarterRule",
    ]);
  });

  it("sends a review whose basis departs from the lease's rule to approval, set beside the lease's own result", async () => {
    await calculated({ tenant: { CpiReferenceQuarterRule: "latest_published_before_review" } });
    const res = await call(submitRentReview);
    expect(json(res)).toMatchObject({ applied: false, review: { state: "awaiting_approval" } });
    expect(ledger("rent_review.submit")[0].after).toMatchObject({ departures: ["referenceQuarterRule"], reasons: ["basis_departs_from_lease"] });
    expect(ledger("rent_review.basis_departure")).toEqual([expect.objectContaining({ RuleApplied: "departs:referenceQuarterRule" })]);
  });

  it("shows the rule on the CPI suggestion and on the workspace's tenancy", async () => {
    seed(world, {
      review: { Basis: JSON.stringify(basis({ referenceQuarterRule: "latest_published_before_review" })) },
      tenant: { CpiReferenceQuarterRule: "latest_published_before_review" },
    });
    const res = await getRentReview(getRequest({ reviewId: "rev-1" }), ctx);
    expect(res.status).toBe(200);
    expect(json(res).cpiSuggestion).toMatchObject({ referenceQuarter: referenceQuarterFor("latest_published_before_review", REVIEW_DATE), rule: "latest_published_before_review" });
    expect(json(res).tenancy).toMatchObject({ cpiReferenceQuarterRule: "latest_published_before_review" });
  });
});

describe("Q19: waive's and revert's $ impact include the charges that follow the rent", () => {
  const GROUP = { baseMonthlyRate: 1000, carparkIds: [], commencedAt: COMMENCED, id: "bbbbbbbb-0000-4000-8000-000000000001", label: "Basement bays", rateSteps: [] };
  const FEE = { baseAmount: 500, commencedAt: COMMENCED, frequency: "monthly", id: "bbbbbbbb-0000-4000-8000-000000000002", rateSteps: [], title: "Signage" };
  /** AHAC on the commencement row, a car park group and a monthly fee, all following the rent. */
  function withCharges(): Record<string, unknown> {
    const rows = steps();
    rows[0] = { ...rows[0], ahacBasePerAnnum: 6000 };
    return { CarparkScheduleGroups: JSON.stringify([GROUP]), MiscFees: JSON.stringify([FEE]), ScheduledRateSteps: JSON.stringify(rows) };
  }
  const increaseOf = (cascade: Array<{ currentAnnual: number; newAnnual: number }>) => r2(cascade.reduce((sum, row) => sum + row.newAnnual - row.currentAnnual, 0));

  it("waive: the rent's increase and the AHAC, car park and misc fee increases the review would have made", async () => {
    await calculated({ tenant: withCharges() });
    const calc = storedCalc();
    expect(calc.cascade.map((row: { kind: string }) => row.kind).sort()).toEqual(["ahac", "carpark", "misc_fee"]);
    const ancillary = increaseOf(calc.cascade);
    expect(ancillary).toBeGreaterThan(0);
    as(PEOPLE.bo);
    expect((await call(waiveRentReview, { reason: "Tenant hardship" })).status).toBe(200);
    const [row] = ledger("rent_review.waive");
    expect(row.FinancialImpact).toBe(r2(calc.newAnnual - calc.currentAnnual + ancillary));
    expect(row.computed).toMatchObject({ ancillary: { increase: ancillary }, source: "calc" });
  });

  it("waive of a review never calculated estimates the charges too, as a calculation would", async () => {
    // What calculating the same review gives, in a world of its own.
    const waiving = world;
    world = new ReviewWorld();
    await calculated({ tenant: withCharges() });
    const expected = increaseOf(storedCalc().cascade);
    world = waiving;

    seed(world, { tenant: withCharges() });
    as(PEOPLE.bo);
    expect((await call(waiveRentReview, { reason: "Not pursued" })).status).toBe(200);
    const [row] = ledger("rent_review.waive");
    const computed = row.computed as { ancillary: { current: number; increase: number; new: number }; currentAnnual: number; newAnnual: number; source: string };
    expect(computed.source).toBe("estimate");
    expect(computed.ancillary.increase).toBe(expected);
    expect(computed.ancillary.increase).toBe(r2(computed.ancillary.new - computed.ancillary.current));
    expect(row.FinancialImpact).toBe(r2(computed.newAnnual - computed.currentAnnual + computed.ancillary.increase));
  });

  it("revert: the increase undone, the rent's and the charges'", async () => {
    await calculated({ tenant: withCharges() });
    const calc = storedCalc();
    const ancillary = increaseOf(calc.cascade);
    expect(json(await call(submitRentReview))).toMatchObject({ applied: true });
    as(PEOPLE.bo);
    expect((await call(revertRentReview, { reason: "Applied with the wrong CPI region" })).status).toBe(200);
    const [row] = ledger("rent_review.revert");
    expect(row.FinancialImpact).toBe(r2(calc.newAnnual - calc.currentAnnual + ancillary));
    expect(row.computed).toMatchObject({ ancillary: { increase: ancillary } });
  });

  it("is the rent's alone where nothing follows it", async () => {
    await calculated();
    const calc = storedCalc();
    as(PEOPLE.bo);
    await call(waiveRentReview, { reason: "Tenant hardship" });
    expect(ledger("rent_review.waive")[0]).toMatchObject({ FinancialImpact: r2(calc.newAnnual - calc.currentAnnual) });
  });
});
