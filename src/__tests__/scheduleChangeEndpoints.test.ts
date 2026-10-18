/// <reference types="jest" />
// WP26c: asking for rent relief, a director ratifying or rejecting it, the asker
// withdrawing it, and the list, through the real handlers against the in-memory
// database (fixtures/rentReviewWorld.ts: a rollback really restores every
// table). Auth is the real requireRole via the dev role header; the ledger is
// real and lands in the world; the escalation engine is mocked here and tested
// on its own (escalation/adapters/scheduleChange.test.ts).
import type { InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { calculateRentReview } from "../functions/calculateRentReview";
import { getScheduleChanges } from "../functions/getScheduleChanges";
import { ratifyScheduleChange } from "../functions/ratifyScheduleChange";
import { rejectScheduleChange } from "../functions/rejectScheduleChange";
import { requestScheduleChange } from "../functions/requestScheduleChange";
import { withdrawScheduleChange } from "../functions/withdrawScheduleChange";
import { addDaysIso, daysBetweenIso } from "../darwinDate";
import { formatDisplayDate } from "../digest/format";
import { arrearsFor } from "../rentReview/arrears";
import { parseReliefs, type RentRelief } from "../scheduleCharges";
import { getRequest, postRequest } from "./fixtures/rentReviewFakes";
import { COMMENCED, PEOPLE, REVIEW_DATE, seed, TODAY, type Person } from "./fixtures/rentReviewScenario";
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
jest.mock("../scheduleChange/escalation", () => ({
  raiseRatification: jest.fn().mockResolvedValue(null),
  settleRatification: jest.fn().mockResolvedValue(1),
}));

const db = require("../db") as Record<string, jest.Mock>;
const { resolveLedgerActor } = require("../ledger/actor") as { resolveLedgerActor: jest.Mock };
const cache = require("../tenant-register-cache") as { invalidateTenantAndBuilding: jest.Mock };
const escalation = require("../scheduleChange/escalation") as { raiseRatification: jest.Mock; settleRatification: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const DAY = (n: number) => addDaysIso(TODAY, n);
const r2 = (n: number) => Math.round(n * 100) / 100;
/** The rent in force from last year's review on: 120,000 × 100 / 97. */
const RENT = 123711.34;

let world: ReviewWorld;
let caller: Person = PEOPLE.ann;
type Handler = typeof requestScheduleChange;
const call = (handler: Handler, body: Record<string, unknown>, person: Person = caller) => {
  caller = person;
  return handler(postRequest(body, person.role), ctx);
};
const RELIEF = { from: DAY(10), kind: "percent", scope: ["rent"], to: DAY(100), value: 50 };
const ask = (over: Record<string, unknown> = {}, person: Person = PEOPLE.ann) =>
  call(requestScheduleChange, { kind: "relief", reason: "Fit-out works close the shop front", relief: RELIEF, scheduleVersion: 4, tenantId: 7, ...over }, person);
const changeOf = (res: { jsonBody?: unknown }) => (res.jsonBody as { change: Record<string, any> }).change;
const bodyOf = (res: { jsonBody?: unknown }) => res.jsonBody as Record<string, any>;
const versionOfChange = (requestId: string) => String(world.change(requestId).Version);
const ledgerOf = (action: string) => world.ledgerRows().filter((row) => row.Action === action);

/** Asked for by Ann; returns the request id. */
async function asked(over: Record<string, unknown> = {}): Promise<string> {
  const res = await ask(over);
  expect(res.status).toBe(201);
  return changeOf(res).requestId as string;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  delete process.env.REVIEW_WORKFLOW_LIVE_FROM;
  delete process.env.MONEY_ALLOWED_CIDRS;
  world = new ReviewWorld();
  useWorld(() => world, db);
  resolveLedgerActor.mockImplementation(async () => caller);
  seed(world);
  caller = PEOPLE.ann;
});

describe("requestScheduleChange", () => {
  it("stores an accounts user's relief as pending and changes no schedule row", async () => {
    const before = world.tenant(7);
    const steps = before.ScheduledRateSteps;
    const res = await ask();
    expect(res.status).toBe(201);
    const change = changeOf(res);
    expect(change).toMatchObject({
      decided: null,
      kind: "relief",
      reason: "Fit-out works close the shop front",
      relief: RELIEF,
      requested: { byName: "Ann Accounts", userId: 7 },
      state: "pending",
      tenantId: 7,
      tenantName: "Acme Pty Ltd",
    });
    expect(change.summary).toMatch(/^Rent relief: 50% off the rent, /);
    const tenant = world.tenant(7);
    expect(tenant.ScheduledRateSteps).toBe(steps);
    expect(tenant.RentReliefs ?? null).toBeNull();
    expect(tenant.ScheduleVersion).toBe(4);

    // What it would forgo over its 91 days: half the rent in force, pro rata.
    const days = daysBetweenIso(RELIEF.from, addDaysIso(RELIEF.to, 1));
    const forgone = r2(r2((RENT * days) / 365) - r2((r2(RENT / 2) * days) / 365));
    expect(bodyOf(res).forgone).toEqual({ byCharge: { ahac: null, carparks: null, miscFees: null, rent: forgone }, total: forgone });

    const [row] = ledgerOf("schedule.change_requested");
    expect(row).toMatchObject({ ActorName: "Ann Accounts", ActorUserId: 7, IsException: false, Reason: "Fit-out works close the shop front", RuleApplied: "awaits_director", SubjectId: change.requestId, SubjectType: "schedule_change", TenantId: 7 });
    expect(row.FinancialImpact ?? null).toBeNull();
    expect(row.computed).toMatchObject({ forgone: { total: forgone }, scheduleVersion: 4 });
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(7, 5);
    expect(escalation.raiseRatification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ requestId: change.requestId }));
  });

  it.each([
    ["accounts manager", PEOPLE.bo],
    ["CFO", PEOPLE.cy],
    ["director", PEOPLE.dee],
  ])("lets a %s ask too", async (_label, person) => {
    expect((await ask({}, person)).status).toBe(201);
  });

  it.each(["facilities", "facilities_manager", "user"])("refuses %s before reading anything", async (role) => {
    const res = await requestScheduleChange(postRequest({ tenantId: 7 }, role), ctx);
    expect(res.status).toBe(403);
    expect(world.state.changes).toHaveLength(0);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["a bad relief", { relief: { ...RELIEF, value: 0 } }, 400, "bad_request", /more than 0%/],
    ["a manual change", { kind: "manual_change" }, 400, "kind_not_requestable", /Only rent relief/],
    ["a ratchet override", { kind: "ratchet_override" }, 400, "kind_not_requestable", /ratchet/],
    ["no reason", { reason: "  " }, 400, "reason_required", /reason/],
    ["no scheduleVersion", { scheduleVersion: undefined }, 400, "bad_request", /scheduleVersion/],
    ["no tenancy id", { tenantId: "7" }, 400, "bad_request", /tenantId/],
  ])("refuses %s", async (_label, over, status, code, message) => {
    const res = await ask(over);
    expect(res.status).toBe(status);
    expect(bodyOf(res)).toMatchObject({ code });
    expect(bodyOf(res).error).toMatch(message);
    expect(world.state.changes).toHaveLength(0);
    expect(world.state.ledger).toHaveLength(0);
  });

  it("is a 409 against a schedule that moved since it was read, naming who moved it", async () => {
    world.tenant(7).UpdatedByName = "Bo Manager";
    const res = await ask({ scheduleVersion: 3 });
    expect(res.status).toBe(409);
    expect(bodyOf(res)).toMatchObject({ code: "stale_schedule", scheduleVersion: 4 });
    expect(bodyOf(res).error).toMatch(/changed by Bo Manager/);
    expect(world.state.changes).toHaveLength(0);
  });

  it("refuses a relief that overlaps one awaiting a director on the same charge, and allows another charge", async () => {
    await asked();
    const overlap = await ask({ relief: { ...RELIEF, from: DAY(50), to: DAY(150) } });
    expect(overlap.status).toBe(409);
    expect(bodyOf(overlap)).toMatchObject({ code: "relief_overlap", overlaps: { state: "pending" } });
    expect(world.state.changes).toHaveLength(1);
    expect(ledgerOf("schedule.change_requested")).toHaveLength(1);

    world.tenant(7).CarparkScheduleGroups = JSON.stringify([{ baseMonthlyRate: 400, carparkIds: ["b1"], commencedAt: "2000-01-01", id: "bbbbbbbb-0000-4000-8000-000000000001", label: "Bay 1" }]);
    expect((await ask({ relief: { ...RELIEF, scope: ["carparks"] } })).status).toBe(201);
  });

  it("refuses a relief that overlaps a ratified one", async () => {
    const ratified: RentRelief = { from: DAY(-5), id: "old-relief", kind: "percent", scope: ["rent"], to: DAY(20), value: 10 };
    world.tenant(7).RentReliefs = JSON.stringify([ratified]);
    const res = await ask();
    expect(res.status).toBe(409);
    expect(bodyOf(res)).toMatchObject({ code: "relief_overlap", overlaps: { requestId: "old-relief", state: "ratified" } });
    expect(bodyOf(res).error).toMatch(/already approved for/);
  });

  it.each([
    ["a charge the tenancy hasn't got", { relief: { ...RELIEF, scope: ["ahac"] } }, "nothing_to_relieve", /no after-hours air-conditioning/],
    ["more off than the rent", { relief: { ...RELIEF, kind: "amount", value: RENT + 1 } }, "relief_too_large", /more than the rent/],
    ["a fixed rent that isn't lower", { relief: { ...RELIEF, kind: "fixed_rent", value: RENT } }, "not_a_reduction", /isn't below/],
  ])("refuses %s (422)", async (_label, over, code, message) => {
    const res = await ask(over);
    expect(res.status).toBe(422);
    expect(bodyOf(res)).toMatchObject({ code });
    expect(bodyOf(res).error).toMatch(message);
    expect(world.state.changes).toHaveLength(0);
  });

  it("refuses a day before the schedule starts when the lease's commencement isn't recorded (422 nothing_to_relieve)", async () => {
    world.tenant(7).Commencement = null;
    const res = await ask({ relief: { ...RELIEF, from: "2000-01-01", to: "2000-02-01" } });
    expect(res.status).toBe(422);
    expect(bodyOf(res)).toMatchObject({ code: "nothing_to_relieve" });
    expect(bodyOf(res).error).toMatch(/charges no rent on 01\/01\/2000/);
  });

  // WP26c review, finding 6. Holdover (a tenancy staying on past its expiry) is
  // refused too until Connor decides whether it can carry a relief.
  describe("a relief outside the lease's dates (422 outside_lease)", () => {
    const expiry = () => String(world.tenant(7).Expiry);

    it("refuses one that runs past the lease's expiry, in plain words, and keeps nothing", async () => {
      const to = addDaysIso(expiry(), 1);
      const res = await ask({ relief: { ...RELIEF, to } });
      expect(res.status).toBe(422);
      expect(bodyOf(res)).toMatchObject({ code: "outside_lease", leaseExpiry: expiry() });
      expect(bodyOf(res).error).toBe(
        `This relief runs to ${formatDisplayDate(to)}, after the lease ends on ${formatDisplayDate(expiry())}. A relief has to end by the lease's last day.`,
      );
      expect(world.state.changes).toHaveLength(0);
      expect(world.state.ledger).toHaveLength(0);
    });

    it("takes one that ends on the lease's last day", async () => {
      expect((await ask({ relief: { ...RELIEF, to: expiry() } })).status).toBe(201);
    });

    it("refuses one that starts before the lease commences", async () => {
      const from = addDaysIso(COMMENCED, -1);
      const res = await ask({ relief: { ...RELIEF, from, to: addDaysIso(COMMENCED, 30) } });
      expect(res.status).toBe(422);
      expect(bodyOf(res)).toMatchObject({ code: "outside_lease", leaseCommencement: COMMENCED });
      expect(bodyOf(res).error).toBe(
        `This relief starts on ${formatDisplayDate(from)}, before the lease starts on ${formatDisplayDate(COMMENCED)}. A relief has to start on or after the lease's first day.`,
      );
    });

    it("refuses a tenancy holding over: any relief after its expiry", async () => {
      world.tenant(7).Expiry = DAY(5);
      const res = await ask();
      expect(res.status).toBe(422);
      expect(bodyOf(res)).toMatchObject({ code: "outside_lease" });
    });
  });

  it("takes an amount off the rent or a fixed rent below it", async () => {
    expect((await ask({ relief: { ...RELIEF, kind: "amount", value: 24000 } })).status).toBe(201);
    world.state.changes = [];
    expect((await ask({ relief: { ...RELIEF, kind: "fixed_rent", value: 60000 } })).status).toBe(201);
  });

  it.each([
    ["archived", { ArchivedAt: new Date() }, 422, "tenancy_archived"],
    ["vacated", { Status: "vacated" }, 422, "tenancy_vacated"],
  ])("refuses a tenancy that is %s", async (_label, over, status, code) => {
    Object.assign(world.tenant(7), over);
    const res = await ask();
    expect(res.status).toBe(status);
    expect(bodyOf(res)).toMatchObject({ code });
  });

  it("is a 404 for a tenancy that doesn't exist", async () => {
    expect((await ask({ tenantId: 999 })).status).toBe(404);
  });

  it("keeps nothing when the ledger write fails (no ledger row, no request)", async () => {
    const picture = world.picture();
    world.failLedger = (row) => row.Action === "schedule.change_requested";
    const res = await ask();
    expect(res.status).toBe(500);
    expect(world.picture()).toBe(picture);
    expect(escalation.raiseRatification).not.toHaveBeenCalled();
  });
});

describe("ratifyScheduleChange", () => {
  const ratify = (requestId: string, over: Record<string, unknown> = {}, person: Person = PEOPLE.dee) =>
    call(ratifyScheduleChange, { requestId, rowVersion: versionOfChange(requestId), scheduleVersion: Number(world.tenant(7).ScheduleVersion), ...over }, person);

  it("writes the relief onto the schedule in one transaction, keeps the sign-off and ledgers the charge forgone", async () => {
    const requestId = await asked();
    const forgone = (ledgerOf("schedule.change_requested")[0].computed as { forgone: { total: number } }).forgone.total;
    const signedOffAt = world.tenant(7).ScheduleSignedOffAt;
    const steps = world.tenant(7).ScheduledRateSteps;
    const committed = world.committed;

    const res = await ratify(requestId, { note: "Agreed at the board, 16 Oct" });
    expect(res.status).toBe(200);
    expect(world.committed).toBe(committed + 1);
    const tenant = world.tenant(7);
    const [relief] = parseReliefs(String(tenant.RentReliefs));
    expect(relief).toMatchObject({ ...RELIEF, id: requestId, ratifiedByName: "Dee Director", reason: "Fit-out works close the shop front" });
    expect(Number.isNaN(Date.parse(String(relief.ratifiedAt)))).toBe(false);
    expect(tenant.ScheduleVersion).toBe(5);
    expect(tenant.ScheduleSignedOffAt).toBe(signedOffAt);
    expect(tenant.ScheduledRateSteps).toBe(steps);
    expect(world.change(requestId)).toMatchObject({ DecidedById: 10, DecidedByName: "Dee Director", DecisionNote: "Agreed at the board, 16 Oct", State: "ratified" });
    expect(bodyOf(res)).toMatchObject({ forgone: { total: forgone }, scheduleVersion: 5 });
    expect(changeOf(res)).toMatchObject({ decided: { byName: "Dee Director", note: "Agreed at the board, 16 Oct" }, state: "ratified" });

    const [row] = ledgerOf("schedule.change_ratified");
    expect(row).toMatchObject({ ActorName: "Dee Director", FinancialImpact: forgone, IsException: true, Reason: "Agreed at the board, 16 Oct", RuleApplied: "director_ratified", SubjectId: requestId, TenantId: 7 });
    expect(forgone).toBeGreaterThan(0);
    expect(row.after).toMatchObject({ scheduleVersion: 5, signOff: { by: "Bo Manager", kept: true }, state: "ratified" });
    expect(row.before).toEqual({ rentReliefs: [], scheduleVersion: 4, state: "pending" });
    expect(cache.invalidateTenantAndBuilding).toHaveBeenLastCalledWith(7, 5);
    expect(escalation.settleRatification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "ratified", requestId }));
  });

  it("records why it was asked for when the director adds no note, and says when a director ratifies their own request", async () => {
    const requestId = await asked({}, );
    world.change(requestId).RequestedById = 10;
    expect((await ratify(requestId)).status).toBe(200);
    expect(ledgerOf("schedule.change_ratified")[0]).toMatchObject({ Reason: "Fit-out works close the shop front", RuleApplied: "director_own_request" });
  });

  it.each([
    ["an accounts manager", "accounts_manager"],
    ["the CFO", "cfo"],
    ["accounts", "accounts"],
  ])("refuses %s at the role gate", async (_label, role) => {
    const requestId = await asked();
    const res = await ratifyScheduleChange(postRequest({ requestId, rowVersion: versionOfChange(requestId) }, role), ctx);
    expect(res.status).toBe(403);
    expect(world.change(requestId).State).toBe("pending");
  });

  it("refuses admin, whom requireRole lets through, and ledgers the attempt", async () => {
    const requestId = await asked();
    const res = await ratify(requestId, {}, PEOPLE.ada);
    expect(res.status).toBe(403);
    expect(bodyOf(res)).toMatchObject({ code: "forbidden", error: "Only a director can approve a schedule change" });
    expect(world.change(requestId).State).toBe("pending");
    expect(world.tenant(7).RentReliefs ?? null).toBeNull();
    expect(ledgerOf("denied")).toEqual([expect.objectContaining({ ActorName: "Ada Admin", RuleApplied: "not_director", SubjectId: requestId, SubjectType: "schedule_change" })]);
  });

  it("is a 409 on a stale rowVersion, with the request as it is now", async () => {
    const requestId = await asked();
    const res = await ratify(requestId, { rowVersion: "0000000000000001" });
    expect(res.status).toBe(409);
    expect(bodyOf(res)).toMatchObject({ code: "stale", current: { requestId, state: "pending" } });
    expect(world.tenant(7).ScheduleVersion).toBe(4);
  });

  it("can't ratify twice", async () => {
    const requestId = await asked();
    expect((await ratify(requestId)).status).toBe(200);
    const again = await ratify(requestId, { rowVersion: versionOfChange(requestId) });
    expect(again.status).toBe(409);
    expect(bodyOf(again)).toMatchObject({ code: "invalid_state", error: "This change has been approved, so it can't be approved" });
    expect(parseReliefs(String(world.tenant(7).RentReliefs))).toHaveLength(1);
  });

  it("checks the schedule again: a relief ratified in the meantime that overlaps it is refused", async () => {
    const requestId = await asked();
    world.tenant(7).RentReliefs = JSON.stringify([{ from: DAY(90), id: "late", kind: "percent", scope: ["rent"], to: DAY(120), value: 5 }]);
    const res = await ratify(requestId);
    expect(res.status).toBe(409);
    expect(bodyOf(res).error).toMatch(/^The schedule has changed since this was asked for\. This overlaps/);
    expect(world.change(requestId).State).toBe("pending");
  });

  it("rolls everything back when the ledger write fails: the schedule, the version and the request as they were", async () => {
    const requestId = await asked();
    const picture = world.picture();
    world.failLedger = (row) => row.Action === "schedule.change_ratified";
    const res = await ratify(requestId);
    expect(res.status).toBe(500);
    expect(world.picture()).toBe(picture);
    expect(world.tenant(7)).toMatchObject({ ScheduleVersion: 4 });
    expect(world.tenant(7).RentReliefs ?? null).toBeNull();
    expect(world.change(requestId).State).toBe("pending");
    expect(escalation.settleRatification).not.toHaveBeenCalled();
  });

  it("is a 404 for a request that doesn't exist", async () => {
    expect((await call(ratifyScheduleChange, { requestId: "nope", rowVersion: "0000000000000001", scheduleVersion: 4 }, PEOPLE.dee)).status).toBe(404);
  });

  // WP26c review, finding 5: the director's figures are the schedule's as their page read it.
  it("is a 409 stale_schedule when the schedule moved since the director's page read it, and changes nothing", async () => {
    const requestId = await asked();
    const seenVersion = Number(world.tenant(7).ScheduleVersion);
    // A row edited, or a review applied, after the page loaded: the version moves, the request's doesn't.
    Object.assign(world.tenant(7), { ScheduleVersion: seenVersion + 1, UpdatedByName: "Bo Manager" });
    const res = await ratify(requestId, { scheduleVersion: seenVersion });
    expect(res.status).toBe(409);
    expect(bodyOf(res)).toEqual({
      code: "stale_schedule",
      error: "This tenancy's schedule was changed by Bo Manager since you opened it. Reload it and check the figures before approving.",
      scheduleVersion: seenVersion + 1,
    });
    expect(world.change(requestId).State).toBe("pending");
    expect(world.tenant(7).RentReliefs ?? null).toBeNull();
    expect(ledgerOf("schedule.change_ratified")).toHaveLength(0);
    expect((await ratify(requestId)).status).toBe(200);
  });

  it("needs the scheduleVersion the director's page read", async () => {
    const requestId = await asked();
    const res = await ratify(requestId, { scheduleVersion: undefined });
    expect(res.status).toBe(400);
    expect(bodyOf(res).error).toMatch(/scheduleVersion is required/);
    expect(world.change(requestId).State).toBe("pending");
  });

  it("refuses a relief that now runs past the lease's expiry (outside_lease), so the director rejects it", async () => {
    const requestId = await asked();
    world.tenant(7).Expiry = DAY(50);
    const res = await ratify(requestId);
    expect(res.status).toBe(422);
    expect(bodyOf(res)).toMatchObject({ code: "outside_lease" });
    expect(bodyOf(res).error).toBe(
      `This relief runs to ${formatDisplayDate(RELIEF.to)}, after the lease ends on ${formatDisplayDate(DAY(50))}. A relief has to end by the lease's last day. Reject it, and ask again with dates inside the lease.`,
    );
    expect(world.change(requestId).State).toBe("pending");
  });

  // WP26c review, finding 4 (database-safety rule 7): ratifying appends to the
  // stored array; it never rebuilds it from what today's code can read.
  describe("Tenants.RentReliefs is appended to, never rebuilt", () => {
    const unknownField = { endedEarlyOn: DAY(220), from: DAY(200), id: "old-unknown", kind: "percent", scope: ["rent"], to: DAY(230), value: 10 };
    const rejectedToday = { from: DAY(300), id: "old-rejected", kind: "rebate", scope: ["rent"], to: DAY(330), value: 5 };
    const raw = `[\n  ${JSON.stringify(unknownField)},\n  ${JSON.stringify(rejectedToday)}\n]\n`;

    it("keeps an entry with a field it doesn't know and one today's rules reject, byte for byte, and ledgers the whole array as it was", async () => {
      expect(parseReliefs(raw).map((relief) => relief.id)).toEqual(["old-unknown"]);
      world.tenant(7).RentReliefs = raw;
      const requestId = await asked();
      expect((await ratify(requestId)).status).toBe(200);

      const stored = String(world.tenant(7).RentReliefs);
      expect(stored.startsWith(raw.slice(0, raw.lastIndexOf("]")))).toBe(true);
      expect(stored.endsWith("]\n")).toBe(true);
      const entries = JSON.parse(stored) as Array<Record<string, unknown>>;
      expect(entries).toHaveLength(3);
      expect(entries[0]).toEqual(unknownField);
      expect(entries[1]).toEqual(rejectedToday);
      expect(entries[2]).toMatchObject({ ...RELIEF, id: requestId, ratifiedByName: "Dee Director" });
      expect(ledgerOf("schedule.change_ratified")[0].before).toEqual({ rentReliefs: [unknownField, rejectedToday], scheduleVersion: 4, state: "pending" });

      // A later ratification keeps all three as they are now.
      const second = await asked({ relief: { ...RELIEF, from: DAY(400), to: DAY(430) }, scheduleVersion: Number(world.tenant(7).ScheduleVersion) });
      expect((await ratify(second)).status).toBe(200);
      const after = String(world.tenant(7).RentReliefs);
      expect(after.startsWith(stored.slice(0, stored.lastIndexOf("]")))).toBe(true);
      expect((JSON.parse(after) as unknown[]).slice(0, 3)).toEqual(entries);
    });

    it.each([
      ["an object", '{"id":"x"}'],
      ["text that isn't JSON", "[{"],
      ["a JSON string", '"[]"'],
    ])("refuses (422) when the column holds %s, and writes nothing over it", async (_label, value) => {
      world.tenant(7).RentReliefs = value;
      const requestId = await asked();
      const res = await ratify(requestId);
      expect(res.status).toBe(422);
      expect(bodyOf(res)).toEqual({
        code: "unreadable_reliefs",
        error: "The rent reliefs already stored on this tenancy can't be read, so nothing was changed. Ask an administrator to check the tenancy's record before approving this.",
      });
      expect(world.tenant(7).RentReliefs).toBe(value);
      expect(world.tenant(7).ScheduleVersion).toBe(4);
      expect(world.change(requestId).State).toBe("pending");
    });
  });
});

describe("rejectScheduleChange", () => {
  const reject = (requestId: string, over: Record<string, unknown> = {}, person: Person = PEOPLE.dee) =>
    call(rejectScheduleChange, { note: "Not while the tenant is in arrears", requestId, rowVersion: versionOfChange(requestId), ...over }, person);

  it("turns it down with a note and leaves the schedule alone", async () => {
    const requestId = await asked();
    const res = await reject(requestId);
    expect(res.status).toBe(200);
    expect(changeOf(res)).toMatchObject({ decided: { byName: "Dee Director", note: "Not while the tenant is in arrears" }, state: "rejected" });
    expect(world.tenant(7).RentReliefs ?? null).toBeNull();
    expect(world.tenant(7).ScheduleVersion).toBe(4);
    expect(ledgerOf("schedule.change_rejected")).toEqual([
      expect.objectContaining({ ActorName: "Dee Director", IsException: false, Reason: "Not while the tenant is in arrears", RuleApplied: "director_rejected", SubjectId: requestId }),
    ]);
    expect(escalation.settleRatification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "rejected", note: "Not while the tenant is in arrears", requestId }));
  });

  it("needs a note", async () => {
    const requestId = await asked();
    const res = await reject(requestId, { note: "" });
    expect(res.status).toBe(400);
    expect(bodyOf(res)).toMatchObject({ code: "reason_required" });
    expect(world.change(requestId).State).toBe("pending");
  });

  it("refuses admin (ledgered) and accounts", async () => {
    const requestId = await asked();
    expect((await reject(requestId, {}, PEOPLE.ada)).status).toBe(403);
    expect(ledgerOf("denied")).toHaveLength(1);
    expect((await rejectScheduleChange(postRequest({ note: "x", requestId, rowVersion: versionOfChange(requestId) }, "accounts"), ctx)).status).toBe(403);
    expect(world.change(requestId).State).toBe("pending");
  });

  it("is a 409 when stale or already decided", async () => {
    const requestId = await asked();
    expect(bodyOf(await reject(requestId, { rowVersion: "0000000000000001" }))).toMatchObject({ code: "stale" });
    expect((await reject(requestId)).status).toBe(200);
    expect(bodyOf(await reject(requestId))).toMatchObject({ code: "invalid_state" });
  });

  it("says an approved change has been approved", async () => {
    const requestId = await asked();
    expect((await call(ratifyScheduleChange, { requestId, rowVersion: versionOfChange(requestId), scheduleVersion: 4 }, PEOPLE.dee)).status).toBe(200);
    expect(bodyOf(await reject(requestId))).toMatchObject({ code: "invalid_state", error: "This change has been approved, so it can't be rejected" });
  });
});

describe("withdrawScheduleChange", () => {
  const withdraw = (requestId: string, over: Record<string, unknown> = {}, person: Person = PEOPLE.ann) =>
    call(withdrawScheduleChange, { reason: "The tenant found the money", requestId, rowVersion: versionOfChange(requestId), ...over }, person);

  it("lets the person who asked take it back", async () => {
    const requestId = await asked();
    const res = await withdraw(requestId);
    expect(res.status).toBe(200);
    expect(changeOf(res)).toMatchObject({ decided: { byName: "Ann Accounts", note: "The tenant found the money" }, state: "withdrawn" });
    expect(ledgerOf("schedule.change_withdrawn")).toEqual([expect.objectContaining({ ActorUserId: 7, Reason: "The tenant found the money", RuleApplied: "requester_withdrew" })]);
    expect(escalation.settleRatification).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "withdrawn", requestId, withdrawn: true }));
  });

  it.each([
    ["another accounts user", PEOPLE.bo],
    ["a director (who rejects instead)", PEOPLE.dee],
  ])("refuses %s, and ledgers it", async (_label, person) => {
    const requestId = await asked();
    const res = await withdraw(requestId, {}, person);
    expect(res.status).toBe(403);
    expect(bodyOf(res).error).toMatch(/Only the person who asked/);
    expect(ledgerOf("denied")).toEqual([expect.objectContaining({ RuleApplied: "not_requester" })]);
    expect(world.change(requestId).State).toBe("pending");
  });

  it("needs a reason, a fresh rowVersion and a pending request", async () => {
    const requestId = await asked();
    expect(bodyOf(await withdraw(requestId, { reason: undefined }))).toMatchObject({ code: "reason_required" });
    expect(bodyOf(await withdraw(requestId, { rowVersion: "0000000000000001" }))).toMatchObject({ code: "stale" });
    expect((await call(ratifyScheduleChange, { requestId, rowVersion: versionOfChange(requestId), scheduleVersion: 4 }, PEOPLE.dee)).status).toBe(200);
    expect(bodyOf(await withdraw(requestId))).toMatchObject({ code: "invalid_state", error: "This change has been approved, so it can't be withdrawn" });
  });
});

describe("getScheduleChanges", () => {
  it("lists a tenancy's requests newest first, and by state", async () => {
    const first = await asked();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await asked({ relief: { ...RELIEF, from: DAY(200), to: DAY(230) } });
    await call(rejectScheduleChange, { note: "No", requestId: first, rowVersion: versionOfChange(first) }, PEOPLE.dee);

    const all = await getScheduleChanges(getRequest({ tenantId: "7" }), ctx);
    expect(all.status).toBe(200);
    expect(bodyOf(all).changes.map((change: { requestId: string }) => change.requestId)).toEqual([second, first]);
    const pending = await getScheduleChanges(getRequest({ state: "pending" }), ctx);
    expect(bodyOf(pending).changes.map((change: { requestId: string }) => change.requestId)).toEqual([second]);
  });

  it.each([
    [{}, /Give a tenantId or a state/],
    [{ state: "lost" }, /isn't one of/],
    [{ tenantId: "x" }, /whole number/],
  ])("refuses %p", async (query, message) => {
    const res = await getScheduleChanges(getRequest(query as Record<string, string>), ctx);
    expect(res.status).toBe(400);
    expect(bodyOf(res).error).toMatch(message);
  });

  it("is for the roles that may read a tenancy", async () => {
    expect((await getScheduleChanges(getRequest({ tenantId: "7" }, "facilities"), ctx)).status).toBe(403);
    expect((await getScheduleChanges(getRequest({ tenantId: "7" }, "cfo"), ctx)).status).toBe(200);
  });
});

describe("the ratify and reject decisions sit behind the money gate (S11)", () => {
  const NOW = Math.floor(Date.now() / 1000);
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const gated = (body: Record<string, unknown>, claims: Record<string, unknown>, forwardedFor: string) => {
    const token = `${encode({ alg: "none" })}.${encode({ name: "Dee Director", oid: "oid-dee", preferred_username: "dee@example.com", ...claims })}.sig`;
    const headers: Record<string, string> = { authorization: `Bearer ${token}`, "x-dev-roles": "director", "x-forwarded-for": forwardedFor };
    return { headers: { get: (key: string) => headers[key.toLowerCase()] ?? null }, json: async () => body, url: "https://api.example/api/ratifyScheduleChange" } as never;
  };

  it.each([
    ["ratify", ratifyScheduleChange],
    ["reject", rejectScheduleChange],
  ])("refuses to %s from outside the office, or on a stale sign-in, before touching the database", async (_label, handler) => {
    const requestId = await asked();
    process.env.MONEY_ALLOWED_CIDRS = "203.0.113.0/28";
    jest.clearAllMocks();
    const body = { note: "x", requestId, rowVersion: versionOfChange(requestId) };
    const outside = await handler(gated(body, { amr: ["pwd", "mfa"], iat: NOW }, "198.51.100.20"), ctx);
    expect(outside.status).toBe(403);
    expect(bodyOf(outside)).toMatchObject({ code: "money_network_required" });
    const stale = await handler(gated(body, { amr: ["pwd", "mfa"], iat: NOW - 3600 }, "203.0.113.5"), ctx);
    expect(stale.status).toBe(428);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(world.change(requestId).State).toBe("pending");
  });
});

describe("a review's arrears under a ratified relief", () => {
  const changes = [{ after: 110000, before: 100000, kind: "rent" as const, label: "Rent" }];

  it("is the plain sum without one, and the relieved difference on the days a relief covers", () => {
    expect(arrearsFor("2026-01-01", "2026-04-01", changes)).toMatchObject({ amount: 2465.75, lines: [{ amount: 2465.75 }] });
    const half: RentRelief = { from: "2026-02-01", id: "r", kind: "percent", scope: ["rent"], to: "2026-02-28", value: 50 };
    // 31 days at 10,000 a year, 28 days at 5,000, 31 days at 10,000.
    expect(arrearsFor("2026-01-01", "2026-04-01", changes, [half])).toMatchObject({
      amount: r2(r2((10000 * 31) / 365) + r2((5000 * 28) / 365) + r2((10000 * 31) / 365)),
      reliefIds: ["r"],
    });
  });

  it("leaves no line for a charge a fixed rent covers throughout, and ignores a relief on another charge", () => {
    const fixed: RentRelief = { from: "2025-12-01", id: "f", kind: "fixed_rent", scope: ["rent"], to: "2026-06-30", value: 50000 };
    expect(arrearsFor("2026-01-01", "2026-04-01", changes, [fixed])).toBeNull();
    const ahacOnly: RentRelief = { from: "2025-12-01", id: "a", kind: "percent", scope: ["ahac"], to: "2026-06-30", value: 50 };
    expect(arrearsFor("2026-01-01", "2026-04-01", changes, [ahacOnly])).toEqual(arrearsFor("2026-01-01", "2026-04-01", changes));
  });

  it("is what CALCULATE shows for a review dated inside a ratified relief", async () => {
    world = new ReviewWorld();
    useWorld(() => world, db);
    seed(world, { tenant: { RentReliefs: JSON.stringify([{ from: REVIEW_DATE, id: "rel", kind: "percent", scope: ["rent"], to: DAY(30), value: 50 }]) } });
    const res = await call(calculateRentReview, { reviewId: "rev-1", rowVersion: String(world.review("rev-1").Version) }, PEOPLE.ann);
    expect(res.status).toBe(200);
    const calc = (res.jsonBody as { review: { calc: { arrears: { lines: Array<{ amount: number; kind: string }>; reliefIds?: string[] }; currentAnnual: number; newAnnual: number } } }).review.calc;
    const days = daysBetweenIso(REVIEW_DATE, TODAY);
    const relieved = r2((r2(r2(calc.newAnnual / 2) - r2(calc.currentAnnual / 2)) * days) / 365);
    expect(calc.arrears.lines.find((line) => line.kind === "rent")?.amount).toBe(relieved);
    expect(calc.arrears.reliefIds).toEqual(["rel"]);
  });
});
