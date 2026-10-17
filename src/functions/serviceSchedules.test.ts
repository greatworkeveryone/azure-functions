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

jest.mock("../facilitiesScheduler", () => ({ ...jest.requireActual("../facilitiesScheduler"), runFacilitiesScheduler: jest.fn() }));

import { archiveServiceSchedule } from "./archiveServiceSchedule";
import { getServiceSchedule } from "./getServiceSchedule";
import { getServiceSchedules } from "./getServiceSchedules";
import { runSchedulerNow } from "./runSchedulerNow";
import { upsertServiceSchedule } from "./upsertServiceSchedule";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";
import {
  ROW_VERSION,
  at,
  callsMatching,
  errorOf,
  get,
  paramsOf,
  post,
  routeQueries,
  scheduleRow,
  type Route,
} from "../__tests__/fixtures/facilitiesHarness";

const auth = require("../auth") as { extractToken: jest.Mock; requireRole: jest.Mock };
const db = require("../db") as { commitTransaction: jest.Mock; executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const scheduler = require("../facilitiesScheduler") as { runFacilitiesScheduler: jest.Mock };
const context = new InvocationContext();

const BY_ID = /FROM dbo\.ServiceSchedules s(?: WITH \(UPDLOCK, ROWLOCK\))?\s+LEFT JOIN[\s\S]*WHERE s\.ServiceScheduleId = @Id/;
const LIST = /\(@BuildingId IS NULL OR s\.BuildingId = @BuildingId\)/;
const RUNS = /FROM dbo\.ServiceScheduleRuns r\s+LEFT JOIN dbo\.Jobs j/;
const BUILDING = /SELECT BuildingID FROM dbo\.Buildings WHERE BuildingID = @BuildingId/;
const ASSET = /SELECT AssetId, BuildingId, ArchivedAt FROM dbo\.Assets WHERE AssetId = @AssetId/;
const LOCATION = /SELECT LocationId, BuildingId FROM dbo\.Locations WHERE LocationId = @LocationId/;
const CONTRACTOR = /FROM dbo\.Contractors WHERE ContractorID = @ContractorId/;
const INSERT = /INSERT INTO dbo\.ServiceSchedules/;
const UPDATE = /UPDATE dbo\.ServiceSchedules/;

const body = (overrides: Record<string, unknown> = {}) => ({
  anchorDate: "2026-04-28",
  assetId: 12,
  buildingId: 1,
  category: "HVAC / mechanical",
  contractorId: 5,
  intervalCount: 6,
  intervalUnit: "months",
  isContract: true,
  name: "Six-monthly chiller service",
  ...overrides,
});

function routes(extra: Route[] = []): Route[] {
  return [
    ...extra,
    { match: BUILDING, rows: [{ BuildingID: 1 }] },
    { match: ASSET, rows: [{ ArchivedAt: null, AssetId: 12, BuildingId: 1 }] },
    { match: LOCATION, rows: [{ BuildingId: 1, LocationId: 30 }] },
    { match: CONTRACTOR, rows: [{ ContractorID: 5 }] },
    { match: INSERT, rows: [{ ServiceScheduleId: 21 }] },
    { match: BY_ID, rows: [scheduleRow()] },
    { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 9 }] },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  routeQueries(db.executeQuery, routes());
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"], now: new Date("2026-10-14T01:00:00Z") });
});

afterEach(() => jest.useRealTimers());

describe("getServiceSchedules", () => {
  it("filters by building, asset, category and due window, and marks overdue", async () => {
    routeQueries(db.executeQuery, [{ match: LIST, rows: [scheduleRow({ NextDue: at("2026-10-01") }), scheduleRow({ ServiceScheduleId: 22 })] }]);
    const response = await getServiceSchedules(get({ assetId: "12", buildingId: "1", category: "Lifts", dueBefore: "2026-12-31" }), context);
    expect(response.status).toBe(200);
    const { schedules } = response.jsonBody as { schedules: Array<Record<string, unknown>> };
    expect(schedules[0]).toMatchObject({ generatesOn: "2026-09-17", nextDue: "2026-10-01", overdue: true, urgent: false });
    expect(schedules[1]).toMatchObject({ assetName: "Chiller 1", nextDue: "2026-10-28", overdue: false });
    expect(paramsOf(callsMatching(db.executeQuery, LIST)[0])).toEqual({ AssetId: 12, BuildingId: 1, Category: "Lifts", DueBefore: "2026-12-31", IncludeArchived: false });
  });

  it("400 for bad filters; 401 / 403 before touching the database", async () => {
    expect((await getServiceSchedules(get({ buildingId: "x" }), context)).status).toBe(400);
    expect((await getServiceSchedules(get({ dueBefore: "31/12/2026" }), context)).status).toBe(400);
    auth.extractToken.mockReturnValueOnce(null);
    expect((await getServiceSchedules(get({}), context)).status).toBe(401);
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await getServiceSchedules(get({}), context)).status).toBe(403);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("500 when the database fails", async () => {
    routeQueries(db.executeQuery, [{ match: LIST, throws: new Error("timeout") }]);
    expect((await getServiceSchedules(get({}), context)).status).toBe(500);
  });
});

describe("getServiceSchedule", () => {
  it("returns the schedule with its history of runs", async () => {
    routeQueries(db.executeQuery, routes([{ match: RUNS, rows: [{ CompletedAt: at("2026-04-30"), DueDate: at("2026-04-28"), JobId: 400, JobStatus: "Done", JobTitle: "Chiller service", Outcome: "job_created", ServiceScheduleId: 21 }] }]));
    const response = await getServiceSchedule(get({ id: "21" }), context);
    const result = response.jsonBody as { runs: Array<Record<string, unknown>>; schedule: { serviceScheduleId: number } };
    expect(result.schedule.serviceScheduleId).toBe(21);
    expect(result.runs[0]).toMatchObject({ dueDate: "2026-04-28", jobId: 400, jobStatus: "Done", outcome: "job_created" });
  });

  it("404 for an unknown schedule", async () => {
    routeQueries(db.executeQuery, [{ match: BY_ID, rows: [] }]);
    expect((await getServiceSchedule(get({ id: "99" }), context)).status).toBe(404);
  });
});

describe("upsertServiceSchedule", () => {
  it("creates a schedule due on the first anchor date from today, and ledgers it", async () => {
    const response = await upsertServiceSchedule(post(body()), context);
    expect(response.status).toBe(200);
    expect((response.jsonBody as { created: boolean }).created).toBe(true);
    expect(paramsOf(callsMatching(db.executeQuery, INSERT)[0])).toMatchObject({
      AnchorDate: "2026-04-28",
      AssetId: 12,
      CreatedBy: "Simone",
      IntervalCount: 6,
      IntervalUnit: "months",
      IsContract: true,
      LeadDays: 14,
      NextDue: "2026-10-28",
    });
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "service_schedule.create", subjectId: "21", subjectType: "service_schedule" });
  });

  it("accepts a first due date only when it is one of the schedule's dates", async () => {
    expect((await upsertServiceSchedule(post(body({ nextDue: "2026-04-28" })), context)).status).toBe(200);
    expect(paramsOf(callsMatching(db.executeQuery, INSERT)[0]).NextDue).toBe("2026-04-28");
    const off = await upsertServiceSchedule(post(body({ nextDue: "2026-05-01" })), context);
    expect(off.status).toBe(400);
    expect(errorOf(off)).toMatch(/every 6 months from 28\/04\/2026/);
  });

  it.each([
    [{ name: "" }, /name is required/],
    [{ category: "Plumbing" }, /maintenance categories/],
    [{ assetId: null }, /Choose the asset/],
    [{ intervalUnit: "days" }, /weeks or months/],
    [{ intervalCount: 0 }, /intervalCount/],
    [{ anchorDate: "28/04/2026" }, /anchorDate/],
    [{ leadDays: 400 }, /leadDays/],
    [{ isContract: "yes" }, /isContract/],
    [{ serviceScheduleId: 21 }, /rowVersion/],
  ])("400 for %j", async (overrides, message) => {
    const response = await upsertServiceSchedule(post(body(overrides)), context);
    expect(response.status).toBe(400);
    expect(errorOf(response)).toMatch(message);
  });

  it("refuses an asset from another building or an archived one", async () => {
    routeQueries(db.executeQuery, routes([{ match: ASSET, rows: [{ ArchivedAt: null, AssetId: 12, BuildingId: 2 }] }]));
    expect((await upsertServiceSchedule(post(body()), context)).status).toBe(400);
    routeQueries(db.executeQuery, routes([{ match: ASSET, rows: [{ ArchivedAt: at("2026-10-01"), AssetId: 12, BuildingId: 1 }] }]));
    expect(errorOf(await upsertServiceSchedule(post(body()), context))).toMatch(/archived/);
  });

  it("edits with the row version; a new anchor or interval recomputes the next due without skipping an overdue one", async () => {
    routeQueries(db.executeQuery, routes([
      { match: BY_ID, rows: [scheduleRow({ NextDue: at("2026-10-01") })] },
      { match: UPDATE, rows: [{ ServiceScheduleId: 21 }] },
    ]));
    const response = await upsertServiceSchedule(
      post(body({ anchorDate: "2026-01-15", intervalCount: 3, rowVersion: ROW_VERSION.toString("base64"), serviceScheduleId: 21 })),
      context,
    );
    expect(response.status).toBe(200);
    const update = callsMatching(db.executeQuery, UPDATE)[0];
    expect(update[1]).toMatch(/WHERE ServiceScheduleId = @Id AND RowVersion = @RowVersion/);
    // Was due 01/10 (overdue): the first quarterly date from 15/01 on or after it is 15/10.
    expect(paramsOf(update)).toMatchObject({ AnchorDate: "2026-01-15", IntervalCount: 3, NextDue: "2026-10-15" });
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "service_schedule.update" });
  });

  it("409 naming who changed it since it was read", async () => {
    const stale = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]).toString("base64");
    const response = await upsertServiceSchedule(post(body({ rowVersion: stale, serviceScheduleId: 21 })), context);
    expect(response.status).toBe(409);
    expect(errorOf(response)).toMatch(/Adam changed this schedule/);
  });

  it("403 for someone who may not manage schedules", async () => {
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await upsertServiceSchedule(post(body()), context)).status).toBe(403);
  });

  it("rolls back on a failed insert", async () => {
    routeQueries(db.executeQuery, routes([{ match: INSERT, throws: new Error("deadlock") }]));
    expect((await upsertServiceSchedule(post(body()), context)).status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });
});

describe("archiveServiceSchedule", () => {
  it("archives (never deletes) with a reason, and restores", async () => {
    const response = await archiveServiceSchedule(post({ reason: "Chiller replaced", serviceScheduleId: 21 }), context);
    expect(response.status).toBe(200);
    expect(callsMatching(db.executeQuery, UPDATE)[0][1]).toMatch(/SET ArchivedAt = SYSUTCDATETIME\(\), ArchivedBy = @Caller/);
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "service_schedule.archive", reason: "Chiller replaced" });
    expect(callsMatching(db.executeQuery, /DELETE/)).toHaveLength(0);
  });

  it("400 without an id, 404 for an unknown one", async () => {
    expect((await archiveServiceSchedule(post({}), context)).status).toBe(400);
    routeQueries(db.executeQuery, [{ match: BY_ID, rows: [] }]);
    expect((await archiveServiceSchedule(post({ serviceScheduleId: 5 }), context)).status).toBe(404);
  });
});

describe("runSchedulerNow", () => {
  const report = { actions: 0, defects: {}, errors: [], overdue: {}, schedules: { created: 0 }, truncated: false };

  it("runs as a dry run unless told otherwise, and returns the report and log", async () => {
    scheduler.runFacilitiesScheduler.mockImplementation(async (_c: unknown, options: { log: (m: string) => void }) => {
      options.log("schedulerTimer (dry run): would create the job for schedule 21");
      return report;
    });
    const response = await runSchedulerNow(post({}), context);
    expect(response.status).toBe(200);
    expect(scheduler.runFacilitiesScheduler).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dryRun: true }));
    expect((response.jsonBody as { log: string[] }).log).toEqual(["schedulerTimer (dry run): would create the job for schedule 21"]);
  });

  it("refuses a live run while the scheduler is switched off", async () => {
    const response = await runSchedulerNow(post({ dryRun: false }), context);
    expect(response.status).toBe(409);
    expect(errorOf(response)).toMatch(/SCHEDULER_ENABLED/);
    expect(scheduler.runFacilitiesScheduler).not.toHaveBeenCalled();
  });

  it("runs live when the scheduler is on", async () => {
    process.env.SCHEDULER_ENABLED = "true";
    scheduler.runFacilitiesScheduler.mockResolvedValue(report);
    try {
      await runSchedulerNow(post({ dryRun: false }), context);
      expect(scheduler.runFacilitiesScheduler).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ dryRun: false }));
    } finally {
      delete process.env.SCHEDULER_ENABLED;
    }
  });

  it("admin only", async () => {
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await runSchedulerNow(post({}), context)).status).toBe(403);
  });
});
