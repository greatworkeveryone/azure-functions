/// <reference types="jest" />
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { ACTION_ROLES } from "../action-roles";
import { AppRole } from "../auth";
import { addDaysIso, todayInDarwin } from "../darwinDate";
import { closeConnection, executeQuery } from "../db";
import { getTenancySchedule } from "./getTenancySchedule";

jest.mock("@azure/functions", () => ({
  ...jest.requireActual("@azure/functions"),
  app: { http: jest.fn() },
}));
let roles: string[] = [AppRole.DIRECTOR];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) =>
    jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 },
}));
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(async () => ({})),
  executeQuery: jest.fn(),
}));
let showTest = false;
jest.mock("../test-data", () => ({
  showTestParam: async () => ({ name: "ShowTest", type: jest.requireActual("tedious").TYPES.Bit, value: showTest }),
}));

const query = jest.mocked(executeQuery);
const ctx = { error: jest.fn() } as unknown as InvocationContext;
const today = todayInDarwin();

const request = (qs: string) => new HttpRequest({ url: `http://localhost/api/getTenancySchedule${qs}`, method: "GET" });

const BUILDINGS = [
  { BuildingAddress: "2 Bravo St", BuildingID: 7, BuildingName: "Bravo", ReferenceCode: "BR" },
  { BuildingAddress: "1 Alpha St", BuildingID: 3, BuildingName: "Alpha", ReferenceCode: "AL" },
];
const tenantRow = (tenantId: number, buildingId: number, over: Record<string, unknown> = {}) => ({
  BuildingId: buildingId,
  Expiry: "2035-06-30",
  LegalName: `Tenant ${tenantId}`,
  RentPerAnnum: 24000,
  Status: "current",
  TenantId: tenantId,
  ...over,
});
const TENANTS = [tenantRow(1, 3), tenantRow(2, 7), tenantRow(3, 7, { LegalName: "Vacant" })];
const OCCUPANCIES = [
  { Area: "A1", Level: "Ground", SizeSqm: 100, TenantId: 1 },
  { Area: "B1", Level: "Ground", SizeSqm: 50, TenantId: 2 },
  { Area: "B2", Level: "Ground", SizeSqm: 25, TenantId: 3 },
];

function seed(buildings: unknown[] = BUILDINGS) {
  query.mockImplementation(async (_c, sql) => {
    if (sql.includes("dbo.ScheduleChangeRequests") || sql.includes("dbo.RentReviews")) return [];
    // Route on each read's first FROM: later ones are subqueries (the commercial-building filter).
    const from = /FROM dbo\.(\w+)/.exec(sql)?.[1];
    if (from === "Buildings") return buildings as never;
    if (from === "TenantOccupancies") return OCCUPANCIES;
    if (from === "Carparks") return [];
    if (from === "Tenants") return TENANTS;
    return [];
  });
}
const body = (r: { jsonBody?: unknown }) => r.jsonBody as Record<string, any>;

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.DIRECTOR];
  token = "token";
  showTest = false;
  seed();
});

describe("access", () => {
  it("is gated by the viewTenancySchedule capability: director and CFO, not facilities", () => {
    expect(ACTION_ROLES.viewTenancySchedule.routes).toContain("getTenancySchedule");
    expect([...ACTION_ROLES.viewTenancySchedule.gate].sort()).toEqual([AppRole.CFO, AppRole.DIRECTOR]);
  });

  it("returns 401 with no token, before any query", async () => {
    token = null;
    expect((await getTenancySchedule(request("?buildingId=all"), ctx)).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([[AppRole.FACILITIES], [AppRole.ACCOUNTS], [AppRole.USER]])("returns 403 for %s, before any query", async (role) => {
    roles = [role];
    expect((await getTenancySchedule(request("?buildingId=all"), ctx)).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([[AppRole.DIRECTOR], [AppRole.CFO], [AppRole.ADMIN]])("lets %s in", async (role) => {
    roles = [role];
    expect((await getTenancySchedule(request("?buildingId=all"), ctx)).status).toBe(200);
  });
});

describe("parameters", () => {
  it.each([[""], ["?buildingId=0"], ["?buildingId=abc"], ["?buildingId=1.5"], ["?buildingId=2147483648"], ["?buildingId=ALL"]])(
    "returns 400 for a missing or bad buildingId (%s)",
    async (qs) => {
      const r = await getTenancySchedule(request(qs), ctx);
      expect(r.status).toBe(400);
      expect(body(r).error).toEqual(expect.any(String));
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("returns 400 for a past date", async () => {
    const r = await getTenancySchedule(request(`?buildingId=all&asOf=${addDaysIso(today, -1)}`), ctx);
    expect(r.status).toBe(400);
    expect(body(r).error).toMatch(/past/);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([["2026-13-01"], ["2026-02-30"], ["tomorrow"], ["01/11/2026"]])("returns 400 for a malformed date (%s)", async (asOf) => {
    expect((await getTenancySchedule(request(`?buildingId=all&asOf=${asOf}`), ctx)).status).toBe(400);
  });

  it("returns 400 for a date more than 10 years ahead, and accepts today and a date in range", async () => {
    expect((await getTenancySchedule(request(`?buildingId=all&asOf=${addDaysIso(today, 3700)}`), ctx)).status).toBe(400);
    expect((await getTenancySchedule(request(`?buildingId=all&asOf=${addDaysIso(today, 3600)}`), ctx)).status).toBe(200);
    const r = await getTenancySchedule(request(`?buildingId=all&asOf=${today}`), ctx);
    expect(r.status).toBe(200);
    expect(body(r).asOf).toBe(today);
  });

  it("defaults asOf to today (Darwin)", async () => {
    const r = await getTenancySchedule(request("?buildingId=all"), ctx);
    expect(body(r).asOf).toBe(today);
    expect(body(r).generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("scope", () => {
  it("loads every building in six batched queries, whatever the number of buildings, and orders them by name", async () => {
    const r = await getTenancySchedule(request("?buildingId=all"), ctx);
    expect(r.status).toBe(200);
    expect(r.headers).toMatchObject({ "Cache-Control": "no-store" });
    expect(query).toHaveBeenCalledTimes(6);
    // The four report queries take @BuildingId = NULL; the pending-change reads (scheduleChange/pending.ts) take no building at all.
    const withBuilding = query.mock.calls.filter(([, , params]) => params?.some((p) => p.name === "BuildingId"));
    expect(withBuilding).toHaveLength(4);
    for (const [, , params] of withBuilding) expect(params?.find((p) => p.name === "BuildingId")?.value).toBeNull();
    expect(body(r).buildings.map((b: { name: string }) => b.name)).toEqual(["Alpha", "Bravo"]);
    expect(body(r).buildings[1]).toMatchObject({ buildingId: 7, referenceCode: "BR" });
    expect(body(r).buildings[1].leases).toHaveLength(1);
    expect(body(r).buildings[1].vacancies).toHaveLength(1);
    expect(body(r).portfolio).toMatchObject({ leaseCount: 2, totalNlaSqm: 175, vacantNlaSqm: 25 });
    expect(body(r).pendingChanges).toEqual({ count: 0, items: [] });
  });

  it("scopes one building by id, passing it as a parameter to every query", async () => {
    seed([BUILDINGS[1]]);
    const r = await getTenancySchedule(request("?buildingId=3"), ctx);
    expect(r.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(6);
    for (const [, , params] of query.mock.calls) {
      expect(params?.find((p) => p.name === "BuildingId")?.value).toBe(3);
    }
    expect(body(r).buildings).toHaveLength(1);
  });

  it("accepts a manual building's negative id", async () => {
    seed([{ ...BUILDINGS[0], BuildingID: -2 }]);
    expect((await getTenancySchedule(request("?buildingId=-2"), ctx)).status).toBe(200);
    expect(query.mock.calls[0][2]?.find((p) => p.name === "BuildingId")?.value).toBe(-2);
  });

  it("returns 404 for a building that doesn't exist", async () => {
    seed([]);
    expect((await getTenancySchedule(request("?buildingId=99"), ctx)).status).toBe(404);
  });

  it("returns an empty report for all buildings when none has a tenancy", async () => {
    seed([]);
    const r = await getTenancySchedule(request("?buildingId=all"), ctx);
    expect(r.status).toBe(200);
    expect(body(r).buildings).toEqual([]);
    expect(body(r).portfolio).toMatchObject({ leaseCount: 0, totalNlaSqm: 0, vacantPercent: 0 });
  });
});

describe("test and archived records", () => {
  const scoped = (pattern: RegExp) => query.mock.calls.filter(([, sql]) => pattern.test(sql));

  it.each([[false], [true]])("excludes archived tenancies always and test ones unless show-test is on (show-test %s)", async (on) => {
    showTest = on;
    await getTenancySchedule(request("?buildingId=all"), ctx);
    const reads = scoped(/dbo\.(Tenants|TenantOccupancies|ScheduleChangeRequests|RentReviews)/);
    expect(reads.length).toBeGreaterThanOrEqual(5);
    for (const [, sql, params] of reads) {
      expect(sql).toContain("ArchivedAt IS NULL");
      expect(sql).toMatch(/IsTest = 0 OR @ShowTest = 1/);
      expect(params?.find((p) => p.name === "ShowTest")?.value).toBe(on);
    }
    const carparks = scoped(/dbo\.Carparks/);
    expect(carparks).toHaveLength(1);
    expect(carparks[0][1]).toContain("ArchivedAt IS NULL");
  });

  it("reads commercial buildings only: residences and development sites stay out of company reporting", async () => {
    await getTenancySchedule(request("?buildingId=all"), ctx);
    const reads = scoped(/FROM dbo\.(Buildings|Tenants|TenantOccupancies|Carparks)\b/);
    expect(reads.length).toBe(4);
    for (const [, sql] of reads) expect(sql).toMatch(/Category = N'commercial'/);
  });

  it("only reads: no statement writes", async () => {
    await getTenancySchedule(request("?buildingId=all"), ctx);
    for (const [, sql] of query.mock.calls) expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|TRUNCATE)\b/i);
  });
});

describe("failure", () => {
  it("returns a 500 without the raw error and still closes the connection", async () => {
    query.mockRejectedValue(new Error("boom with secret detail"));
    const r = await getTenancySchedule(request("?buildingId=all"), ctx);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.jsonBody)).not.toContain("secret detail");
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });

  it("closes the connection after a success", async () => {
    await getTenancySchedule(request("?buildingId=all"), ctx);
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });
});
