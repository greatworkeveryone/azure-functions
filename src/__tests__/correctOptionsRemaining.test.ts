/// <reference types="jest" />
// Data recheck S2: a director corrects the options left (within 0..OptionsTotal),
// with a reason, ledgered, checked against the count they saw (409 when stale).
import type { InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { correctOptionsRemaining } from "../functions/correctOptionsRemaining";
import { LeaseEventWorld, tenancyRow, useLeaseWorld } from "./fixtures/leaseEventWorld";
import { postRequest } from "./fixtures/rentReviewFakes";
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

const db = jest.requireMock("../db") as Record<string, jest.Mock>;
const { resolveLedgerActor } = jest.requireMock("../ledger/actor") as { resolveLedgerActor: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
let world: LeaseEventWorld;
let caller: Person = PEOPLE.dee;
const body = (res: { jsonBody?: unknown }) => res.jsonBody as Record<string, any>;
const correct = (over: Record<string, unknown> = {}, person: Person = caller) =>
  correctOptionsRemaining(postRequest({ expectedRemaining: 0, optionsRemaining: 1, reason: "Renewal recorded 0 by mistake; the lease grants 2 x 5 years", tenantId: 7, ...over }, person.role), ctx);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  world = new LeaseEventWorld(tenancyRow({ OptionsRemaining: 0, OptionsTotal: 2, OptionTermMonths: 60 }));
  useLeaseWorld(() => world, db);
  caller = PEOPLE.dee;
  resolveLedgerActor.mockImplementation(async () => caller);
});

it("lets a director correct the options left, with a reason, ledgered", async () => {
  const res = await correct();
  expect(res.status).toBe(200);
  expect(body(res)).toMatchObject({ optionsRemaining: 1, optionsTotal: 2 });
  expect(world.state.tenancy.OptionsRemaining).toBe(1);
  expect(world.state.ledger.map((row) => [row.Action, row.RuleApplied, row.Reason])).toEqual([
    ["schedule.terms_edit", "options_remaining_corrected", "Renewal recorded 0 by mistake; the lease grants 2 x 5 years"],
  ]);
});

it("keeps the count within what the lease grants, and needs a recorded grant and a reason", async () => {
  expect((await correct({ optionsRemaining: 3 })).status).toBe(400);
  expect((await correct({ reason: " " })).status).toBe(400);
  world.state.tenancy.OptionsTotal = null;
  world.state.tenancy.OptionsRemaining = null;
  expect(body(await correct({ expectedRemaining: null }))).toMatchObject({ code: "no_options" });
  expect(world.state.ledger).toEqual([]);
});

it("is 409 when the count changed since the director saw it, and writes nothing", async () => {
  const res = await correct({ expectedRemaining: 2 });
  expect(res.status).toBe(409);
  expect(body(res)).toMatchObject({ code: "stale", current: 0 });
  expect(world.state.tenancy.OptionsRemaining).toBe(0);
});

it("is a director's: others refused at the gate; admin only on a test tenancy", async () => {
  expect((await correct({}, PEOPLE.bo)).status).toBe(403);
  caller = PEOPLE.ada;
  expect(body(await correct({}, PEOPLE.ada))).toMatchObject({ code: "admin_test_records_only" });
  world.state.tenancy.IsTest = true;
  expect((await correct({}, PEOPLE.ada)).status).toBe(200);
});
