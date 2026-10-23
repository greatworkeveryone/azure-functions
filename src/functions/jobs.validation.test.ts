/// <reference types="jest" />
// upsertJob binds Bit / Int / DateTime2 / Decimal columns straight to SQL, where
// "false" became 1, 1.7 became 1, "1" became a date in 2001 and "1,500" became 1.
// Each class of field is checked by type before the DB is touched. DB mocked.
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn(),
    rolesForRequest: jest.fn(),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn(),
  };
});
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../jobPlannerSync", () => ({ syncJobActionTriggersStandalone: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../escalation/criticalJob", () => ({ raiseCriticalJobEscalation: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

import { upsertJob } from "./jobs";
import { callsMatching, paramsOf, post, routeQueries } from "../__tests__/fixtures/facilitiesHarness";

const auth = require("../auth") as { requireRole: jest.Mock; rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const limitsDb = require("../approval-limits-db") as { getCachedApprovalLimits: jest.Mock };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
const getJobs = (app.http.mock.calls.find((call: unknown[]) => call[0] === "getJobs")![1] as { handler: Handler }).handler;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;


const INSERT_JOB = /INSERT INTO Jobs/;
const UPDATE_JOB = /UPDATE Jobs SET/;
const wroteAnything = (): boolean => (db.executeQuery.mock.calls as Array<[unknown, string]>).some(([, sql]) => /^\s*(INSERT|UPDATE|MERGE|DELETE)\b/i.test(sql));

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  auth.requireRole.mockResolvedValue(null);
  auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
  auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "alana@example.com", name: "Alana", oid: "alana-oid" });
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  db.createRequestConnection.mockResolvedValue({ id: "connection" });
  limitsDb.getCachedApprovalLimits.mockResolvedValue([{ MaxApprovalAmount: null, RoleName: "director" }]);
  routeQueries(db.executeQuery, [{ match: INSERT_JOB, rows: [{ JobID: 9 }] }]);
});

const newJob = (over: Record<string, unknown> = {}) => ({ BuildingID: 1, Kind: "facilities", Status: "New", Title: "Leaking tap", ...over });
const create = (over: Record<string, unknown> = {}) => upsertJob(post(newJob(over)), ctx);
const insertParams = () => paramsOf(callsMatching(db.executeQuery, INSERT_JOB)[0]);

describe("upsertJob: field types", () => {
  it.each([
    ["IsStalled", "false"],
    ["IsStalled", 1],
    ["IsInternal", "true"],
    ["IsOnchargeable", "false"],
    ["IsOnchargeable", 0],
    ["IsContract", "yes"],
  ])("refuses %s = %j (not a boolean), naming the field, and writes nothing", async (field, value) => {
    const response = await create({ [field]: value });

    expect(response.status).toBe(400);
    expect((response.jsonBody as { error: string }).error).toContain(field);
    expect(wroteAnything()).toBe(false);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([
    ["BuildingID", "12"],
    ["BuildingID", 1.7],
    ["TenantID", "3"],
    ["WorkRequestID", 2.5],
    ["AssignedToUserID", "7"],
    ["SourceEmailID", 0.1],
  ])("refuses %s = %j (not a whole number)", async (field, value) => {
    const response = await create({ [field]: value });

    expect(response.status).toBe(400);
    expect((response.jsonBody as { error: string }).error).toContain(field);
    expect(wroteAnything()).toBe(false);
  });

  it.each([
    ["ExpectedProgressUpdate", "1"],
    ["ExpectedProgressUpdate", "next week"],
    ["ExpectedProgressUpdate", 20260101],
    ["CompletionDate", "2026-02-31"],
    ["CompletionDate", "2026-13-01"],
    ["CompletionDate", "01/02/2026"],
    ["CompletionDate", "2026-10-23T25:00:00Z"],
  ])("refuses %s = %j (not an ISO date)", async (field, value) => {
    const response = await create({ [field]: value });

    expect(response.status).toBe(400);
    expect((response.jsonBody as { error: string }).error).toContain(field);
    expect(wroteAnything()).toBe(false);
  });

  it("accepts real booleans, whole numbers and ISO dates, and binds them as sent", async () => {
    const response = await create({
      CompletionDate: "2026-10-23T09:30:00Z",
      ExpectedProgressUpdate: "2026-10-30",
      IsStalled: false,
      IsOnchargeable: true,
      OnchargeAmount: 10,
      TenantID: 3,
    });

    expect(response.status).toBe(200);
    expect(insertParams()).toMatchObject({
      CompletionDate: "2026-10-23T09:30:00Z",
      ExpectedProgressUpdate: "2026-10-30",
      IsOnchargeable: true,
      IsStalled: false,
      TenantID: 3,
    });
  });

  it("still lets a column be cleared with null", async () => {
    const response = await create({ CompletionDate: null, IsStalled: null, TenantID: null });

    expect(response.status).toBe(200);
  });
});

describe("upsertJob: OnchargeAmount", () => {
  it.each(["12abc", "-5", -5, "1.234", 1.234, true, 10_000_001])("refuses %j", async (value) => {
    const response = await create({ IsOnchargeable: true, OnchargeAmount: value });

    expect(response.status).toBe(400);
    expect((response.jsonBody as { error: string }).error).toMatch(/OnchargeAmount/);
    expect(wroteAnything()).toBe(false);
  });

  it("stores \"1,500.50\" as 1500.5, not 1", async () => {
    const response = await create({ IsOnchargeable: true, OnchargeAmount: "1,500.50" });

    expect(response.status).toBe(200);
    expect(insertParams().OnchargeAmount).toBe(1500.5);
  });

  it("validates on update too, before the job is read", async () => {
    routeQueries(db.executeQuery, [{ match: UPDATE_JOB, rows: [{ JobID: 9 }] }]);

    const response = await upsertJob(post({ JobID: 9, IsStalled: "false" }), ctx);

    expect(response.status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});
