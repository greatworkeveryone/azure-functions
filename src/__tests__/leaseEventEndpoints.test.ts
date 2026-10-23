/// <reference types="jest" />
// WP32 option exercise through the real handlers against an in-memory database
// (fixtures/leaseEventWorld.ts) whose transactions really roll back: record a
// notice (in the window, late, refused), approve it (the atomic APPLY: expiry,
// options, option-term rows, market review, ledger; and its rollback), separation
// of duties, admin on test records only, director overrides, 409 on a stale
// write, reject, and the read. Today is pinned to 23 Oct 2026 in Darwin.
import type { InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { approveOptionExercise } from "../functions/approveOptionExercise";
import { getTenancyLeaseEvents } from "../functions/getTenancyLeaseEvents";
import { recordOptionNotice } from "../functions/recordOptionNotice";
import { rejectOptionNotice } from "../functions/rejectOptionNotice";
import { parseSteps } from "../scheduledRateStepLogic";
import { eventRow, LeaseEventWorld, tenancyRow, useLeaseWorld } from "./fixtures/leaseEventWorld";
import { asDate, getRequest, postRequest } from "./fixtures/rentReviewFakes";
import { PEOPLE, type Person } from "./fixtures/rentReviewScenario";

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
jest.mock("../moneyGate", () => ({ requireMoneyContext: jest.fn().mockResolvedValue(null) }));
jest.mock("../escalation", () => ({ concludeForSubject: jest.fn().mockResolvedValue([]), raise: jest.fn() }));

const db = jest.requireMock("../db") as Record<string, jest.Mock>;
const { resolveLedgerActor } = jest.requireMock("../ledger/actor") as { resolveLedgerActor: jest.Mock };
const { requireMoneyContext } = jest.requireMock("../moneyGate") as { requireMoneyContext: jest.Mock };
const escalation = jest.requireMock("../escalation") as { concludeForSubject: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

let world: LeaseEventWorld;
let caller: Person = PEOPLE.ann;
const as = (person: Person) => {
  caller = person;
};
const body = (res: { jsonBody?: unknown }) => res.jsonBody as Record<string, any>;

const NOTICE = { noticeDate: "2026-10-20", noticeDocument: "Tenant letter 20 Oct", startMethod: "market", tenantId: 7 };
const record = (over: Record<string, unknown> = {}) => recordOptionNotice(postRequest({ ...NOTICE, ...over }, caller.role), ctx);
const approve = (over: Record<string, unknown> = {}) =>
  approveOptionExercise(postRequest({ leaseEventId: world.state.events[0]?.LeaseEventId, rowVersion: world.versionOf(String(world.state.events[0]?.LeaseEventId)), ...over }, caller.role), ctx);
const reject = (over: Record<string, unknown> = {}) =>
  rejectOptionNotice(postRequest({ leaseEventId: "ev-1", reason: "Notice not signed by the tenant", rowVersion: world.versionOf("ev-1"), ...over }, caller.role), ctx);

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  jest.setSystemTime(new Date("2026-10-23T03:00:00Z")); // 12:30 on 23 Oct in Darwin
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  delete process.env.REVIEW_WORKFLOW_LIVE_FROM;
  world = new LeaseEventWorld();
  useLeaseWorld(() => world, db);
  resolveLedgerActor.mockImplementation(async () => caller);
  requireMoneyContext.mockResolvedValue(null);
  as(PEOPLE.ann);
});

afterEach(() => {
  jest.useRealTimers();
});

describe("recordOptionNotice", () => {
  it("opens the option event and sends a notice dated inside the window for approval", async () => {
    const res = await record();
    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({ late: false, event: { lateNotice: false, noticeDate: "2026-10-20", state: "awaiting_approval", type: "option_exercise" } });
    expect(body(res).event.terms).toEqual({
      fixedPercent: 3,
      intervalMonths: 12,
      newExpiry: "2032-06-30",
      ongoingMethod: "fixed",
      optionStart: "2027-07-01",
      startMethod: "market",
      termMonths: 60,
    });
    expect(world.ledgerActions()).toEqual(["lease_event.open", "lease_event.notice_recorded"]);
    expect(escalation.concludeForSubject).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "notice_recorded", policyKeys: ["lease.option_deadline", "lease.option_lapsed"] }));
  });

  it("records on the event the generator opened, checking the version the caller read", async () => {
    world.state.events.push(eventRow());
    expect((await record({ rowVersion: "00000000000000ff" })).status).toBe(409);
    const res = await record({ rowVersion: world.versionOf() });
    expect(body(res).event).toMatchObject({ leaseEventId: "ev-1", state: "awaiting_approval" });
    expect(world.ledgerActions()).toEqual(["lease_event.notice_recorded"]);
  });

  it("records a notice dated outside the window as late, with the recorder's reason, for a director to decide", async () => {
    expect((await record({ noticeDate: "2026-06-29" })).status).toBe(400); // reason_required
    const res = await record({ noticeDate: "2026-06-29", reason: "Posted early by the tenant" });
    expect(body(res)).toMatchObject({ late: true, event: { lateNotice: true, state: "notice_received" } });
    const late = world.state.ledger.find((row) => row.Action === "lease_event.late_notice");
    expect(late).toMatchObject({ IsException: true, Reason: "Posted early by the tenant" });
  });

  it("records a late notice against the option that lapsed for this expiry", async () => {
    world.state.events.push(eventRow({ DeadlineOn: asDate("2026-12-30"), Outcome: "lapsed", State: "lapsed" }));
    const res = await record({ reason: "Letter found in the mail room" , noticeDate: "2026-10-22" });
    // 22 Oct is inside the window, but the event lapsed: it reopens for approval.
    expect(body(res).event).toMatchObject({ leaseEventId: "ev-1", outcome: null, state: "awaiting_approval" });
  });

  it("refuses: no options left, unreadable options, no notice period, a notice already recorded, a future date, an archived tenancy", async () => {
    world.state.tenancy = tenancyRow({ OptionsRemaining: 0, OptionsTotal: 2 });
    expect(body(await record())).toMatchObject({ code: "no_options" });
    world.state.tenancy = tenancyRow({ OptionPeriods: "At the landlord's discretion" });
    expect(body(await record())).toMatchObject({ code: "no_options" });
    world.state.tenancy = tenancyRow({ OptionNoticeMonths: null });
    expect(body(await record())).toMatchObject({ code: "no_window" });
    world.state.tenancy = tenancyRow();
    world.state.events.push(eventRow({ State: "awaiting_approval" }));
    expect((await record()).status).toBe(409);
    expect((await record({ noticeDate: "2026-10-24" })).status).toBe(400);
    world.state.tenancy = tenancyRow({ ArchivedAt: new Date() });
    expect(body(await record())).toMatchObject({ code: "tenancy_archived" });
  });

  it("checks input before the database and the role at the gate", async () => {
    expect((await record({ startMethod: "guess" })).status).toBe(400);
    expect((await record({ noticeDate: "20/10/2026" })).status).toBe(400);
    expect((await record({ fixedPercent: 140 })).status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect((await recordOptionNotice(postRequest(NOTICE, "facilities"), ctx)).status).toBe(403);
    expect((await recordOptionNotice(postRequest(NOTICE, null), ctx)).status).toBe(401);
  });
});

describe("approveOptionExercise: the atomic APPLY", () => {
  async function recorded(over: Record<string, unknown> = {}): Promise<void> {
    as(PEOPLE.ann);
    expect((await record(over)).status).toBe(200);
    world.state.ledger = [];
    jest.clearAllMocks();
    useLeaseWorld(() => world, db);
    resolveLedgerActor.mockImplementation(async () => caller);
  }

  it("extends the expiry, takes an option, writes the term's rows, spawns the market review, all ledgered", async () => {
    await recorded();
    as(PEOPLE.bo);
    const res = await approve();
    expect(res.status).toBe(200);
    expect(body(res).outcome).toMatchObject({ marketReview: { kind: "scheduled", scheduledFor: "2027-07-01" }, newExpiry: "2032-06-30", optionsRemaining: 1 });
    const t = world.state.tenancy;
    expect((t.Expiry as Date).toISOString().slice(0, 10)).toBe("2032-06-30");
    expect([t.OptionsTotal, t.OptionsRemaining, t.OptionTermMonths, t.ScheduleVersion]).toEqual([2, 1, 60, 5]);
    const steps = parseSteps(t.ScheduledRateSteps as string);
    expect(steps.map((s) => [s.effectiveFrom, s.effectiveTo ?? null, s.methodKind, s.ratePercent])).toEqual([
      ["2022-07-01", "2023-07-01", "commencement", 0],
      ["2023-07-01", "2027-07-01", "fixed", 3], // the open-ended row is closed on the option's first day
      ["2027-07-01", "2028-07-01", "market", 0],
      ["2028-07-01", "2029-07-01", "fixed", 3],
      ["2029-07-01", "2030-07-01", "fixed", 3],
      ["2030-07-01", "2031-07-01", "fixed", 3],
      ["2031-07-01", "2032-07-01", "fixed", 3],
    ]);
    expect(world.state.changeLog).toHaveLength(6);
    expect(world.state.reviews).toEqual([expect.objectContaining({ Method: "market", State: "scheduled" })]);
    expect(world.ledgerActions()).toEqual(["rent_review.schedule", "lease_event.option_exercised"]);
    expect(world.event(String(world.state.events[0].LeaseEventId))).toMatchObject({ DecidedByName: "Bo Manager", Outcome: "exercised", State: "exercised" });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(escalation.concludeForSubject).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "exercised", subjectType: "lease_event" }));
  });

  it("rolls the whole thing back when any write fails: no expiry, no rows, no review, nothing decided", async () => {
    await recorded();
    const before = JSON.stringify({ events: world.state.events, reviews: world.state.reviews, tenancy: world.state.tenancy });
    world.failLedgerAction = "lease_event.option_exercised";
    as(PEOPLE.bo);
    const res = await approve();
    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(JSON.stringify({ events: world.state.events, reviews: world.state.reviews, tenancy: world.state.tenancy })).toBe(before);
    expect(escalation.concludeForSubject).not.toHaveBeenCalled();
  });

  it("leaves an open review on the option's first day to read market from its row, and defers behind an earlier one", async () => {
    await recorded();
    world.state.reviews.push({ Method: "fixed", ReviewId: "rev-9", ScheduledFor: asDate("2027-07-01"), State: "scheduled", TenantId: 7 });
    as(PEOPLE.bo);
    expect(body(await approve()).outcome.marketReview).toEqual({ kind: "existing", reviewId: "rev-9", scheduledFor: "2027-07-01" });
    expect(world.state.reviews).toHaveLength(1);
  });

  it("spawns no review when the option starts on the lease's own method", async () => {
    await recorded({ startMethod: "fixed" });
    as(PEOPLE.bo);
    expect(body(await approve()).outcome.marketReview).toEqual({ kind: "none", reviewId: null, scheduledFor: null });
    expect(world.ledgerActions()).toEqual(["lease_event.option_exercised"]);
  });

  it("blocks the recorder from approving their own notice (sod_blocked, ledgered), but not a director", async () => {
    await recorded();
    world.state.ledger = [];
    as(PEOPLE.bo);
    world.event(String(world.state.events[0].LeaseEventId))!.RecordedById = PEOPLE.bo.userId;
    const res = await approve();
    expect(res.status).toBe(403);
    expect(body(res)).toMatchObject({ code: "sod_blocked" });
    expect(world.ledgerActions()).toEqual(["sod_blocked"]);
    world.event(String(world.state.events[0].LeaseEventId))!.RecordedById = PEOPLE.dee.userId;
    as(PEOPLE.dee);
    expect((await approve()).status).toBe(200);
  });

  it("refuses admin on a real tenancy and lets admin through on a test one (decision 4); refuses plain accounts", async () => {
    await recorded();
    as(PEOPLE.ada);
    const refused = await approve();
    expect(body(refused)).toMatchObject({ code: "admin_test_records_only" });
    expect(world.ledgerActions()).toContain("denied");
    as(PEOPLE.ann);
    expect((await approve()).status).toBe(403);
    world.state.tenancy.IsTest = true;
    as(PEOPLE.ada);
    expect((await approve()).status).toBe(200);
  });

  it("needs a director's reason for a late notice (C10) and for a schedule not signed off (C3)", async () => {
    await recorded({ noticeDate: "2026-06-29", reason: "Posted early" });
    as(PEOPLE.bo);
    expect(body(await approve())).toMatchObject({ code: "late_notice" });
    as(PEOPLE.dee);
    expect(body(await approve())).toMatchObject({ code: "late_notice", directorCanOverride: true });
    world.state.tenancy.ScheduleSignedOffAt = null;
    const res = await approve({ overrideReason: "Tenant's letter was posted before the window; we accept it" });
    expect(res.status).toBe(200);
    const overrides = world.state.ledger.filter((row) => row.Action === "lease_event.director_override");
    expect(overrides.map((row) => row.RuleApplied)).toEqual(["option_window", "not_signed_off"]);
    expect(overrides.every((row) => row.IsException === true && typeof row.Reason === "string")).toBe(true);
  });

  it("refuses a non-director when the schedule isn't signed off", async () => {
    await recorded();
    world.state.tenancy.ScheduleSignedOffAt = null;
    as(PEOPLE.bo);
    expect(body(await approve())).toMatchObject({ code: "not_signed_off" });
  });

  it("is 409 on a stale version, and when the expiry moved since the notice", async () => {
    await recorded();
    as(PEOPLE.bo);
    const stale = await approve({ rowVersion: "00000000000000ff" });
    expect(stale.status).toBe(409);
    expect(body(stale)).toMatchObject({ code: "stale", current: { state: "awaiting_approval" } });
    world.state.tenancy.Expiry = asDate("2027-09-30");
    expect(body(await approve())).toMatchObject({ code: "expiry_changed" });
  });

  it("refuses to merge into a schedule that already runs past the expiry", async () => {
    await recorded();
    const steps = parseSteps(world.state.tenancy.ScheduledRateSteps as string);
    world.state.tenancy.ScheduledRateSteps = JSON.stringify([...steps, { effectiveFrom: "2027-07-01", id: "pre", methodKind: "fixed", ratePercent: 3 }]);
    as(PEOPLE.bo);
    expect(body(await approve())).toMatchObject({ code: "schedule_conflict", from: "2027-07-01" });
  });

  it("cancels an open renewal referral the exercise supersedes", async () => {
    await recorded();
    world.state.events.push(eventRow({ LeaseEventId: "rn-1", State: "referred", Type: "renewal" }));
    as(PEOPLE.bo);
    expect((await approve()).status).toBe(200);
    expect(world.event("rn-1")).toMatchObject({ Outcome: "cancelled", State: "cancelled" });
    expect(world.ledgerActions()).toContain("lease_event.cancel");
    expect(escalation.concludeForSubject).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "superseded", subjectId: "rn-1" }));
  });

  it("goes through the money gate and refuses a bad request before the database", async () => {
    requireMoneyContext.mockResolvedValueOnce({ jsonBody: { code: "step_up_required" }, status: 428 });
    as(PEOPLE.bo);
    expect((await approveOptionExercise(postRequest({ leaseEventId: "ev-1", rowVersion: "0000000000000a01" }, "accounts_manager"), ctx)).status).toBe(428);
    expect((await approveOptionExercise(postRequest({ leaseEventId: "ev-1" }, "accounts_manager"), ctx)).status).toBe(400);
    expect((await approveOptionExercise(postRequest({ leaseEventId: "ev-1", rowVersion: "0000000000000a01" }, "accounts"), ctx)).status).toBe(403);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("rejectOptionNotice", () => {
  it("lets a director reject a recorded notice with a reason; nothing on the lease changes", async () => {
    world.state.events.push(eventRow({ RecordedById: PEOPLE.ann.userId, State: "awaiting_approval" }));
    const before = JSON.stringify(world.state.tenancy);
    as(PEOPLE.dee);
    const res = await reject();
    expect(body(res).event).toMatchObject({ outcome: "rejected", outcomeReason: "Notice not signed by the tenant", state: "rejected" });
    expect(JSON.stringify(world.state.tenancy)).toBe(before);
    expect(world.state.ledger.map((row) => [row.Action, row.IsException])).toEqual([["lease_event.option_rejected", true]]);
  });

  it("refuses anyone but a director, needs a reason, and only a recorded notice", async () => {
    world.state.events.push(eventRow({ State: "awaiting_approval" }));
    as(PEOPLE.bo);
    expect((await rejectOptionNotice(postRequest({ leaseEventId: "ev-1", reason: "x", rowVersion: world.versionOf() }, "accounts_manager"), ctx)).status).toBe(403);
    as(PEOPLE.dee);
    expect((await reject({ reason: " " })).status).toBe(400);
    world.event()!.State = "window_open";
    expect((await reject()).status).toBe(409);
  });
});

describe("getTenancyLeaseEvents", () => {
  it("returns the events, the options left, the window and the term an exercise would add", async () => {
    world.state.events.push(eventRow());
    const res = await getTenancyLeaseEvents(getRequest({ tenantId: "7" }, "accounts"), ctx);
    expect(res.status).toBe(200);
    expect(body(res)).toMatchObject({
      defaults: { fixedPercent: 3, intervalMonths: 12, ongoingMethod: "fixed" },
      events: [expect.objectContaining({ leaseEventId: "ev-1", state: "window_open" })],
      optionTerm: { newExpiry: "2032-06-30", optionStart: "2027-07-01" },
      options: { remaining: 2, source: "parsed", termMonths: 60, total: 2 },
      today: "2026-10-23",
      window: { deadline: "2026-12-30", opensAt: "2026-06-30", state: "open" },
    });
    expect((await getTenancyLeaseEvents(getRequest({ tenantId: "x" }, "accounts"), ctx)).status).toBe(400);
    expect((await getTenancyLeaseEvents(getRequest({ tenantId: "7" }, "facilities"), ctx)).status).toBe(403);
  });
});
