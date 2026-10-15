/// <reference types="jest" />
// WP26 calculate -> submit -> approve, end to end through the real handlers,
// the real calc and APPLY, the real ledger (its INSERTs land in the in-memory
// database and are read back as stored), against an in-memory SQL Server
// stand-in that rolls back for real. Auth runs through the real requireRole
// (dev role header). Escalation raise/settle are mocked here (their own tests
// cover them) and asserted to run after the commit.
import type { InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { approveRentReview } from "../functions/approveRentReview";
import { calculateRentReview } from "../functions/calculateRentReview";
import { submitRentReview } from "../functions/submitRentReview";
import { computeScheduleRows, parseSteps } from "../scheduledRateStepLogic";
import { postRequest } from "./fixtures/rentReviewFakes";
import {
  basis,
  LAST_YEAR,
  NEXT_ANNIVERSARY,
  PEOPLE,
  REFERENCE,
  REVIEW_DATE,
  seed,
  STEP_IDS,
  steps,
  TODAY,
  versionOf,
  type Person,
} from "./fixtures/rentReviewScenario";
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
const cache = require("../tenant-register-cache") as { invalidateTenantAndBuilding: jest.Mock };
const planner = require("../planner") as { resolveActivePlannerTasks: jest.Mock };
const escalations = require("../rentReview/escalations") as { raiseApprovalEscalation: jest.Mock; settleReviewEscalations: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

let world: ReviewWorld;
let caller: Person = PEOPLE.ann;
const as = (person: Person) => {
  caller = person;
};

const calculate = (body: Record<string, unknown> = {}) =>
  calculateRentReview(postRequest({ reviewId: "rev-1", rowVersion: versionOf(world), ...body }, caller.role), ctx);
const submit = (body: Record<string, unknown> = {}) =>
  submitRentReview(postRequest({ reviewId: "rev-1", rowVersion: versionOf(world), ...body }, caller.role), ctx);
const approve = (body: Record<string, unknown> = {}) =>
  approveRentReview(postRequest({ reviewId: "rev-1", rowVersion: versionOf(world), ...body }, caller.role), ctx);
const actions = () => world.ledgerRows().map((row) => row.Action);
const reviewBody = (res: { jsonBody?: unknown }) => (res.jsonBody as { review: Record<string, any> }).review;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  delete process.env.PLANNER_SYNC_ENABLED;
  delete process.env.REVIEW_SANITY_MAX_PERCENT;
  delete process.env.REVIEW_SANITY_MIN_PERCENT;
  delete process.env.REVIEW_WORKFLOW_LIVE_FROM;
  world = new ReviewWorld();
  useWorld(() => world, db);
  resolveLedgerActor.mockImplementation(async () => caller);
  as(PEOPLE.ann);
});

/** Calculates as Ann, then hands the review on. */
async function calculated(over: Parameters<typeof seed>[1] = {}): Promise<void> {
  seed(world, over);
  as(PEOPLE.ann);
  const res = await calculate();
  expect(res.status).toBe(200);
  world.state.ledger = [];
  world.log = [];
  jest.clearAllMocks(); // calls only: what the test does next is what it asserts on
}

// ── calculate ────────────────────────────────────────────────────────────────

describe("calculateRentReview", () => {
  it.each(["accounts", "accounts_manager", "cfo", "director", "admin"])("lets %s calculate (the commence set)", async (role) => {
    seed(world);
    const res = await calculateRentReview(postRequest({ reviewId: "rev-1", rowVersion: versionOf(world) }, role), ctx);
    expect(res.status).toBe(200);
  });

  it.each(["facilities", "facilities_manager", "user"])("refuses %s before touching the database", async (role) => {
    seed(world);
    const res = await calculateRentReview(postRequest({ reviewId: "rev-1", rowVersion: versionOf(world) }, role), ctx);
    expect(res.status).toBe(403);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("works a CPI review out on the server and stores the receipt, ledgered as rent_review.calculate (not an exception)", async () => {
    seed(world);
    const res = await calculate();
    expect(res.status).toBe(200);
    const review = reviewBody(res);
    expect(review.state).toBe("in_progress");
    expect(review.calc).toMatchObject({
      appliedPercent: 3.2,
      bounds: { capPercent: 5, clampedBy: null, floorPercent: 1, ratchet: true, ratcheted: false },
      computedBy: { name: "Ann Accounts", userId: 7 },
      cpi: { current: 103.2, previous: 100, referenceBase: "Sep 2025 = 100.0", referenceQuarter: REFERENCE, region: "DARWIN" },
      currentAnnual: 123711.34,
      method: "cpi",
      newAnnual: 127670.1,
      scheduleVersion: 4,
      sanity: { inBand: true },
    });
    expect(review.calc.arrears).toMatchObject({ from: REVIEW_DATE, to: TODAY });
    const [row] = world.ledgerRows();
    expect(row).toMatchObject({ Action: "rent_review.calculate", IsException: false, RuleApplied: "cpi_quarter_before_review_date", SubjectId: "rev-1", TenantId: 7 });
    expect(world.tenant(7).ScheduleVersion).toBe(4); // calculating writes nothing to the schedule
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(7, 5);
  });

  it("parks a CPI review whose reference quarter isn't published: awaiting_index, expected at quarter end + 30 days, no calc, a 200", async () => {
    seed(world, { cpi: null });
    const res = await calculate();
    expect(res.status).toBe(200);
    const review = reviewBody(res);
    expect(review).toMatchObject({ calc: null, state: "awaiting_index" });
    expect(review.expectedIndexAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(world.ledgerRows()).toEqual([
      expect.objectContaining({ Action: "rent_review.index_pending", RuleApplied: "reference_quarter_unpublished" }),
    ]);
    expect(world.ledgerRows()[0].after).toMatchObject({ referenceQuarter: REFERENCE, state: "awaiting_index" });
  });

  it("refuses a market review: directors record those, in a later workflow", async () => {
    seed(world, { review: { Basis: JSON.stringify({ ...basis(), method: "market" }), Method: "market" } });
    const before = world.picture();
    const res = await calculate();
    expect(res.status).toBe(422);
    expect(res.jsonBody).toMatchObject({ code: "method_not_supported", error: "Market reviews are recorded by directors; that workflow arrives later" });
    expect(world.picture()).toBe(before);
  });

  it("needs the new rent and an explanation for an `other` review, and takes them", async () => {
    seed(world, { review: { Basis: JSON.stringify({ method: "other", ratchet: true }), Method: "other" } });
    expect((await calculate()).jsonBody).toMatchObject({ code: "manual_required" });
    const res = await calculate({ manual: { explanation: "Agreed after the fit-out", newAnnual: 130000 } });
    expect(res.status).toBe(200);
    expect(reviewBody(res).calc).toMatchObject({ manual: { explanation: "Agreed after the fit-out", newAnnual: 130000 }, method: "other", newAnnual: 130000 });
  });

  it("refuses a hand-keyed rent on a CPI review", async () => {
    seed(world);
    expect((await calculate({ manual: { explanation: "x", newAnnual: 1 } })).status).toBe(400);
  });

  it.each(["scheduled", "due", "awaiting_index", "awaiting_approval", "approved", "waived", "cancelled"])("refuses a %s review with a 409", async (state) => {
    seed(world, { review: { State: state } });
    const res = await calculate();
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "invalid_state" });
  });

  it("is a 409 with the current review on a stale rowVersion", async () => {
    seed(world);
    const res = await calculate({ rowVersion: "0000000000000001" });
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "stale", current: { reviewId: "rev-1" } });
  });

  it.each([
    [{ ArchivedAt: new Date() }, "tenancy_archived"],
    [{ Status: "vacated" }, "tenancy_vacated"],
  ])("gives WP25's 422 for a closed tenancy (%j)", async (tenant, code) => {
    seed(world, { tenant });
    const res = await calculate();
    expect(res.status).toBe(422);
    expect(res.jsonBody).toMatchObject({ code });
  });
});

// ── submit ───────────────────────────────────────────────────────────────────

describe("submitRentReview: an in-bounds CPI result applies in one step (auto_in_bounds)", () => {
  it("applies it: the step, the change log, the tenancy, the outcome and the ledger, in one transaction", async () => {
    await calculated();
    const res = await submit();
    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ applied: true });
    const review = reviewBody(res);
    expect(review).toMatchObject({
      approval: { basis: "auto_in_bounds", name: "Ann Accounts", userId: 7 },
      prepared: { name: "Ann Accounts", userId: 7 },
      state: "approved",
      stepId: STEP_IDS.review,
    });
    expect(review.outcome).toMatchObject({ appliedPercent: 3.2, newAnnual: 127670.1, oldAnnual: 123711.34 });
    expect(review.outcome.arrears).toMatchObject({ billed: false, from: REVIEW_DATE, to: TODAY });

    // The schedule step: the CPI pair on one base, applied, linked to the review.
    const tenant = world.tenant(7);
    const written = parseSteps(String(tenant.ScheduledRateSteps)).find((step) => step.id === STEP_IDS.review);
    expect(written).toMatchObject({ cpiValue: 103.2, cpiValuePrev: 100, methodKind: "cpi", ratePercent: 3.2, resolution: "applied", reviewId: "rev-1" });
    // The engine now says what the receipt said.
    const rows = computeScheduleRows(parseSteps(String(tenant.ScheduledRateSteps)), 0, 400, { cpiCapPercent: 5, cpiFloorPercent: 1, reviewRatchet: true });
    expect(rows.at(-1)?.annual).toBe(127670.1);
    expect(tenant).toMatchObject({
      LastReviewDate: REVIEW_DATE,
      LastReviewIncreasePercent: 3.2,
      NextReviewDate: NEXT_ANNIVERSARY,
      RentPerAnnum: 127670.1,
      ScheduleSignedOffByName: "Bo Manager", // D7: sign-off kept
      ScheduleVersion: 5,
      UpdatedByName: "Ann Accounts",
    });
    expect(tenant.ScheduleSignedOffAt).not.toBeNull();
    expect(world.state.changeLog).toEqual([expect.objectContaining({ ChangeKind: "updated", StepId: STEP_IDS.review, TenantId: 7 })]);
    // The decision and its apply, then (after the commit) the next review, scheduled as the system.
    expect(actions()).toEqual(["rent_review.submit", "rent_review.apply", "rent_review.schedule"]);
    const [submitted, applied] = world.ledgerRows();
    expect(submitted).toMatchObject({ Action: "rent_review.submit", RuleApplied: "auto_in_bounds" });
    expect(applied).toMatchObject({ Action: "rent_review.apply", RuleApplied: "auto_in_bounds" });
    expect(applied.after).toMatchObject({ rentPerAnnumCache: "written", representation: "natural", tenancy: { lastReviewDate: REVIEW_DATE, scheduleVersion: 5 } });
    expect(submitted.CorrelationId).toBe(applied.CorrelationId);
    expect(world.committed).toBeGreaterThanOrEqual(1);
  });

  it("then schedules the tenancy's next review, by the generator's own function, after the commit", async () => {
    await calculated();
    const res = await submit();
    expect(res.jsonBody).toMatchObject({ nextReview: { scheduledFor: NEXT_ANNIVERSARY, state: "scheduled" } });
    const next = world.state.reviews.filter((r) => r.ReviewId !== "rev-1");
    expect(next).toEqual([expect.objectContaining({ Method: "cpi", ScheduledFor: NEXT_ANNIVERSARY, State: "scheduled", TenantId: 7 })]);
    expect(world.ledgerRows().find((r) => r.Action === "rent_review.schedule")).toMatchObject({ ActorKind: "system" });
  });

  it("ends the review's escalations as approved after the commit, and touches Planner only while PLANNER_SYNC_ENABLED is true", async () => {
    await calculated();
    await submit();
    expect(escalations.settleReviewEscalations).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "approved", reviewId: "rev-1", state: "approved" }));
    expect(planner.resolveActivePlannerTasks).not.toHaveBeenCalled();

    world = new ReviewWorld();
    await calculated();
    process.env.PLANNER_SYNC_ENABLED = "true";
    await submit();
    expect(planner.resolveActivePlannerTasks).toHaveBeenCalledWith("tenant", 7, ["rent_review"]);
  });

  it("applies a fixed review whose % is the lease's in one step", async () => {
    const fixedSteps = steps({ review: { methodKind: "fixed", ratePercent: 4 } });
    await calculated({
      review: { Basis: JSON.stringify({ fixedPercent: 4, intervalMonths: 12, method: "fixed", ratchet: true }), Method: "fixed" },
      tenant: { FixedReviewPercent: 4, ScheduledRateSteps: JSON.stringify(fixedSteps) },
    });
    const res = await submit();
    expect(res.jsonBody).toMatchObject({ applied: true, review: { outcome: { appliedPercent: 4, newAnnual: 128659.79 } } });
  });
});

describe("submitRentReview: anything else waits for approval, and E3 goes to someone else", () => {
  it("sends an out-of-band result to approval, stamps the preparer, writes nothing to the schedule, and raises E3 after the commit", async () => {
    await calculated({ cpi: [100, 120], tenant: { CpiCapPercent: null } , review: { Basis: JSON.stringify(basis({ capPercent: null })) } });
    const before = world.tenant(7).ScheduledRateSteps;
    const res = await submit();
    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ applied: false, review: { prepared: { userId: 7 }, state: "awaiting_approval" } });
    expect(world.tenant(7).ScheduledRateSteps).toBe(before);
    expect(world.tenant(7).ScheduleVersion).toBe(4);
    expect(world.ledgerRows()).toEqual([expect.objectContaining({ Action: "rent_review.submit", RuleApplied: "out_of_band" })]);
    expect(escalations.raiseApprovalEscalation).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ excludeUserIds: [7], reasons: ["out_of_band"], reviewId: "rev-1" }),
    );
  });

  it("records an override: computed vs chosen and the $ difference, in the calc and as its own exception with the reason", async () => {
    await calculated();
    const res = await submit({ override: { newAnnual: 126000, reason: "Tenant hardship, agreed by the directors" } });
    expect(res.jsonBody).toMatchObject({ applied: false });
    expect(reviewBody(res).calc.override).toEqual({ differenceAnnual: -1670.1, newAnnual: 126000, reason: "Tenant hardship, agreed by the directors" });
    const override = world.ledgerRows().find((row) => row.Action === "rent_review.override");
    expect(override).toMatchObject({ FinancialImpact: 1670.1, IsException: true, Reason: "Tenant hardship, agreed by the directors", RuleApplied: "override" });
    expect(override?.computed).toEqual({ appliedPercent: 3.2, newAnnual: 127670.1 });
    expect(world.ledgerRows().find((row) => row.Action === "rent_review.submit")?.RuleApplied).toBe("override");
  });

  it("needs a reason for an override", async () => {
    await calculated();
    const res = await submit({ override: { newAnnual: 126000 } });
    expect(res.status).toBe(400);
    expect(res.jsonBody).toMatchObject({ code: "reason_required" });
  });

  it("refuses an override that is the calculated rent", async () => {
    await calculated();
    expect((await submit({ override: { newAnnual: 127670.1, reason: "same" } })).jsonBody).toMatchObject({ code: "no_change" });
  });

  it("sends a fixed review whose % departs from the lease to approval", async () => {
    await calculated({
      review: { Basis: JSON.stringify({ fixedPercent: 3, intervalMonths: 12, method: "fixed", ratchet: true }), Method: "fixed" },
      tenant: { FixedReviewPercent: 4, ScheduledRateSteps: JSON.stringify(steps({ review: { methodKind: "fixed", ratePercent: 4 } })) },
    });
    const res = await submit();
    expect(res.jsonBody).toMatchObject({ applied: false });
    expect(world.ledgerRows()[0].RuleApplied).toBe("basis_departs_from_lease");
  });

  it("always sends an `other` review to approval", async () => {
    seed(world, { review: { Basis: JSON.stringify({ method: "other", ratchet: true }), Method: "other" } });
    await calculate({ manual: { explanation: "Agreed", newAnnual: 125000 } });
    world.state.ledger = [];
    expect((await submit()).jsonBody).toMatchObject({ applied: false });
    expect(world.ledgerRows()[0].RuleApplied).toBe("manual_method");
  });
});

describe("submitRentReview: refusals", () => {
  it("is a 409 stale_schedule when the schedule changed since the calc (C4), and writes nothing", async () => {
    await calculated();
    world.tenant(7).ScheduleVersion = 5;
    const before = world.picture();
    const res = await submit();
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "stale_schedule", error: "The schedule changed since this was calculated — calculate again" });
    expect(world.picture()).toBe(before);
    expect(escalations.raiseApprovalEscalation).not.toHaveBeenCalled();
  });

  it("is a 422 not_signed_off for a schedule nobody has signed off (C3)", async () => {
    await calculated({ tenant: { ScheduleSignedOffAt: null, ScheduleSignedOffById: null, ScheduleSignedOffByName: null } });
    const res = await submit();
    expect(res.status).toBe(422);
    expect(res.jsonBody).toMatchObject({ code: "not_signed_off", error: "This tenancy's schedule isn't signed off yet — sign it off, then apply" });
  });

  it("refuses a decrease on a ratchet lease, even from a director (C9: the schedule couldn't hold it)", async () => {
    await calculated();
    as(PEOPLE.dee);
    const res = await submit({ override: { newAnnual: 120000, reason: "Agreed reduction" } });
    expect(res.status).toBe(422);
    expect(res.jsonBody).toMatchObject({ code: "ratchet" });
  });

  it("lets only a director, with a reason, go below a ratchet the basis adds where the lease has none (C9)", async () => {
    await calculated({ tenant: { ReviewRatchet: false } });
    expect((await submit({ override: { newAnnual: 120000, reason: "Agreed reduction" } })).jsonBody).toMatchObject({ code: "ratchet" });
    as(PEOPLE.dee);
    const res = await submit({ override: { newAnnual: 120000, reason: "Agreed reduction" } });
    expect(res.jsonBody).toMatchObject({ applied: false, review: { state: "awaiting_approval" } });
  });

  it("needs a calculation first", async () => {
    seed(world);
    expect((await submit()).jsonBody).toMatchObject({ code: "not_calculated" });
  });

  it.each(["accounts", "accounts_manager", "cfo", "director", "admin"])("lets %s submit (applyRentReview)", async (role) => {
    await calculated();
    expect((await submitRentReview(postRequest({ reviewId: "rev-1", rowVersion: versionOf(world) }, role), ctx)).status).toBe(200);
  });

  it.each(["facilities", "facilities_manager"])("refuses %s before the money gate and the database", async (role) => {
    await calculated();
    jest.clearAllMocks();
    expect((await submitRentReview(postRequest({ reviewId: "rev-1", rowVersion: versionOf(world) }, role), ctx)).status).toBe(403);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("APPLY is all or nothing", () => {
  it("rolls everything back when the apply row can't be written: the review, the step, the change log and the tenancy are as they were", async () => {
    await calculated();
    const before = world.picture();
    world.failLedger = (row) => row.Action === "rent_review.apply";
    const res = await submit();
    expect(res.status).toBe(500);
    expect(world.picture()).toBe(before);
    expect(world.tenant(7)).toMatchObject({ LastReviewDate: LAST_YEAR, RentPerAnnum: 123711.34, ScheduleVersion: 4 });
    expect(world.review("rev-1").State).toBe("in_progress");
    expect(world.rolledBack).toBe(1);
    expect(cache.invalidateTenantAndBuilding).not.toHaveBeenCalled();
    expect(escalations.settleReviewEscalations).not.toHaveBeenCalled();
    expect(world.state.reviews).toHaveLength(1); // no next review either
  });

  it("rolls back when the decision row itself fails, before anything is applied", async () => {
    await calculated();
    const before = world.picture();
    world.failLedger = (row) => row.Action === "rent_review.submit";
    expect((await submit()).status).toBe(500);
    expect(world.picture()).toBe(before);
  });
});

// ── approve ──────────────────────────────────────────────────────────────────

describe("approveRentReview", () => {
  /** Out of band (20% with no cap), submitted by Bo: waiting for approval. */
  async function waiting(over: Parameters<typeof seed>[1] = {}): Promise<void> {
    await calculated({ cpi: [100, 120], review: { Basis: JSON.stringify(basis({ capPercent: null })) }, tenant: { CpiCapPercent: null }, ...over });
    as(PEOPLE.bo);
    const res = await submit();
    expect(res.jsonBody).toMatchObject({ applied: false });
    world.state.ledger = [];
  }

  it("applies it when someone other than the preparer approves, ledgered as approve then apply", async () => {
    await waiting();
    as(PEOPLE.cy);
    const res = await approve();
    expect(res.status).toBe(200);
    expect(reviewBody(res)).toMatchObject({ approval: { basis: "approved", name: "Cy Finance" }, prepared: { name: "Bo Manager" }, state: "approved" });
    expect(reviewBody(res).outcome).toMatchObject({ appliedPercent: 20, oldAnnual: 123711.34 });
    expect(actions().slice(0, 2)).toEqual(["rent_review.approve", "rent_review.apply"]);
    expect(world.ledgerRows()[0]).toMatchObject({ RuleApplied: "level_accounts_manager" });
    expect(world.tenant(7)).toMatchObject({ LastReviewDate: REVIEW_DATE, ScheduleVersion: 5 });
    expect(escalations.settleReviewEscalations).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "approved" }));
    expect(res.jsonBody).toMatchObject({ nextReview: { scheduledFor: NEXT_ANNIVERSARY } });
  });

  it("refuses the preparer (C6): 403 sod_blocked, recorded as sod_blocked, and nothing else changes", async () => {
    await waiting();
    const before = { review: JSON.stringify(world.review("rev-1")), tenant: JSON.stringify(world.tenant(7)) };
    const res = await approve();
    expect(res.status).toBe(403);
    expect(res.jsonBody).toMatchObject({ code: "sod_blocked" });
    expect(world.ledgerRows()).toEqual([
      expect.objectContaining({ Action: "sod_blocked", ActorUserId: 8, IsException: true, RuleApplied: "approver_is_preparer", SubjectId: "rev-1", SubjectType: "rent_review" }),
    ]);
    expect(world.ledgerRows()[0].before).toMatchObject({ attempted: "rent_review.approve", state: "awaiting_approval" });
    expect(JSON.stringify(world.review("rev-1"))).toBe(before.review);
    expect(JSON.stringify(world.tenant(7))).toBe(before.tenant);
  });

  it("refuses whoever keyed a manual rent, even if someone else submitted it (C6)", async () => {
    seed(world, { review: { Basis: JSON.stringify({ method: "other", ratchet: true }), Method: "other" } });
    as(PEOPLE.cy);
    await calculate({ manual: { explanation: "Agreed", newAnnual: 125000 } });
    as(PEOPLE.ann);
    await submit();
    as(PEOPLE.cy);
    expect((await approve()).jsonBody).toMatchObject({ code: "sod_blocked" });
    as(PEOPLE.bo);
    expect((await approve()).status).toBe(200);
  });

  it("needs the level E3 has reached (C7): an accounts manager can't once it is with the CFO; the CFO and a director can", async () => {
    await waiting();
    world.state.escalations.push({ EscalationId: 1, Level: 2, NoIndependentTarget: false, PolicyKey: "rent_review.approval", Status: "open", SubjectId: "rev-1", TargetRole: "cfo" });
    world.state.reviews.find((r) => r.ReviewId === "rev-1")!.PreparedById = 7; // prepared by Ann, so Bo isn't blocked by C6
    as(PEOPLE.bo);
    const res = await approve();
    expect(res.status).toBe(403);
    expect(res.jsonBody).toMatchObject({ code: "approval_level", requiredRole: "cfo" });
    expect(world.ledgerRows()).toEqual([expect.objectContaining({ Action: "denied", RuleApplied: "approval_level" })]);
    as(PEOPLE.dee);
    expect((await approve()).status).toBe(200);
  });

  it("asks for a director when nobody independent was left on the ladder", async () => {
    await waiting();
    world.state.escalations.push({ EscalationId: 1, Level: 3, NoIndependentTarget: true, PolicyKey: "rent_review.approval", Status: "open", SubjectId: "rev-1", TargetRole: "director" });
    as(PEOPLE.cy);
    expect((await approve()).jsonBody).toMatchObject({ code: "approval_level", requiredRole: "director" });
  });

  it("never lets admin approve (D20), though requireRole lets admin through, and records the attempt", async () => {
    await waiting();
    as(PEOPLE.ada);
    const res = await approve();
    expect(res.status).toBe(403);
    expect(res.jsonBody).toMatchObject({ code: "forbidden" });
    expect(world.ledgerRows()).toEqual([expect.objectContaining({ Action: "denied", RuleApplied: "role_not_permitted" })]);
  });

  it.each(["accounts", "facilities"])("refuses %s at the role gate", async (role) => {
    await waiting();
    expect((await approveRentReview(postRequest({ reviewId: "rev-1", rowVersion: versionOf(world) }, role), ctx)).status).toBe(403);
  });

  it("is a 409 stale_schedule, telling the approver to return it, when the schedule changed while it waited", async () => {
    await waiting();
    world.tenant(7).ScheduleVersion = 9;
    as(PEOPLE.cy);
    const res = await approve();
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "stale_schedule", error: "The schedule changed since this was calculated — return it so it can be calculated again" });
    expect(world.review("rev-1").State).toBe("awaiting_approval");
  });

  it("applies an approved override as a rate the engine reproduces to the cent", async () => {
    await calculated();
    as(PEOPLE.bo);
    await submit({ override: { newAnnual: 125555.55, reason: "Negotiated" } });
    as(PEOPLE.cy);
    const res = await approve();
    expect(reviewBody(res).outcome).toMatchObject({ newAnnual: 125555.55 });
    const tenant = world.tenant(7);
    const rows = computeScheduleRows(parseSteps(String(tenant.ScheduledRateSteps)), 0, 400, { cpiCapPercent: 5, cpiFloorPercent: 1, reviewRatchet: true });
    expect(rows.at(-1)?.annual).toBe(125555.55);
    expect(tenant.RentPerAnnum).toBe(125555.55);
    expect(world.ledgerRows().find((r) => r.Action === "rent_review.apply")?.after).toMatchObject({ representation: "method_rate" });
  });

  it("only approves a review that is waiting for approval", async () => {
    await calculated();
    as(PEOPLE.cy);
    expect((await approve()).jsonBody).toMatchObject({ code: "invalid_state" });
  });
});
