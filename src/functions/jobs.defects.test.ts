/// <reference types="jest" />
import { InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Error" }, status: 500 }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    rolesForRequest: jest.fn().mockResolvedValue(["facilities_manager"]),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "a@rp.com", name: "Adam", oid: "oid-a" }),
  };
});
jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return {
    ...actual,
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    closeConnection: jest.fn(),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    createRequestConnection: jest.fn().mockResolvedValue({}),
    executeQuery: jest.fn().mockResolvedValue([]),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
  };
});
jest.mock("../escalation/criticalJob", () => ({ raiseCriticalJobEscalation: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../jobPlannerSync", () => ({ syncJobActionTriggersStandalone: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../pdf/job-packet", () => ({ buildJobPacket: jest.fn() }));
jest.mock("../pdf/job-packet-loader", () => ({ loadJobPacketInputs: jest.fn() }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn() }));

import { upsertJob } from "./jobs";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";
import { callsMatching, paramsOf, periodRow, post, routeQueries } from "../__tests__/fixtures/facilitiesHarness";

const auth = require("../auth") as { requireRole: jest.Mock };
const db = require("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock; executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const order = (mock: jest.Mock, index = 0): number => mock.mock.invocationCallOrder[index];
const context = new InvocationContext();
const LIVE = /FROM dbo\.DefectsPeriods d[\s\S]*d\.PracticalCompletion <= @Today/;
const INSERT_JOB = /INSERT INTO Jobs/;
const JOB_EVENT = /INSERT INTO JobEvents/;

const newJob = (overrides: Record<string, unknown> = {}) => ({
  BuildingID: 1,
  Category: "HVAC / mechanical",
  Kind: "maintenance",
  Status: "New",
  Title: "Chiller service",
  ...overrides,
});

beforeEach(() => {
  jest.clearAllMocks();
  auth.requireRole.mockResolvedValue(null);
  routeQueries(db.executeQuery, [
    { match: LIVE, rows: [periodRow()] },
    { match: INSERT_JOB, rows: [{ JobID: 88 }] },
    { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 4 }] },
    { match: /FROM Jobs WHERE JobID = @JobID/, rows: [{ JobID: 88, Title: "Chiller service" }] },
  ]);
});

it("refuses new planned maintenance inside a defects period with a 409 and creates nothing", async () => {
  const response = await upsertJob(post(newJob()), context);
  expect(response.status).toBe(409);
  expect((response.jsonBody as { code: string }).code).toBe("defects_period");
  expect(callsMatching(db.executeQuery, INSERT_JOB)).toHaveLength(0);
});

it("lets a manager book anyway with a reason: job, override event and ledger exception commit together", async () => {
  const response = await upsertJob(post(newJob({ DefectsOverrideReason: "Builder in liquidation" })), context);
  expect(response.status).toBe(200);
  expect(callsMatching(db.executeQuery, INSERT_JOB)).toHaveLength(1);
  expect(paramsOf(callsMatching(db.executeQuery, INSERT_JOB)[0])).not.toHaveProperty("DefectsOverrideReason");
  expect(paramsOf(callsMatching(db.executeQuery, JOB_EVENT)[0])).toMatchObject({ EventType: "defects_override", JobID: 88 });
  expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "job.defects_override", jobId: 88 });
  expect(db.commitTransaction).toHaveBeenCalledTimes(1);
});

it("puts the job, the override event and the ledger row inside one transaction, in that order", async () => {
  await upsertJob(post(newJob({ DefectsOverrideReason: "Builder in liquidation" })), context);
  const calls = db.executeQuery.mock.calls as Array<[unknown, string]>;
  const at = (match: RegExp): number => db.executeQuery.mock.invocationCallOrder[calls.findIndex(([, sql]) => match.test(sql))];
  const begin = order(db.beginTransaction);
  const commit = order(db.commitTransaction);
  const insertJob = at(INSERT_JOB);
  const event = at(JOB_EVENT);
  const ledger = ledgerInserts(db.executeQuery)[0].order;
  expect(begin).toBeLessThan(insertJob);
  expect(insertJob).toBeLessThan(event);
  expect(event).toBeLessThan(ledger);
  expect(ledger).toBeLessThan(commit);
});

it("rolls the job back when the ledger row can't be written: no ledger row, no job", async () => {
  routeQueries(db.executeQuery, [
    { match: LIVE, rows: [periodRow()] },
    { match: INSERT_JOB, rows: [{ JobID: 88 }] },
    { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 4 }] },
    { match: /INSERT INTO dbo\.DecisionLedger/, throws: new Error("ledger unavailable") },
  ]);
  const response = await upsertJob(post(newJob({ DefectsOverrideReason: "Builder in liquidation" })), context);
  expect(response.status).toBe(500);
  expect(db.rollbackTransaction).toHaveBeenCalled();
  expect(db.commitTransaction).not.toHaveBeenCalled();
});

it("creates a covered reactive job and returns the period as a warning", async () => {
  const response = await upsertJob(post(newJob({ Category: "Common Areas", Kind: "facilities", Type: "Air Conditioning" })), context);
  expect(response.status).toBe(200);
  const body = response.jsonBody as { defectsWarnings: Array<{ defectsPeriodId: number }> };
  expect(body.defectsWarnings.map((p) => p.defectsPeriodId)).toEqual([3]);
});

it("does not consult defects periods when editing an existing job", async () => {
  routeQueries(db.executeQuery, [{ match: /UPDATE Jobs SET/, rows: [{ JobID: 88 }] }]);
  await upsertJob(post({ JobID: 88, Title: "Renamed" }), context);
  expect(callsMatching(db.executeQuery, LIVE)).toHaveLength(0);
});
