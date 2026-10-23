/// <reference types="jest" />
// WP33: the directors' renewal outcomes through the real handler against the
// in-memory database: renewed (new commencement row, expiry, cadence, options),
// vacating (a draft vacancy available from the expiry), holdover (terms; the
// status once the lease has ended), each ledgered; deciding from the tenancy
// with no referral; refusals. Today is pinned to 23 Oct 2026 in Darwin.
import type { InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { recordRenewalOutcome } from "../functions/recordRenewalOutcome";
import { parseSteps } from "../scheduledRateStepLogic";
import { eventRow, LeaseEventWorld, tenancyRow, useLeaseWorld } from "./fixtures/leaseEventWorld";
import { asDate, postRequest } from "./fixtures/rentReviewFakes";
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
const escalation = jest.requireMock("../escalation") as { concludeForSubject: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

let world: LeaseEventWorld;
let caller: Person = PEOPLE.dee;
const body = (res: { jsonBody?: unknown }) => res.jsonBody as Record<string, any>;
const RENEWED = {
  baseRentPerAnnum: 118000,
  commencement: "2027-07-01",
  expiry: "2032-06-30",
  optionPeriods: "1 x 5 years",
  optionsTotal: 1,
  optionTermMonths: 60,
  reviewIntervalMonths: 12,
  reviewMethod: "cpi",
};
const decide = (over: Record<string, unknown>, person: Person = caller) =>
  recordRenewalOutcome(postRequest({ leaseEventId: "rn-1", rowVersion: world.versionOf("rn-1"), ...over }, person.role), ctx);

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate", "queueMicrotask"] });
  jest.setSystemTime(new Date("2026-10-23T03:00:00Z"));
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  world = new LeaseEventWorld(tenancyRow({ OptionPeriods: "Nil" }), [
    eventRow({ DeadlineOn: null, LeaseEventId: "rn-1", State: "referred", Type: "renewal", WindowOpensOn: null }),
  ]);
  useLeaseWorld(() => world, db);
  caller = PEOPLE.dee;
  resolveLedgerActor.mockImplementation(async () => caller);
});

afterEach(() => jest.useRealTimers());

describe("renewed", () => {
  it("writes the new commencement row, expiry, cadence and options, and ledgers it", async () => {
    const res = await decide({ outcome: "renewed", renewed: RENEWED, note: "Agreed at 118k, CPI annually" });
    expect(res.status).toBe(200);
    expect(body(res).event).toMatchObject({ outcome: "renewed", state: "renewed" });
    const t = world.state.tenancy;
    expect((t.Commencement as Date).toISOString().slice(0, 10)).toBe("2027-07-01");
    expect((t.Expiry as Date).toISOString().slice(0, 10)).toBe("2032-06-30");
    expect([t.ReviewType, t.ReviewIntervalMonths, t.FixedReviewPercent, t.OptionsTotal, t.OptionsRemaining, t.OptionTermMonths, t.OptionPeriods, t.ScheduleVersion]).toEqual([
      "CPI", 12, null, 1, 1, 60, "1 x 5 years", 5,
    ]);
    const steps = parseSteps(t.ScheduledRateSteps as string);
    expect(steps.at(-1)).toMatchObject({ baseRentPerAnnum: 118000, effectiveFrom: "2027-07-01", methodKind: "commencement" });
    expect(steps.at(-2)).toMatchObject({ effectiveFrom: "2023-07-01", effectiveTo: "2027-07-01" });
    expect(world.state.ledger.map((row) => [row.Action, row.Reason])).toEqual([["lease_event.renewed", "Agreed at 118k, CPI annually"]]);
    expect(escalation.concludeForSubject).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: "renewed", subjectId: "rn-1" }));
  });

  it("checks the new term: dates in order, after the current expiry, a rent, a fixed % for a fixed review", async () => {
    expect((await decide({ outcome: "renewed", renewed: { ...RENEWED, expiry: "2027-06-30" } })).status).toBe(400);
    expect((await decide({ outcome: "renewed", renewed: { ...RENEWED, commencement: "2027-06-30" } })).status).toBe(400);
    expect((await decide({ outcome: "renewed", renewed: { ...RENEWED, baseRentPerAnnum: "lots" } })).status).toBe(400);
    expect((await decide({ outcome: "renewed", renewed: { ...RENEWED, reviewMethod: "fixed" } })).status).toBe(400);
    expect((await decide({ outcome: "renewed", renewed: { ...RENEWED, optionTermMonths: null } })).status).toBe(400);
    expect(world.event("rn-1")).toMatchObject({ State: "referred" });
  });
});

describe("vacating", () => {
  it("creates a draft vacancy available from the expiry; the tenancy stays as it is", async () => {
    const res = await decide({ outcome: "vacating" });
    expect(res.status).toBe(200);
    expect(world.state.vacancies).toEqual([expect.objectContaining({ AvailableFrom: "2027-06-30", BuildingId: 3, IsTest: false, TenancyId: 7, Title: "Acme Pty Ltd · Tower A" })]);
    expect(world.state.tenancy.Status).toBe("current");
    expect(body(res).event.outcomeDetails).toMatchObject({ availableFrom: "2027-06-30", vacancyId: 101 });
    expect(world.state.ledger.map((row) => row.Action)).toEqual(["lease_event.vacating"]);
  });

  it("makes a test tenancy's vacancy test data (D9)", async () => {
    world.state.tenancy.IsTest = true;
    await decide({ outcome: "vacating" });
    expect(world.state.vacancies[0]).toMatchObject({ IsTest: true });
  });
});

describe("holdover", () => {
  it("records the terms and leaves the stored status while the lease still runs", async () => {
    const res = await decide({ holdoverTerms: "Month to month at the current rent", outcome: "holdover" });
    expect(res.status).toBe(200);
    expect(world.state.tenancy).toMatchObject({ HoldoverTerms: "Month to month at the current rent", Status: "current" });
    expect(world.state.ledger.map((row) => row.Action)).toEqual(["lease_event.holdover"]);
  });

  it("stores holdover once the expiry has passed", async () => {
    world.state.tenancy.Expiry = asDate("2026-09-30");
    world.event("rn-1")!.LeaseExpiry = asDate("2026-09-30");
    await decide({ holdoverTerms: "Month to month", outcome: "holdover" });
    expect(world.state.tenancy.Status).toBe("holdover");
  });

  it("needs the terms", async () => {
    expect((await decide({ outcome: "holdover" })).status).toBe(400);
  });
});

describe("deciding from the tenancy, with no referral", () => {
  it("opens a referred renewal for the current expiry and decides it in one transaction", async () => {
    world.state.events = [];
    const res = await recordRenewalOutcome(postRequest({ outcome: "vacating", tenantId: 7 }, "director"), ctx);
    expect(res.status).toBe(200);
    expect(world.state.ledger.map((row) => [row.Action, row.RuleApplied])).toEqual([
      ["lease_event.renewal_referred", "opened_by_director"],
      ["lease_event.vacating", "renewal_vacating"],
    ]);
  });

  it("refuses while a renewal is open or decided for this expiry, or an option exercise is open", async () => {
    expect(body(await recordRenewalOutcome(postRequest({ outcome: "vacating", tenantId: 7 }, "director"), ctx))).toMatchObject({ code: "open_event_exists" });
    world.state.events = [eventRow({ State: "awaiting_approval" })];
    expect(body(await recordRenewalOutcome(postRequest({ outcome: "vacating", tenantId: 7 }, "director"), ctx))).toMatchObject({ code: "open_event_exists" });
  });
});

describe("refusals", () => {
  it("is a director's: others 403 at the gate or in the handler; admin only on a test tenancy", async () => {
    expect((await decide({ outcome: "vacating" }, PEOPLE.bo)).status).toBe(403);
    caller = PEOPLE.ada;
    expect(body(await decide({ outcome: "vacating" }, PEOPLE.ada))).toMatchObject({ code: "admin_test_records_only" });
    world.state.tenancy.IsTest = true;
    expect((await decide({ outcome: "vacating" }, PEOPLE.ada)).status).toBe(200);
  });

  it("is 409 when stale or already decided, and when the expiry moved", async () => {
    expect((await decide({ outcome: "vacating", rowVersion: "00000000000000ff" })).status).toBe(409);
    world.state.tenancy.Expiry = asDate("2027-09-30");
    expect(body(await decide({ outcome: "vacating" }))).toMatchObject({ code: "expiry_changed" });
    world.state.tenancy.Expiry = asDate("2027-06-30");
    world.event("rn-1")!.State = "holdover";
    expect(body(await decide({ outcome: "vacating" }))).toMatchObject({ code: "invalid_state" });
  });

  it("checks the outcome before the database", async () => {
    expect((await decide({ outcome: "sell" })).status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});
