/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

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
  };
});

jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return {
    ...actual,
    closeConnection: jest.fn(),
    createRequestConnection: jest.fn().mockResolvedValue({}),
    executeQuery: jest.fn().mockResolvedValue([]),
  };
});

jest.mock("../approvalAuthority-db", () => ({ loadApprovalFacts: jest.fn() }));

import { getRecurringFaults, type RecurringFaultsResponse } from "./getRecurringFaults";
import { callsMatching, paramsOf, routeQueries, type Row } from "../__tests__/fixtures/facilitiesHarness";

const auth = require("../auth") as { extractToken: jest.Mock; requireRole: jest.Mock; rolesForRequest: jest.Mock };
const db = require("../db") as { closeConnection: jest.Mock; createRequestConnection: jest.Mock; executeQuery: jest.Mock };
const approvalDb = require("../approvalAuthority-db") as { loadApprovalFacts: jest.Mock };
const context = new InvocationContext();

const JOBS = /FROM dbo\.Jobs j\s+LEFT JOIN dbo\.Buildings b/;
const INVOICES = /FROM dbo\.JobInvoices i/;

const request = (query: Record<string, string> = {}, headers: Record<string, string> = {}): HttpRequest =>
  ({ headers: new Headers(headers), json: async () => ({}), query: new URLSearchParams(query) }) as unknown as HttpRequest;

let nextId = 0;
/** A job as the read returns it: one row, no asset, a reactive air-conditioning job on Level 2. */
function jobRow(overrides: Row = {}): Row {
  nextId += 1;
  return {
    AssetArchivedAt: null,
    AssetId: null,
    AssetName: null,
    AssetTag: null,
    BuildingID: 1,
    BuildingName: "30 Daly St",
    Category: "HVAC / mechanical",
    // A day apart from 11/09/2026, so a job's number is also its age order.
    CreatedAt: new Date(Date.UTC(2026, 8, 10, 2) + nextId * 86_400_000),
    JobID: nextId,
    Kind: "facilities",
    LevelName: "Level 2",
    LocationName: null,
    ParentLocationName: null,
    Status: "Work",
    Title: `Air conditioning fault ${nextId}`,
    Type: null,
    ...overrides,
  };
}
const rows = (count: number, overrides: Row = {}): Row[] => Array.from({ length: count }, () => jobRow(overrides));

const FACTS = { directorThreshold: 5000, isResidence: false, limits: [], residenceApprovers: [], residenceDirectorFallback: true, today: "2026-10-23" };

function serve(jobs: Row[], invoices: Row[] = []): void {
  routeQueries(db.executeQuery, [
    { match: JOBS, rows: jobs },
    { match: INVOICES, rows: invoices },
  ]);
}

const call = async (query: Record<string, string> = {}, headers: Record<string, string> = {}) => {
  const response = await getRecurringFaults(request(query, headers), context);
  return { body: response.jsonBody as RecurringFaultsResponse, response };
};

beforeEach(() => {
  jest.clearAllMocks();
  nextId = 0;
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
  approvalDb.loadApprovalFacts.mockResolvedValue(FACTS);
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"], now: new Date("2026-10-23T01:00:00Z") });
  serve([]);
});

afterEach(() => jest.useRealTimers());

describe("who may ask", () => {
  it("401 without a token, 403 for a role outside the Maintenance gate, before any read", async () => {
    auth.extractToken.mockReturnValueOnce(null);
    expect((await call()).response.status).toBe(401);
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await call()).response.status).toBe(403);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("uses the gate of viewMaintenanceOverview: whoever sees Maintenance and jobs", async () => {
    await call();
    const [allowed] = auth.requireRole.mock.calls[0].slice(1);
    expect([...allowed].sort()).toEqual(["accounts", "accounts_manager", "admin", "director", "facilities", "facilities_manager"]);
  });
});

describe("what may be asked", () => {
  it.each([["buildingId", "x"], ["buildingId", "0"], ["buildingId", "99999999999"], ["buildingId", "1.5"], ["assetId", "0"], ["assetId", "-4"], ["assetId", "abc"], ["assetId", "99999999999"]])(
    "400 for %s=%s, before any read",
    async (name, value) => {
      const { response } = await call({ [name]: value });
      expect(response.status).toBe(400);
      expect(db.createRequestConnection).not.toHaveBeenCalled();
    },
  );

  it("takes a building (a manual building's id is negative) and an asset, as parameters", async () => {
    await call({ assetId: "12", buildingId: "-3" });
    const params = paramsOf(callsMatching(db.executeQuery, JOBS)[0]);
    expect(params).toMatchObject({ AssetId: 12, BuildingId: -3 });
  });

  it("covers every building and asset when neither is given", async () => {
    await call();
    expect(paramsOf(callsMatching(db.executeQuery, JOBS)[0])).toMatchObject({ AssetId: null, BuildingId: null });
  });
});

describe("what is read", () => {
  it("leaves out archived, scheduler-made, other-kind and test jobs, and anything before the window", async () => {
    await call();
    const [, sql] = callsMatching(db.executeQuery, JOBS)[0];
    expect(sql).toMatch(/j\.IsArchived = 0/);
    expect(sql).toMatch(/\(j\.IsTest = 0 OR @ShowTest = 1\)/);
    expect(sql).toMatch(/j\.Kind IN \(@Kind0, @Kind1\)/);
    expect(sql).toMatch(/j\.CreationMethod <> @ScheduledMethod/);
    expect(sql).toMatch(/j\.CreatedAt >= @Since/);
    expect(sql).toMatch(/ja\.UnlinkedAt IS NULL/);
    expect(sql).not.toMatch(/SELECT \*/);
  });

  it("counts the contractor-flow kinds by name, so an Admin / Accounts job is never a fault", async () => {
    await call();
    expect(paramsOf(callsMatching(db.executeQuery, JOBS)[0])).toMatchObject({ Kind0: "facilities", Kind1: "maintenance", ScheduledMethod: "schedule" });
  });

  it("opens the window at the start of the Darwin day 365 days ago", async () => {
    await call();
    expect((paramsOf(callsMatching(db.executeQuery, JOBS)[0]).Since as Date).toISOString()).toBe("2025-10-22T14:30:00.000Z");
    // 14:30 UTC is midnight in Darwin: a minute later it is the next Darwin day.
    jest.setSystemTime(new Date("2026-10-23T14:31:00Z"));
    db.executeQuery.mockClear();
    await call();
    expect((paramsOf(callsMatching(db.executeQuery, JOBS)[0]).Since as Date).toISOString()).toBe("2025-10-23T14:30:00.000Z");
  });

  it("keeps test jobs out unless an admin has Show test data on", async () => {
    await call();
    expect(paramsOf(callsMatching(db.executeQuery, JOBS)[0]).ShowTest).toBe(false);

    db.executeQuery.mockClear();
    auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
    await call({}, { "x-show-test-data": "1" });
    expect(paramsOf(callsMatching(db.executeQuery, JOBS)[0]).ShowTest).toBe(false);

    db.executeQuery.mockClear();
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    await call({}, { "x-show-test-data": "1" });
    expect(paramsOf(callsMatching(db.executeQuery, JOBS)[0]).ShowTest).toBe(true);
  });
});

describe("the signals", () => {
  it("is an empty list, and no invoice read, when no group reaches three jobs", async () => {
    serve([...rows(2), ...rows(2, { Category: "Electrical" })]);
    const { body, response } = await call();
    expect(response.status).toBe(200);
    expect(body).toEqual({ generatedOn: "2026-10-23", minJobs: 3, signals: [], truncated: false, windowDays: 365 });
    expect(callsMatching(db.executeQuery, INVOICES)).toHaveLength(0);
    expect(approvalDb.loadApprovalFacts).not.toHaveBeenCalled();
  });

  it("is an empty list when there are no jobs at all", async () => {
    const { body } = await call();
    expect(body.signals).toEqual([]);
  });

  it("makes a signal of three jobs on one level and trade, with the jobs and the open count", async () => {
    serve(rows(3));
    const { body } = await call();
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0]).toMatchObject({
      basis: "location",
      buildingName: "30 Daly St",
      firstOn: "2026-09-11",
      jobCount: 3,
      label: "30 Daly St · Level 2 · HVAC / mechanical",
      lastOn: "2026-09-13",
      openCount: 3,
      spendExGst: 0,
    });
    expect(body.signals[0].jobs.map((job) => job.id)).toEqual([3, 2, 1]);
    expect(body.signals[0].jobs[0]).toEqual({ createdOn: "2026-09-13", id: 3, status: "Work", title: "Air conditioning fault 3" });
  });

  it("groups by asset when jobs are linked to one, with its tag and where it is", async () => {
    const asset = { AssetId: 12, AssetName: "Chiller 1", AssetTag: "CH-01", LocationName: "Plant room", ParentLocationName: "Level 2" };
    serve([jobRow({ ...asset, Status: "Done" }), jobRow({ ...asset, Category: "Electrical", LevelName: null }), jobRow({ ...asset, Kind: "maintenance" })]);
    const { body } = await call();
    expect(body.signals).toHaveLength(1);
    expect(body.signals[0]).toMatchObject({ assetId: 12, basis: "asset", label: "Chiller 1 (CH-01)", locationName: "Level 2 › Plant room", openCount: 2 });
  });

  it("counts a job with two assets for both, and ignores a job linked only to an archived asset", async () => {
    const chiller = { AssetId: 12, AssetName: "Chiller 1" };
    const lift = { AssetId: 13, AssetName: "Lift 1" };
    const shared = jobRow({ ...chiller });
    serve([
      shared,
      { ...shared, ...lift },
      ...rows(2, chiller),
      ...rows(2, lift),
      ...rows(3, { ...chiller, AssetArchivedAt: new Date("2026-08-01T00:00:00Z"), AssetId: 99, AssetName: "Old unit" }),
    ]);
    const { body } = await call();
    expect(body.signals.map((signal) => [signal.label, signal.jobCount]).sort()).toEqual([["Chiller 1", 3], ["Lift 1", 3]]);
  });

  it("reads the invoices of the jobs in a signal only, as a JSON list, and puts spend ex GST on it", async () => {
    serve(rows(3), [
      { Amount: 1100, JobID: 1, Status: "director_approved" },
      { Amount: 2200, JobID: 2, Status: "approved" },
      { Amount: 550, JobID: 3, Status: "approved" },
    ]);
    const { body } = await call();
    const invoiceCall = callsMatching(db.executeQuery, INVOICES)[0];
    expect(JSON.parse(String(paramsOf(invoiceCall).JobIds))).toEqual([3, 2, 1]);
    expect(invoiceCall[1]).toMatch(/i\.Direction = N'incoming'/);
    expect(invoiceCall[1]).toMatch(/i\.Status IN \(N'approved', N'director_approved'\)/);
    expect(invoiceCall[1]).toMatch(/\(i\.IsTest = 0 OR @ShowTest = 1\)/);
    expect(paramsOf(invoiceCall).ShowTest).toBe(false);
    // 1100 + 2200 + 550 = 3850 inc GST = 3500 ex GST.
    expect(body.signals[0].spendExGst).toBe(3500);
  });

  it("does not count a stage-1 approval that is still waiting on a director", async () => {
    serve(rows(3), [
      { Amount: 4400, JobID: 1, Status: "approved" },
      { Amount: 9900, JobID: 2, Status: "approved" },
      { Amount: 11000, JobID: 3, Status: "director_approved" },
    ]);
    const { body } = await call();
    // The threshold is 5000: 9900 waits on a director. 4400 + 11000 = 15400 inc GST = 14000 ex GST.
    expect(body.signals[0].spendExGst).toBe(14000);
    expect(approvalDb.loadApprovalFacts).toHaveBeenCalledTimes(1);
  });

  it("loads the approval limits only when a stage-1 invoice needs them", async () => {
    serve(rows(3), [{ Amount: 1100, JobID: 1, Status: "director_approved" }]);
    await call();
    expect(approvalDb.loadApprovalFacts).not.toHaveBeenCalled();
  });

  it("lists the most jobs first", async () => {
    serve([...rows(3, { Category: "Electrical" }), ...rows(5, { Category: "Cleaning" })]);
    const { body } = await call();
    expect(body.signals.map((signal) => signal.jobCount)).toEqual([5, 3]);
  });

  it("says when the read hit its ceiling, so the oldest jobs may be missing", async () => {
    serve(Array.from({ length: 5000 }, (_, index) => jobRow({ BuildingID: index + 1 })));
    const { body } = await call();
    expect(body.truncated).toBe(true);
  });
});

describe("when the read fails", () => {
  it("500, closes the connection, and says nothing about the cause", async () => {
    routeQueries(db.executeQuery, [{ match: JOBS, throws: new Error("timeout") }]);
    const { response } = await call();
    expect(response.status).toBe(500);
    expect(response.jsonBody).toEqual({ error: "Error" });
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });

  it("500 when the invoice read fails, and when the connection cannot be made", async () => {
    routeQueries(db.executeQuery, [{ match: JOBS, rows: rows(3) }, { match: INVOICES, throws: new Error("timeout") }]);
    expect((await call()).response.status).toBe(500);
    db.createRequestConnection.mockRejectedValueOnce(new Error("no connection"));
    expect((await call()).response.status).toBe(500);
  });
});
