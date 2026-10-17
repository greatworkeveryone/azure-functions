/// <reference types="jest" />
// WP26 return, waive, cancel and revert through the real handlers against the
// in-memory database (see rentReviewWorkflow.test.ts for the set-up). Cancel's
// effect on the review date is decided and pinned here: a superseded review's
// date still needs a review (one is scheduled again), a vacated tenancy's
// doesn't. Revert restores the schedule from the change log, after cancelling
// the next review APPLY scheduled.
import type { InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { approveRentReview } from "../functions/approveRentReview";
import { calculateRentReview } from "../functions/calculateRentReview";
import { cancelRentReview } from "../functions/cancelRentReview";
import { getRentReview } from "../functions/getRentReview";
import { getRentReviews } from "../functions/getRentReviews";
import { returnRentReview } from "../functions/returnRentReview";
import { revertRentReview } from "../functions/revertRentReview";
import { submitRentReview } from "../functions/submitRentReview";
import { waiveRentReview } from "../functions/waiveRentReview";
import { parseSteps } from "../scheduledRateStepLogic";
import { getRequest, postRequest } from "./fixtures/rentReviewFakes";
import {
  basis,
  LAST_YEAR,
  NEXT_ANNIVERSARY,
  PEOPLE,
  REVIEW_DATE,
  seed,
  STEP_IDS,
  steps,
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
const escalations = require("../rentReview/escalations") as { raiseApprovalEscalation: jest.Mock; settleReviewEscalations: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

let world: ReviewWorld;
let caller: Person = PEOPLE.ann;
const as = (person: Person) => {
  caller = person;
};
type Handler = typeof cancelRentReview;
const call = (handler: Handler, body: Record<string, unknown> = {}, reviewId = "rev-1") =>
  handler(postRequest({ reviewId, rowVersion: versionOf(world, reviewId), ...body }, caller.role), ctx);
const reviewOf = (res: { jsonBody?: unknown }) => (res.jsonBody as { review: Record<string, any> }).review;

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  delete process.env.REVIEW_WORKFLOW_LIVE_FROM;
  world = new ReviewWorld();
  useWorld(() => world, db);
  resolveLedgerActor.mockImplementation(async () => caller);
  as(PEOPLE.ann);
});

/** Calculated by Ann, then whatever the test does next is all that is asserted. */
async function calculated(over: Parameters<typeof seed>[1] = {}): Promise<void> {
  seed(world, over);
  as(PEOPLE.ann);
  expect((await call(calculateRentReview)).status).toBe(200);
  world.state.ledger = [];
  jest.clearAllMocks();
}

/** Out of band (20%, no cap), submitted by Ann: waiting for approval. */
async function waiting(): Promise<void> {
  await calculated({ cpi: [100, 120], review: { Basis: JSON.stringify(basis({ capPercent: null })) }, tenant: { CpiCapPercent: null } });
  expect((await call(submitRentReview)).jsonBody).toMatchObject({ applied: false });
  world.state.ledger = [];
  jest.clearAllMocks();
}

/** Applied in one step by Ann (and the next review scheduled after it). The
 *  ledger keeps its rows (REVERT reads APPLY's); `mark` is where the test's own begin. */
let mark = 0;
async function applied(): Promise<void> {
  await calculated();
  expect((await call(submitRentReview)).jsonBody).toMatchObject({ applied: true });
  mark = world.state.ledger.length;
  jest.clearAllMocks();
}
const since = () => world.ledgerRows().slice(mark);

// ── return ───────────────────────────────────────────────────────────────────

describe("returnRentReview", () => {
  it("sends a waiting review back to in progress with the approver's note; E3 ends as returned after the commit", async () => {
    await waiting();
    as(PEOPLE.bo);
    const res = await call(returnRentReview, { note: "Use the Darwin index, not Australia" });
    expect(res.status).toBe(200);
    expect(reviewOf(res)).toMatchObject({ state: "in_progress", submittedAt: null });
    expect(reviewOf(res).calc).not.toBeNull(); // kept for the preparer to revise
    expect(world.ledgerRows()).toEqual([
      expect.objectContaining({ Action: "rent_review.return", IsException: false, Reason: "Use the Darwin index, not Australia" }),
    ]);
    expect(escalations.settleReviewEscalations).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "returned", note: "Use the Darwin index, not Australia", state: "in_progress" }),
    );
  });

  it("says the review came back, on the response, getRentReview and the list, until it is submitted again", async () => {
    await waiting();
    as(PEOPLE.bo);
    const res = await call(returnRentReview, { note: "Use the Darwin index" });
    const returned = { at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), byName: "Bo Manager", note: "Use the Darwin index" };
    expect(reviewOf(res).returned).toEqual(returned);
    const detail = await getRentReview(getRequest({ reviewId: "rev-1" }, "accounts"), ctx);
    expect((detail.jsonBody as { review: Record<string, unknown> }).review.returned).toEqual(returned);
    const list = await getRentReviews(getRequest({ tenantId: "7" }, "accounts"), ctx);
    expect((list.jsonBody as { reviews: Array<Record<string, unknown>> }).reviews[0].returned).toEqual(returned);

    // Recalculating keeps it; submitting again clears it.
    as(PEOPLE.ann);
    expect(reviewOf(await call(calculateRentReview)).returned).toEqual(returned);
    expect(reviewOf(await call(submitRentReview)).returned).toBeNull();

    // A second return shows the newer note; the first one no longer counts.
    as(PEOPLE.bo);
    expect(reviewOf(await call(returnRentReview, { note: "Now check the floor" })).returned).toMatchObject({ note: "Now check the floor" });
  });

  it("needs a note", async () => {
    await waiting();
    as(PEOPLE.bo);
    expect((await call(returnRentReview)).jsonBody).toMatchObject({ code: "reason_required" });
  });

  it("is the approvers' action: accounts staff and admin are refused, admin's attempt ledgered as denied (L4)", async () => {
    await waiting();
    as(PEOPLE.ann);
    expect((await call(returnRentReview, { note: "x" })).status).toBe(403);
    as(PEOPLE.ada);
    const res = await call(returnRentReview, { note: "x" });
    expect(res.status).toBe(403);
    expect(res.jsonBody).toMatchObject({ code: "forbidden" });
    expect(world.ledgerRows()).toEqual([expect.objectContaining({ Action: "denied", ActorUserId: 11, RuleApplied: "role_not_permitted", SubjectId: "rev-1" })]);
    expect(world.ledgerRows()[0].before).toEqual({ attempted: "rent_review.return", state: "awaiting_approval" });
    expect(world.review("rev-1").State).toBe("awaiting_approval");
  });

  it("only returns a review that is waiting for approval", async () => {
    await calculated();
    as(PEOPLE.bo);
    expect((await call(returnRentReview, { note: "x" })).jsonBody).toMatchObject({ code: "invalid_state" });
  });
});

// ── waive ────────────────────────────────────────────────────────────────────

describe("waiveRentReview", () => {
  it("settles the review's row as waived through the schedule engine and moves the next review on, keeping the rent", async () => {
    await calculated();
    as(PEOPLE.bo);
    const res = await call(waiveRentReview, { reason: "Tenant in hardship; directors agreed no increase this year" });
    expect(res.status).toBe(200);
    expect(reviewOf(res)).toMatchObject({ state: "waived", waiveReason: "Tenant in hardship; directors agreed no increase this year" });
    const tenant = world.tenant(7);
    const row = parseSteps(String(tenant.ScheduledRateSteps)).find((step) => step.id === STEP_IDS.review);
    expect(row).toMatchObject({ resolution: "waived", reviewId: "rev-1" });
    expect(tenant).toMatchObject({ LastReviewDate: LAST_YEAR, NextReviewDate: NEXT_ANNIVERSARY, RentPerAnnum: 123711.34, ScheduleVersion: 5 });
    expect(tenant.ScheduleSignedOffAt).not.toBeNull(); // D7
    expect(world.state.changeLog).toEqual([expect.objectContaining({ ChangeKind: "updated", StepId: STEP_IDS.review })]);
  });

  it("ledgers the waive as an exception with its reason and the increase forgone", async () => {
    await calculated();
    as(PEOPLE.bo);
    await call(waiveRentReview, { reason: "Hardship" });
    const waive = world.ledgerRows().find((row) => row.Action === "rent_review.waive");
    expect(waive).toMatchObject({ FinancialImpact: 3958.76, IsException: true, Reason: "Hardship", RuleApplied: "waive" });
    expect(waive?.computed).toMatchObject({ currentAnnual: 123711.34, newAnnual: 127670.1, source: "calc" });
  });

  it("works the forgone increase out for a review nobody calculated", async () => {
    seed(world);
    as(PEOPLE.bo);
    await call(waiveRentReview, { reason: "Hardship" });
    expect(world.ledgerRows().find((row) => row.Action === "rent_review.waive")).toMatchObject({ FinancialImpact: 3958.76 });
  });

  it("adds a waived row on the review date when the schedule has none, closing the row before it", async () => {
    const withoutRow = steps({ review: null }).map((step) => (step.id === STEP_IDS.lastYear ? { ...step, effectiveTo: undefined } : step));
    seed(world, { review: { StepId: null }, tenant: { ScheduledRateSteps: JSON.stringify(withoutRow) } });
    as(PEOPLE.bo);
    expect((await call(waiveRentReview, { reason: "Hardship" })).status).toBe(200);
    const after = parseSteps(String(world.tenant(7).ScheduledRateSteps));
    expect(after.find((step) => step.effectiveFrom === REVIEW_DATE)).toMatchObject({ methodKind: "cpi", ratePercent: 0, resolution: "waived", reviewId: "rev-1" });
    expect(after.find((step) => step.id === STEP_IDS.lastYear)?.effectiveTo).toBe(REVIEW_DATE);
    expect(world.state.changeLog.map((row) => row.ChangeKind)).toEqual(["added", "updated"]);
  });

  it("schedules the next review after the commit", async () => {
    await calculated();
    as(PEOPLE.bo);
    const res = await call(waiveRentReview, { reason: "Hardship" });
    expect(res.jsonBody).toMatchObject({ nextReview: { scheduledFor: NEXT_ANNIVERSARY } });
    expect(escalations.settleReviewEscalations).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "waived" }));
  });

  it("needs a reason", async () => {
    await calculated();
    as(PEOPLE.bo);
    expect((await call(waiveRentReview)).jsonBody).toMatchObject({ code: "reason_required" });
  });

  it("is refused to accounts staff at the gate, and to admin (never an approver) with the attempt recorded", async () => {
    await calculated();
    as(PEOPLE.ann);
    expect((await call(waiveRentReview, { reason: "x" })).status).toBe(403);
    as(PEOPLE.ada);
    const res = await call(waiveRentReview, { reason: "x" });
    expect(res.status).toBe(403);
    expect(world.ledgerRows()).toEqual([expect.objectContaining({ Action: "denied", RuleApplied: "role_not_permitted" })]);
  });

  it("lets only a director waive a market review", async () => {
    seed(world, { review: { Basis: JSON.stringify({ ...basis(), method: "market" }), Method: "market", State: "due" } });
    as(PEOPLE.cy);
    const refused = await call(waiveRentReview, { reason: "Lease expires before the review" });
    expect(refused.status).toBe(403);
    expect(refused.jsonBody).toMatchObject({ error: "Only a director can waive a market review" });
    as(PEOPLE.dee);
    const res = await call(waiveRentReview, { reason: "Lease expires before the review" });
    expect(res.status).toBe(200);
    expect(world.ledgerRows().find((row) => row.Action === "rent_review.waive")).toMatchObject({ FinancialImpact: null, RuleApplied: "waive_market_director" });
  });

  it.each(["scheduled", "due", "in_progress", "awaiting_index", "awaiting_approval"])("waives a %s review", async (state) => {
    seed(world, { review: { State: state } });
    as(PEOPLE.bo);
    expect((await call(waiveRentReview, { reason: "Hardship" })).status).toBe(200);
  });

  it.each(["approved", "completed", "waived", "cancelled"])("refuses a %s review", async (state) => {
    seed(world, { review: { State: state } });
    as(PEOPLE.bo);
    expect((await call(waiveRentReview, { reason: "Hardship" })).jsonBody).toMatchObject({ code: "invalid_state" });
  });

  it("rolls back entirely when the ledger row fails: the schedule keeps its row unsettled", async () => {
    await calculated();
    const before = world.picture();
    world.failLedger = (row) => row.Action === "rent_review.waive";
    as(PEOPLE.bo);
    expect((await call(waiveRentReview, { reason: "Hardship" })).status).toBe(500);
    expect(world.picture()).toBe(before);
  });
});

// ── cancel ───────────────────────────────────────────────────────────────────

describe("cancelRentReview, and what it does to the review date", () => {
  it("superseded: cancels it, leaves the date unsettled, and schedules a review for that date again at once", async () => {
    await calculated();
    as(PEOPLE.bo);
    const res = await call(cancelRentReview, { reason: "Raised against the wrong lease; starting again" });
    expect(res.status).toBe(200);
    expect(reviewOf(res)).toMatchObject({ state: "cancelled" });
    // The date still needs a review: a fresh one is open for it.
    expect(res.jsonBody).toMatchObject({ nextReview: { scheduledFor: REVIEW_DATE, state: "due" } });
    const open = world.state.reviews.filter((r) => r.ReviewId !== "rev-1");
    expect(open).toEqual([expect.objectContaining({ ScheduledFor: REVIEW_DATE, State: "due" })]);
    expect(world.tenant(7).ScheduledRateSteps).toBe(JSON.stringify(steps())); // the schedule is untouched
    const cancel = world.ledgerRows().find((row) => row.Action === "rent_review.cancel");
    expect(cancel).toMatchObject({ IsException: true, Reason: "Raised against the wrong lease; starting again", RuleApplied: "cancel_superseded" });
    expect(escalations.settleReviewEscalations).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ code: "cancelled", note: "Raised against the wrong lease; starting again", state: "cancelled" }),
    );
  });

  it("vacated: cancels it and leaves the tenancy with no review, as it must", async () => {
    seed(world, { review: { State: "due" }, tenant: { Status: "vacated" } });
    as(PEOPLE.bo);
    const res = await call(cancelRentReview, { reason: "Tenant vacated on 30 June" });
    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ nextReview: null, review: { state: "cancelled" } });
    expect(world.state.reviews).toHaveLength(1);
    expect(world.ledgerRows().find((row) => row.Action === "rent_review.cancel")).toMatchObject({ RuleApplied: "cancel_vacated" });
  });

  it("refuses an archived tenancy's review: it is history until the tenancy is restored", async () => {
    seed(world, { tenant: { ArchivedAt: new Date() } });
    as(PEOPLE.bo);
    expect((await call(cancelRentReview, { reason: "x" })).jsonBody).toMatchObject({ code: "tenancy_archived" });
  });

  it("needs a reason, and an accounts manager or above (admin included)", async () => {
    await calculated();
    as(PEOPLE.bo);
    expect((await call(cancelRentReview)).jsonBody).toMatchObject({ code: "reason_required" });
    as(PEOPLE.ann);
    expect((await call(cancelRentReview, { reason: "x" })).status).toBe(403);
    as(PEOPLE.ada);
    expect((await call(cancelRentReview, { reason: "Duplicate" })).status).toBe(200);
  });

  it("only cancels an open review", async () => {
    seed(world, { review: { State: "approved" } });
    as(PEOPLE.bo);
    expect((await call(cancelRentReview, { reason: "x" })).jsonBody).toMatchObject({ code: "invalid_state" });
  });
});

// ── revert ───────────────────────────────────────────────────────────────────

describe("revertRentReview", () => {
  it("cancels the next review APPLY scheduled first, then restores the schedule and the tenancy from the change log", async () => {
    const original = { steps: JSON.stringify(steps()), tenant: null as Record<string, unknown> | null };
    await applied();
    const next = world.state.reviews.find((r) => r.ReviewId !== "rev-1") as Record<string, unknown>;
    expect(next).toMatchObject({ ScheduledFor: NEXT_ANNIVERSARY, State: "scheduled" });
    as(PEOPLE.bo);
    const res = await call(revertRentReview, { reason: "Applied with the wrong CPI region" });
    expect(res.status).toBe(200);
    expect(reviewOf(res)).toMatchObject({ approval: null, calc: null, outcome: null, prepared: null, state: "in_progress" });
    // The next review went first, ledgered, so the one-open-review index allowed this one back.
    expect(world.review(String(next.ReviewId)).State).toBe("cancelled");
    expect(since().map((row) => row.Action)).toEqual(["rent_review.cancel", "rent_review.revert"]);
    expect(since()[0]).toMatchObject({ RuleApplied: "revert_supersedes_next", SubjectId: next.ReviewId });
    // The schedule is as it was before APPLY, and so are the tenancy's review fields.
    const tenant = world.tenant(7);
    expect(JSON.parse(String(tenant.ScheduledRateSteps))).toEqual(JSON.parse(original.steps));
    expect(tenant).toMatchObject({ LastReviewDate: LAST_YEAR, LastReviewIncreasePercent: 3.0928, NextReviewDate: REVIEW_DATE, RentPerAnnum: 123711.34, ScheduleVersion: 6 });
    expect(tenant.ScheduleSignedOffAt).not.toBeNull();
    expect(world.state.changeLog.map((row) => [row.ChangeKind, row.StepId])).toEqual([
      ["updated", STEP_IDS.review], // APPLY
      ["updated", STEP_IDS.review], // REVERT, back to the unsettled row
    ]);
    const revert = since()[1];
    expect(revert).toMatchObject({ FinancialImpact: 3958.76, IsException: true, Reason: "Applied with the wrong CPI region", RuleApplied: "revert_from_change_log" });
    expect(revert.after).toMatchObject({ arrears: { billed: false }, state: "in_progress" });
  });

  it("removes a row APPLY added and reopens the row it closed", async () => {
    const withoutRow = steps({ review: null }).map((step) => (step.id === STEP_IDS.lastYear ? { ...step, effectiveTo: undefined } : step));
    await calculated({ review: { StepId: null }, tenant: { ScheduledRateSteps: JSON.stringify(withoutRow) } });
    expect((await call(submitRentReview)).jsonBody).toMatchObject({ applied: true });
    expect(parseSteps(String(world.tenant(7).ScheduledRateSteps))).toHaveLength(3);
    as(PEOPLE.bo);
    expect((await call(revertRentReview, { reason: "Wrong date" })).status).toBe(200);
    expect(JSON.parse(String(world.tenant(7).ScheduledRateSteps))).toEqual(withoutRow.map((step) => JSON.parse(JSON.stringify(step))));
  });

  it("refuses when the step APPLY wrote has been edited since, and changes nothing", async () => {
    await applied();
    const tenant = world.tenant(7);
    tenant.ScheduledRateSteps = JSON.stringify(
      parseSteps(String(tenant.ScheduledRateSteps)).map((step) => (step.id === STEP_IDS.review ? { ...step, note: "edited by hand" } : step)),
    );
    const before = world.picture();
    as(PEOPLE.bo);
    const res = await call(revertRentReview, { reason: "x" });
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "changed_since_apply", stepId: STEP_IDS.review });
    expect(world.picture()).toBe(before);
  });

  it("refuses when the tenancy's review fields were changed since", async () => {
    await applied();
    world.tenant(7).LastReviewDate = "2020-01-01";
    as(PEOPLE.bo);
    expect((await call(revertRentReview, { reason: "x" })).jsonBody).toMatchObject({ code: "changed_since_apply", field: "lastReviewDate" });
  });

  it("refuses while the next review is already being worked on", async () => {
    await applied();
    const next = world.state.reviews.find((r) => r.ReviewId !== "rev-1") as Record<string, unknown>;
    next.State = "in_progress";
    as(PEOPLE.bo);
    expect((await call(revertRentReview, { reason: "x" })).jsonBody).toMatchObject({ code: "next_review_in_progress" });
  });

  it("rolls the next review's cancel back too when the revert fails", async () => {
    await applied();
    const before = world.picture();
    world.failLedger = (row) => row.Action === "rent_review.revert";
    as(PEOPLE.bo);
    expect((await call(revertRentReview, { reason: "x" })).status).toBe(500);
    expect(world.picture()).toBe(before);
  });

  it("needs a reason, an approver (not accounts staff, not admin), and an applied review", async () => {
    await applied();
    as(PEOPLE.bo);
    expect((await call(revertRentReview)).jsonBody).toMatchObject({ code: "reason_required" });
    as(PEOPLE.ann);
    expect((await call(revertRentReview, { reason: "x" })).status).toBe(403);
    as(PEOPLE.ada);
    expect((await call(revertRentReview, { reason: "x" })).status).toBe(403);
    // L4: admin's attempt is in the ledger, as denied.
    expect(since().filter((row) => row.Action === "denied")).toEqual([
      expect.objectContaining({ ActorUserId: 11, RuleApplied: "role_not_permitted", SubjectId: "rev-1" }),
    ]);
    expect(since().find((row) => row.Action === "denied")?.before).toEqual({ attempted: "rent_review.revert", state: "approved" });
    world.review("rev-1").State = "completed";
    as(PEOPLE.bo);
    expect((await call(revertRentReview, { reason: "x" })).jsonBody).toMatchObject({ code: "invalid_state", error: "This review has been completed, so it can't be reverted" });
  });

  it("can be applied again after a revert: calculate, submit, applied", async () => {
    await applied();
    as(PEOPLE.bo);
    await call(revertRentReview, { reason: "Recheck" });
    as(PEOPLE.ann);
    expect((await call(calculateRentReview)).status).toBe(200);
    expect((await call(submitRentReview)).jsonBody).toMatchObject({ applied: true, review: { outcome: { newAnnual: 127670.1 } } });
    expect(world.tenant(7)).toMatchObject({ LastReviewDate: REVIEW_DATE, NextReviewDate: NEXT_ANNIVERSARY });
  });
});

describe("approve after a return", () => {
  it("works once the preparer recalculates and resubmits", async () => {
    await waiting();
    as(PEOPLE.bo);
    await call(returnRentReview, { note: "Check the region" });
    as(PEOPLE.ann);
    expect((await call(calculateRentReview)).status).toBe(200);
    expect((await call(submitRentReview)).jsonBody).toMatchObject({ applied: false });
    as(PEOPLE.bo);
    expect((await call(approveRentReview)).status).toBe(200);
  });
});

// ── L1, L2: collisions ask to try again ───────────────────────────────────────

describe("L1-L2: a collision is a 409 try again, never a 500, and changes nothing", () => {
  const deadlock = () => Object.assign(new Error("Transaction (Process ID 61) was deadlocked on lock resources with another process"), { number: 1205 });

  it("an approval chosen as a deadlock's victim", async () => {
    await waiting();
    const before = world.picture();
    world.failSql = (sql) => (/UPDATE dbo\.Tenants SET/.test(sql) ? deadlock() : null);
    as(PEOPLE.bo);
    const res = await call(approveRentReview);
    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual({ code: "try_again", error: "Someone else was changing this tenancy at the same moment, so nothing was changed. Try again." });
    expect(world.picture()).toBe(before);
  });

  it("a revert chosen as a deadlock's victim", async () => {
    await applied();
    world.failSql = (sql) => (/UPDATE dbo\.Tenants SET/.test(sql) ? deadlock() : null);
    as(PEOPLE.bo);
    expect((await call(revertRentReview, { reason: "x" })).jsonBody).toMatchObject({ code: "try_again" });
    expect(world.review("rev-1").State).toBe("approved");
  });

  it("a revert racing a review opened on the tenancy (the one-open-review index)", async () => {
    await applied();
    world.failSql = (sql) =>
      /UPDATE dbo\.RentReviews/.test(sql) && sql.includes("ApprovedById = NULL")
        ? Object.assign(new Error("Cannot insert duplicate key row in object 'dbo.RentReviews' with unique index 'UX_RentReviews_OpenPerTenant'"), { number: 2601 })
        : null;
    as(PEOPLE.bo);
    const res = await call(revertRentReview, { reason: "x" });
    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual({
      code: "try_again",
      error: "Another review was opened on this tenancy at the same moment, so this one wasn't reverted. Try again.",
    });
    expect(world.review("rev-1").State).toBe("approved");
  });
});
