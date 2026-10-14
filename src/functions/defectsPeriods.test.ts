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

import { archiveDefectsPeriod } from "./archiveDefectsPeriod";
import { getDefectsPeriod } from "./getDefectsPeriod";
import { getDefectsPeriods } from "./getDefectsPeriods";
import { upsertDefectsPeriod } from "./upsertDefectsPeriod";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";
import {
  ROW_VERSION,
  at,
  callsMatching,
  errorOf,
  get,
  jobRow,
  notJson,
  paramsOf,
  periodRow,
  post,
  routeQueries,
  type Route,
} from "../__tests__/fixtures/facilitiesHarness";

const auth = require("../auth") as { extractToken: jest.Mock; requireRole: jest.Mock };
const db = require("../db") as { commitTransaction: jest.Mock; executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const context = new InvocationContext();

const PERIOD_BY_ID = /FROM dbo\.DefectsPeriods d(?: WITH \(UPDLOCK, ROWLOCK\))?\s+LEFT JOIN[\s\S]*WHERE d\.DefectsPeriodId = @Id/;
const PERIOD_LIST = /FROM dbo\.DefectsPeriods d\s+LEFT JOIN[\s\S]*ORDER BY d\.EndsOn/;
const BUILDING = /SELECT BuildingID, Levels FROM dbo\.Buildings WHERE BuildingID = @BuildingId/;
const LEVELS = /FROM dbo\.Locations WHERE BuildingId = @BuildingId AND Kind = 'level'/;
const TENANT = /FROM dbo\.Tenants WHERE TenantID = @TenantId/;
const CONTRACTOR = /FROM dbo\.Contractors WHERE ContractorID = @ContractorId/;
const OPEN_JOBS = /FROM dbo\.Jobs\s+WHERE BuildingID = @BuildingId AND IsArchived = 0/;
const INSERT = /INSERT INTO dbo\.DefectsPeriods/;
const UPDATE = /UPDATE dbo\.DefectsPeriods/;
const APP_USER = /FROM dbo\.AppUsers WHERE EntraOid/;

const validBody = (overrides: Record<string, unknown> = {}) => ({
  buildingId: 1,
  contractorContact: "Sam Builder 0400 000 000",
  contractorId: 5,
  endsOn: "2027-06-30",
  enforcement: "block",
  practicalCompletion: "2026-06-30",
  scope: "building",
  services: ["HVAC / mechanical"],
  works: "Level 3 mechanical upgrade",
  ...overrides,
});

function baseRoutes(extra: Route[] = []): Route[] {
  return [
    ...extra,
    { match: BUILDING, rows: [{ BuildingID: 1, Levels: '["Ground","Level 3"]' }] },
    { match: LEVELS, rows: [{ LocationId: 30, Name: "Level 3" }] },
    { match: CONTRACTOR, rows: [{ ContractorID: 5 }] },
    { match: TENANT, rows: [{ BuildingID: 1, TenantID: 77 }] },
    { match: INSERT, rows: [{ DefectsPeriodId: 3 }] },
    { match: PERIOD_BY_ID, rows: [periodRow()] },
    { match: APP_USER, rows: [{ UserID: 9 }] },
    { match: OPEN_JOBS, rows: [jobRow(), jobRow({ Category: "Lifts", JobID: 41, Title: "Lift service" })] },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  routeQueries(db.executeQuery, baseRoutes());
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"], now: new Date("2026-10-14T01:00:00Z") });
});

afterEach(() => jest.useRealTimers());

describe("getDefectsPeriods", () => {
  it("lists live periods with dates as YYYY-MM-DD and services parsed", async () => {
    routeQueries(db.executeQuery, [{ match: PERIOD_LIST, rows: [periodRow(), periodRow({ DefectsPeriodId: 4, Services: "all" })] }]);
    const response = await getDefectsPeriods(get({ buildingId: "1" }), context);
    expect(response.status).toBe(200);
    const { periods } = response.jsonBody as { periods: Array<Record<string, unknown>> };
    expect(periods[0]).toMatchObject({
      active: true,
      contractorName: "Acme Builders",
      endsOn: "2027-06-30",
      practicalCompletion: "2026-06-30",
      rowVersion: ROW_VERSION.toString("base64"),
      services: ["HVAC / mechanical"],
    });
    expect(periods[1].services).toBe("all");
    const [call] = callsMatching(db.executeQuery, PERIOD_LIST);
    expect(call[1]).toMatch(/d\.ArchivedAt IS NULL/);
    expect(paramsOf(call)).toEqual({ BuildingId: 1 });
  });

  it("includes archived periods only when asked", async () => {
    routeQueries(db.executeQuery, [{ match: PERIOD_LIST, rows: [] }]);
    await getDefectsPeriods(get({ includeArchived: "true" }), context);
    expect(callsMatching(db.executeQuery, PERIOD_LIST)[0][1]).not.toMatch(/ArchivedAt IS NULL/);
  });

  it("401 without a token, 403 when the role check refuses", async () => {
    auth.extractToken.mockReturnValueOnce(null);
    expect((await getDefectsPeriods(get({}), context)).status).toBe(401);
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await getDefectsPeriods(get({}), context)).status).toBe(403);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("400 for a building id that isn't a number", async () => {
    const response = await getDefectsPeriods(get({ buildingId: "tower" }), context);
    expect(response.status).toBe(400);
  });

  it("500 when the database fails, without leaking the error", async () => {
    routeQueries(db.executeQuery, [{ match: PERIOD_LIST, throws: new Error("socket hang up") }]);
    const response = await getDefectsPeriods(get({}), context);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.jsonBody)).not.toMatch(/socket/);
  });
});

describe("getDefectsPeriod", () => {
  it("returns the period and the open jobs it covers today", async () => {
    const response = await getDefectsPeriod(get({ id: "3" }), context);
    expect(response.status).toBe(200);
    const body = response.jsonBody as { coveredOpenJobs: unknown[]; period: { defectsPeriodId: number } };
    expect(body.period.defectsPeriodId).toBe(3);
    expect(body.coveredOpenJobs).toEqual([{ jobId: 40, status: "New", title: "Chiller service" }]);
  });

  it("404 when there is no such period; 400 for a bad id", async () => {
    routeQueries(db.executeQuery, [{ match: PERIOD_BY_ID, rows: [] }]);
    expect((await getDefectsPeriod(get({ id: "3" }), context)).status).toBe(404);
    expect((await getDefectsPeriod(get({ id: "x" }), context)).status).toBe(400);
  });
});

describe("upsertDefectsPeriod", () => {
  it("creates a period, ledgers it and lists the open jobs it already covers", async () => {
    const response = await upsertDefectsPeriod(post(validBody()), context);
    expect(response.status).toBe(200);
    const body = response.jsonBody as { coveredOpenJobs: unknown[]; created: boolean };
    expect(body.created).toBe(true);
    expect(body.coveredOpenJobs).toEqual([{ jobId: 40, status: "New", title: "Chiller service" }]);
    const [insert] = callsMatching(db.executeQuery, INSERT);
    expect(paramsOf(insert)).toMatchObject({
      BuildingId: 1,
      CreatedBy: "Simone",
      EndsOn: "2027-06-30",
      Enforcement: "block",
      Scope: "building",
      Services: '["HVAC / mechanical"]',
    });
    const [ledger] = ledgerInserts(db.executeQuery);
    expect(ledger).toMatchObject({ action: "defects_period.create", actorName: "Simone", buildingId: 1, subjectId: "3", subjectType: "defects_period" });
    expect(db.commitTransaction).toHaveBeenCalled();
  });

  it("resolves a level by name to its Locations row", async () => {
    await upsertDefectsPeriod(post(validBody({ levelName: "level 3", scope: "level" })), context);
    expect(paramsOf(callsMatching(db.executeQuery, INSERT)[0])).toMatchObject({ LevelName: "Level 3", LocationId: 30, Scope: "level" });
  });

  it("refuses a level the building doesn't have", async () => {
    const response = await upsertDefectsPeriod(post(validBody({ levelName: "Level 9", scope: "level" })), context);
    expect(response.status).toBe(400);
    expect(errorOf(response)).toMatch(/Level 9/);
    expect(callsMatching(db.executeQuery, INSERT)).toHaveLength(0);
  });

  it("refuses a tenancy in another building", async () => {
    routeQueries(db.executeQuery, baseRoutes([{ match: TENANT, rows: [{ BuildingID: 2, TenantID: 77 }] }]));
    const response = await upsertDefectsPeriod(post(validBody({ scope: "tenancy", tenantId: 77 })), context);
    expect(response.status).toBe(400);
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });

  it.each([
    [{ works: "" }, /works is required/],
    [{ services: [] }, /services/],
    [{ services: ["Plumbing"] }, /not a maintenance category/],
    [{ scope: "floor" }, /scope/],
    [{ endsOn: "2026-01-01" }, /before practical completion/],
    [{ practicalCompletion: "30/06/2026" }, /YYYY-MM-DD/],
    [{ scope: "level" }, /level/],
    [{ scope: "tenancy" }, /tenancy/],
    [{ enforcement: "maybe" }, /block or warn/],
    [{ defectsPeriodId: 3 }, /rowVersion/],
  ])("400 for invalid input %j", async (overrides, message) => {
    const response = await upsertDefectsPeriod(post(validBody(overrides)), context);
    expect(response.status).toBe(400);
    expect(errorOf(response)).toMatch(message);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("400 when the body isn't JSON", async () => {
    expect((await upsertDefectsPeriod(notJson(), context)).status).toBe(400);
  });

  it("updates with the row version it was given and ledgers before and after", async () => {
    routeQueries(db.executeQuery, baseRoutes([{ match: UPDATE, rows: [{ DefectsPeriodId: 3 }] }]));
    const response = await upsertDefectsPeriod(
      post(validBody({ defectsPeriodId: 3, enforcement: "warn", rowVersion: ROW_VERSION.toString("base64") })),
      context,
    );
    expect(response.status).toBe(200);
    const [update] = callsMatching(db.executeQuery, UPDATE);
    expect(update[1]).toMatch(/WHERE DefectsPeriodId = @Id AND RowVersion = @RowVersion/);
    expect(paramsOf(update)).toMatchObject({ Enforcement: "warn", Id: 3, UpdatedBy: "Simone" });
    const [ledger] = ledgerInserts(db.executeQuery);
    expect(ledger.action).toBe("defects_period.update");
    expect(ledger.before).toMatchObject({ enforcement: "block" });
  });

  it("409 when someone else changed the period since it was read", async () => {
    const stale = Buffer.from([0, 0, 0, 0, 0, 0, 0, 1]).toString("base64");
    const response = await upsertDefectsPeriod(post(validBody({ defectsPeriodId: 3, rowVersion: stale })), context);
    expect(response.status).toBe(409);
    expect(errorOf(response)).toMatch(/Simone changed/);
    expect(callsMatching(db.executeQuery, UPDATE)).toHaveLength(0);
  });

  it("409 when editing an archived period", async () => {
    routeQueries(db.executeQuery, baseRoutes([{ match: PERIOD_BY_ID, rows: [periodRow({ ArchivedAt: at("2026-10-01"), ArchivedBy: "Adam" })] }]));
    const response = await upsertDefectsPeriod(post(validBody({ defectsPeriodId: 3, rowVersion: ROW_VERSION.toString("base64") })), context);
    expect(response.status).toBe(409);
  });

  it("403 for someone who may not manage periods; 401 without a token", async () => {
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await upsertDefectsPeriod(post(validBody()), context)).status).toBe(403);
    auth.extractToken.mockReturnValueOnce(null);
    expect((await upsertDefectsPeriod(post(validBody()), context)).status).toBe(401);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("500 and a rollback when the insert fails", async () => {
    routeQueries(db.executeQuery, baseRoutes([{ match: INSERT, throws: new Error("deadlock") }]));
    const response = await upsertDefectsPeriod(post(validBody()), context);
    expect(response.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});

describe("archiveDefectsPeriod", () => {
  it("archives (never deletes) and ledgers the reason", async () => {
    let archived = false;
    routeQueries(db.executeQuery, baseRoutes([
      { match: PERIOD_BY_ID, rows: () => [periodRow(archived ? { ArchivedAt: at("2026-10-14"), ArchivedBy: "Simone" } : {})] },
      { match: UPDATE, rows: () => { archived = true; return []; } },
    ]));
    const response = await archiveDefectsPeriod(post({ defectsPeriodId: 3, reason: "Entered twice" }), context);
    expect(response.status).toBe(200);
    expect((response.jsonBody as { period: { archivedBy: string } }).period.archivedBy).toBe("Simone");
    const [update] = callsMatching(db.executeQuery, UPDATE);
    expect(update[1]).toMatch(/SET ArchivedAt = SYSUTCDATETIME\(\), ArchivedBy = @Caller/);
    expect(callsMatching(db.executeQuery, /DELETE/)).toHaveLength(0);
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "defects_period.archive", reason: "Entered twice" });
  });

  it("restores with archived: false", async () => {
    routeQueries(db.executeQuery, baseRoutes([{ match: PERIOD_BY_ID, rows: [periodRow({ ArchivedAt: at("2026-10-01"), ArchivedBy: "Adam" })] }]));
    const response = await archiveDefectsPeriod(post({ archived: false, defectsPeriodId: 3 }), context);
    expect(response.status).toBe(200);
    expect(callsMatching(db.executeQuery, UPDATE)[0][1]).toMatch(/SET ArchivedAt = NULL, ArchivedBy = NULL/);
    expect(ledgerInserts(db.executeQuery)[0].action).toBe("defects_period.restore");
  });

  it("archiving an archived period changes nothing", async () => {
    routeQueries(db.executeQuery, baseRoutes([{ match: PERIOD_BY_ID, rows: [periodRow({ ArchivedAt: at("2026-10-01"), ArchivedBy: "Adam" })] }]));
    const response = await archiveDefectsPeriod(post({ defectsPeriodId: 3 }), context);
    expect(response.status).toBe(200);
    expect(callsMatching(db.executeQuery, UPDATE)).toHaveLength(0);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });

  it("400 without an id, 404 for an unknown one, 403 for staff", async () => {
    expect((await archiveDefectsPeriod(post({}), context)).status).toBe(400);
    routeQueries(db.executeQuery, [{ match: PERIOD_BY_ID, rows: [] }]);
    expect((await archiveDefectsPeriod(post({ defectsPeriodId: 99 }), context)).status).toBe(404);
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await archiveDefectsPeriod(post({ defectsPeriodId: 3 }), context)).status).toBe(403);
  });
});
