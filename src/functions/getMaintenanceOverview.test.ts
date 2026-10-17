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
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "s@rp.com", name: "Simone", oid: "oid-s" }),
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


import { getMaintenanceOverview } from "./getMaintenanceOverview";
import { at, callsMatching, get, paramsOf, periodRow, routeQueries, scheduleRow } from "../__tests__/fixtures/facilitiesHarness";

const auth = require("../auth") as { extractToken: jest.Mock; requireRole: jest.Mock };
const db = require("../db") as { executeQuery: jest.Mock };
const context = new InvocationContext();

const SCHEDULES = /s\.Active = 1 AND \(@BuildingId IS NULL OR s\.BuildingId = @BuildingId\) AND s\.NextDue <= @Until/;
const HAS = /SELECT COUNT\(\*\) AS Total FROM dbo\.ServiceSchedules/;
const RUNS = /FROM dbo\.ServiceScheduleRuns r\s+JOIN dbo\.ServiceSchedules s/;
const LINKED = /FROM dbo\.JobAssets ja/;
const PERIODS = /FROM dbo\.DefectsPeriods d/;

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"], now: new Date("2026-10-14T01:00:00Z") });
  routeQueries(db.executeQuery, [
    { match: SCHEDULES, rows: [scheduleRow()] },
    { match: HAS, rows: [{ Total: 1 }] },
    { match: RUNS, rows: [{ CompletedAt: null, DueDate: at("2026-10-28"), JobArchived: false, JobId: 500, JobStatus: "New", JobTitle: "Chiller service", Outcome: "job_created", ServiceScheduleId: 21 }] },
    { match: LINKED, rows: [{ AssetId: 12, CompletionDate: at("2026-08-02"), JobID: 300, LastModifiedDate: at("2026-08-03"), Status: "Done", Title: "Chiller repair" }] },
    { match: PERIODS, rows: [periodRow()] },
  ]);
});

afterEach(() => jest.useRealTimers());

it("assembles the next 90 days for one building, with history and defects chips", async () => {
  const response = await getMaintenanceOverview(get({ buildingId: "1" }), context);
  expect(response.status).toBe(200);
  const overview = response.jsonBody as { buildings: Array<{ assets: Array<{ lastServiced: unknown; services: Array<{ status: string }> }>; defectsPeriods: unknown[] }>; hasSchedules: boolean; scheduledJobIds: number[]; until: string };
  expect(overview).toMatchObject({ hasSchedules: true, scheduledJobIds: [500], until: "2027-01-12" });
  expect(overview.buildings[0].assets[0].services[0].status).toBe("job_open");
  expect(overview.buildings[0].assets[0].lastServiced).toEqual({ date: "2026-08-02", jobId: 300 });
  expect(overview.buildings[0].defectsPeriods).toHaveLength(1);
  expect(paramsOf(callsMatching(db.executeQuery, SCHEDULES)[0])).toEqual({ BuildingId: 1, Until: "2027-01-12" });
  expect(paramsOf(callsMatching(db.executeQuery, RUNS)[0])).toEqual({ BuildingId: 1, Since: "2024-10-14" });
});

it("covers every building when none is chosen, and takes another window", async () => {
  await getMaintenanceOverview(get({ days: "30" }), context);
  expect(paramsOf(callsMatching(db.executeQuery, SCHEDULES)[0])).toEqual({ BuildingId: null, Until: "2026-11-13" });
});

it("400 for a bad building or window", async () => {
  expect((await getMaintenanceOverview(get({ buildingId: "x" }), context)).status).toBe(400);
  expect((await getMaintenanceOverview(get({ days: "0" }), context)).status).toBe(400);
  expect((await getMaintenanceOverview(get({ days: "400" }), context)).status).toBe(400);
});

it("401 without a token, 403 for the baseline user, before any read", async () => {
  auth.extractToken.mockReturnValueOnce(null);
  expect((await getMaintenanceOverview(get({}), context)).status).toBe(401);
  auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
  expect((await getMaintenanceOverview(get({}), context)).status).toBe(403);
  expect(db.executeQuery).not.toHaveBeenCalled();
});

it("500 when a read fails", async () => {
  routeQueries(db.executeQuery, [{ match: SCHEDULES, throws: new Error("timeout") }]);
  expect((await getMaintenanceOverview(get({}), context)).status).toBe(500);
});
