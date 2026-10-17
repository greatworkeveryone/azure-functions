/// <reference types="jest" />
// A0: Admin / Accounts decision jobs (plan D2). The kind is accepted on create
// and update and an unknown one is still refused. An admin job is stored in-house
// whoever raises it, keeps its kind, closes by the internal path with no quote,
// PO or invoice, and is left alone by the defects-liability check (sprint F).
// The DB layer is mocked.
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

import { addJobEvent, upsertJob } from "./jobs";
import { coveredOpenJobs, periodRowToApi } from "../defectsPeriods";
import { at, callsMatching, jobRow, paramsOf, periodRow, post, routeQueries, type Route } from "../__tests__/fixtures/facilitiesHarness";

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
const JOB_EVENT = /INSERT INTO JobEvents/;
const UPDATE_JOB = /UPDATE Jobs SET/;
const LIVE_PERIODS = /FROM dbo\.DefectsPeriods d[\s\S]*d\.PracticalCompletion <= @Today/;
const wroteAnything = (): boolean => (db.executeQuery.mock.calls as Array<[unknown, string]>).some(([, sql]) => /^\s*(INSERT|UPDATE|MERGE|DELETE)\b/i.test(sql));

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  auth.requireRole.mockResolvedValue(null);
  // Alana's role: plain facilities, not a manager.
  auth.rolesForRequest.mockResolvedValue(["facilities"]);
  auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "alana@example.com", name: "Alana", oid: "alana-oid" });
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  db.createRequestConnection.mockResolvedValue({ id: "connection" });
  limitsDb.getCachedApprovalLimits.mockResolvedValue([
    { MaxApprovalAmount: 5000, RoleName: "accounts" },
    { MaxApprovalAmount: null, RoleName: "director" },
  ]);
  routeQueries(db.executeQuery, [{ match: INSERT_JOB, rows: [{ JobID: 9 }] }]);
});

const newJob = (over: Record<string, unknown> = {}) => ({ BuildingID: 1, Kind: "admin", Status: "New", Title: "Superseded lighting invoice", ...over });
const create = (over: Record<string, unknown> = {}) => upsertJob(post(newJob(over)), ctx);
const insertParams = () => paramsOf(callsMatching(db.executeQuery, INSERT_JOB)[0]);

describe("upsertJob: creating an Admin / Accounts job", () => {
  it("succeeds for plain facilities, stored in-house with the admin kind", async () => {
    const response = await create();

    expect(response.status).toBe(200);
    expect(insertParams()).toMatchObject({ IsInternal: true, Kind: "admin" });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, false, true])("stores it in-house whatever the payload says (IsInternal: %s)", async (isInternal) => {
    const response = await create(isInternal === undefined ? {} : { IsInternal: isInternal });

    expect(response.status).toBe(200);
    expect(insertParams().IsInternal).toBe(true);
  });

  it("still gates the in-house flag on a facilities job, and the contract flag on any kind, behind a manager", async () => {
    for (const body of [{ IsInternal: true, Kind: "facilities" }, { IsContract: true, Kind: "admin" }, { IsContract: true, Kind: "facilities" }]) {
      expect(await create(body)).toMatchObject({ jsonBody: { code: "role_not_permitted" }, status: 403 });
    }
    expect(wroteAnything()).toBe(false);
  });

  it("is still accepted the old way for the other two kinds", async () => {
    for (const Kind of ["facilities", "maintenance"]) {
      db.executeQuery.mockClear();
      expect((await create({ Kind })).status).toBe(200);
      expect(insertParams()).toMatchObject({ Kind });
      expect(insertParams()).not.toHaveProperty("IsInternal");
    }
  });

  it.each(["plumbing", "Admin", "ADMIN", "admin ", "projects", ""])("refuses the unknown kind %j with 400 and writes nothing", async (Kind) => {
    const response = await create({ Kind });

    expect(response).toMatchObject({ jsonBody: { error: "Invalid Kind" }, status: 400 });
    expect(wroteAnything()).toBe(false);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("upsertJob: updating", () => {
  const PREVIOUS = /SELECT Status, AssignedTo, Kind, IsContract, IsInternal, Priority,[\s\S]*FROM Jobs WITH \(UPDLOCK, HOLDLOCK\) WHERE JobID = @JobID/;
  const UPDATED: Route = { match: UPDATE_JOB, rows: [{ JobID: 9 }] };
  const previous = (over: Record<string, unknown> = {}): Route => ({
    match: PREVIOUS,
    rows: [{ AssignedTo: null, HasMoneyRecords: 0, IsContract: false, IsInternal: true, Kind: "admin", Priority: "Normal", Status: "New", ...over }],
  });
  const update = (body: Record<string, unknown>) => upsertJob(post({ JobID: 9, ...body }), ctx);

  it("lets anyone who edits jobs update an Admin / Accounts job, with its kind and flag re-sent as they are", async () => {
    routeQueries(db.executeQuery, [previous(), UPDATED]);

    const response = await update({ IsInternal: true, Kind: "admin", Title: "Superseded lighting invoice (level 2)" });

    expect(response.status).toBe(200);
    expect(callsMatching(db.executeQuery, JOB_EVENT)).toHaveLength(0);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses to make another job an Admin / Accounts one, even for a manager, and changes nothing", async () => {
    auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
    routeQueries(db.executeQuery, [previous({ IsInternal: false, Kind: "facilities" }), UPDATED]);

    const response = await update({ Kind: "admin" });

    expect(response).toMatchObject({ jsonBody: { code: "kind_fixed" }, status: 422 });
    expect(callsMatching(db.executeQuery, UPDATE_JOB)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it.each(["facilities", "maintenance", null])("refuses to turn an Admin / Accounts job into kind %j", async (Kind) => {
    auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
    routeQueries(db.executeQuery, [previous(), UPDATED]);

    const response = await update({ Kind });

    expect(response).toMatchObject({ jsonBody: { code: "kind_fixed" }, status: 422 });
    expect(callsMatching(db.executeQuery, UPDATE_JOB)).toHaveLength(0);
  });

  it("refuses to switch its in-house flag off, even for a manager", async () => {
    auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
    routeQueries(db.executeQuery, [previous(), UPDATED]);

    const response = await update({ IsInternal: false });

    expect(response).toMatchObject({ jsonBody: { code: "admin_is_internal" }, status: 422 });
    expect(callsMatching(db.executeQuery, UPDATE_JOB)).toHaveLength(0);
  });

  it("still moves a facilities job to maintenance, recording the change", async () => {
    routeQueries(db.executeQuery, [previous({ IsInternal: false, Kind: "facilities" }), UPDATED, { match: JOB_EVENT, rows: [] }]);

    const response = await update({ Kind: "maintenance" });

    expect(response.status).toBe(200);
    expect(paramsOf(callsMatching(db.executeQuery, JOB_EVENT)[0])).toMatchObject({ EventType: "kind_change", Text: "Kind: facilities → maintenance" });
  });
});

describe("addJobEvent: closing an Admin / Accounts job", () => {
  const JOB_LOCK = /FROM Jobs j WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE j\.JobID = @JobID/;
  const GUARDED_UPDATE = /UPDATE Jobs SET [\s\S]*OUTPUT INSERTED\.JobID\s+WHERE JobID = @JobID AND Status = @ExpectedStatus/;
  const adminJob = (over: Record<string, unknown> = {}): Route => ({
    match: JOB_LOCK,
    rows: [{
      AwaitingRole: "facilities", BuildingID: 1, HasApprovedQuote: 0, HasMoneyRecords: 0, HasQuote: 0, IsContract: false, IsInternal: true,
      Kind: "admin", PreBlockAwaitingRole: null, PreBlockStatus: null, Status: "New", ...over,
    }],
  });
  const ACCEPTS: Route[] = [
    { match: /INSERT INTO JobEvents \(\s*JobID, CreatedBy, \[Text\], NewStatus/, rows: [{ JobEventID: 77 }] },
    { match: GUARDED_UPDATE, rows: [{ JobID: 9 }] },
  ];
  const close = () => addJobEvent(post({ JobID: 9, NewStatus: "Done", Text: "Answered; nothing more to do." }), ctx);

  it("goes straight to Done by the internal path, with no quote, PO or invoice, for plain facilities", async () => {
    routeQueries(db.executeQuery, [adminJob(), ...ACCEPTS]);

    const response = await close();

    expect(response.status).toBe(200);
    expect(paramsOf(callsMatching(db.executeQuery, GUARDED_UPDATE)[0])).toMatchObject({ ExpectedStatus: "New", Status: "Done" });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("could not without the in-house flag, which is why the kind stores it", async () => {
    routeQueries(db.executeQuery, [adminJob({ IsInternal: false }), ...ACCEPTS]);

    expect(await close()).toMatchObject({ jsonBody: { code: "illegal" }, status: 422 });
    expect(callsMatching(db.executeQuery, GUARDED_UPDATE)).toHaveLength(0);
  });
});

describe("defects liability (sprint F) leaves an Admin / Accounts job alone", () => {
  // A whole-building period for every service, running from long ago to long ahead.
  const covering: Route = { match: LIVE_PERIODS, rows: [periodRow({ EndsOn: at("2099-12-31"), PracticalCompletion: at("2000-01-01"), Services: "all" })] };

  it("checks no period and returns no warning for an admin job, where a facilities job in the same building is warned", async () => {
    routeQueries(db.executeQuery, [covering, { match: INSERT_JOB, rows: [{ JobID: 9 }] }]);

    const facilities = await create({ Kind: "facilities" });
    expect((facilities.jsonBody as { defectsWarnings?: unknown[] }).defectsWarnings).toHaveLength(1);
    expect(callsMatching(db.executeQuery, LIVE_PERIODS)).toHaveLength(1);

    db.executeQuery.mockClear();
    const admin = await create({ Kind: "admin" });
    expect(admin.status).toBe(200);
    expect(admin.jsonBody).not.toHaveProperty("defectsWarnings");
    expect(callsMatching(db.executeQuery, LIVE_PERIODS)).toHaveLength(0);
  });

  it("is not listed among the open jobs a defects period covers, where facilities and maintenance jobs are", async () => {
    routeQueries(db.executeQuery, [{
      match: /FROM dbo\.Jobs\s+WHERE BuildingID = @BuildingId/,
      rows: [
        jobRow({ JobID: 40, Kind: "maintenance" }),
        jobRow({ Category: null, JobID: 41, Kind: "admin" }),
        jobRow({ Category: null, JobID: 42, Kind: "facilities" }),
      ],
    }]);
    const period = periodRowToApi(periodRow({ EndsOn: at("2099-12-31"), PracticalCompletion: at("2000-01-01"), Services: "all" }), "2026-10-17");

    const covered = await coveredOpenJobs({} as never, period, "2026-10-17");

    expect(covered.map((job) => job.jobId)).toEqual([40, 42]);
  });
});

describe("getJobs: lists and filters", () => {
  it("returns an admin job beside the others, with its kind, and filters nothing by kind", async () => {
    routeQueries(db.executeQuery, [{ match: /SELECT[\s\S]*FROM Jobs\s+WHERE IsArchived = 0/, rows: [{ JobID: 1, Kind: "facilities" }, { JobID: 2, Kind: "admin" }] }]);

    const response = await getJobs(post({}), ctx);

    expect(response.status).toBe(200);
    expect((response.jsonBody as { jobs: Array<{ JobID: number; Kind: string }> }).jobs.map((job) => job.Kind)).toEqual(["facilities", "admin"]);
    const listSql = (db.executeQuery.mock.calls as Array<[unknown, string]>).map(([, sql]) => sql).find((sql) => /FROM Jobs\s+WHERE IsArchived = 0/.test(sql));
    expect(listSql).not.toMatch(/\bKind\s*(=|IN|<>)/i);
  });
});
