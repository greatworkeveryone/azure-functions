/// <reference types="jest" />
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { ACTION_ROLES, exportActionRoles } from "../action-roles";
import { AppRole } from "../auth";
import { addMonthsClamped, todayInDarwin } from "../darwinDate";
import { closeConnection, executeQuery } from "../db";
import { getComplianceReport, readParams } from "./getComplianceReport";

jest.mock("@azure/functions", () => ({
  ...jest.requireActual("@azure/functions"),
  app: { http: jest.fn() },
}));
let roles: string[] = [AppRole.CFO];
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

const request = (qs = "") => new HttpRequest({ url: `http://localhost/api/getComplianceReport${qs}`, method: "GET" });

const BUILDINGS = [
  { BuildingID: 7, BuildingName: "Bravo Tower", ReferenceCode: "BR" },
  { BuildingID: 3, BuildingName: "Alpha House", ReferenceCode: "AL" },
];
const schedule = (over: Record<string, unknown> = {}) => ({
  Active: true,
  AnchorDate: "2026-01-01",
  ArchivedAt: null,
  BuildingId: 3,
  Category: "HVAC / mechanical",
  ContractorId: 10,
  IntervalCount: 3,
  IntervalUnit: "months",
  LeadDays: 14,
  Name: "Quarterly service",
  NextDue: "2000-01-01",
  Scope: "All units",
  ServiceScheduleId: 1,
  ...over,
});

interface Tables {
  buildings?: unknown[];
  certificates?: unknown[];
  contractors?: unknown[];
  periods?: unknown[];
  plans?: unknown[];
  schedules?: unknown[];
}
function seed({ buildings = BUILDINGS, certificates = [], contractors = [{ Active: true, ContractorID: 10, ContractorName: "Cool Air", Suspended: false }], periods = [], plans = [], schedules = [schedule()] }: Tables = {}) {
  query.mockImplementation(async (_c, sql) => {
    const from = sql.match(/FROM dbo\.(\w+)/)?.[1];
    const tables: Record<string, unknown[]> = { Buildings: buildings, Contractors: contractors, DefectsPeriods: periods, MaintenanceCoverage: plans, RegisterDocuments: certificates, ServiceSchedules: schedules };
    return (from ? (tables[from] ?? []) : []) as never;
  });
}
const body = (r: { jsonBody?: unknown }) => r.jsonBody as Record<string, any>;
const param = (call: (typeof query.mock.calls)[number], name: string) => call[2]?.find((p) => p.name === name)?.value;
const reads = (table: string) => query.mock.calls.filter(([, sql]) => new RegExp(`FROM dbo\\.${table}\\b`).test(sql));

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.CFO];
  token = "token";
  showTest = false;
  seed();
});

describe("access", () => {
  it("is gated by viewOperationsReports: the CFO and facilities managers, with directors and admin passing every gate", () => {
    expect(ACTION_ROLES.viewOperationsReports.routes).toContain("getComplianceReport");
    expect([...ACTION_ROLES.viewOperationsReports.gate].sort()).toEqual([AppRole.CFO, AppRole.FACILITIES_APPROVAL]);
    expect(exportActionRoles().viewOperationsReports).toEqual([AppRole.ADMIN, AppRole.CFO, AppRole.DIRECTOR, AppRole.FACILITIES_APPROVAL]);
  });

  it("returns 401 with no token, before any query", async () => {
    token = null;
    expect((await getComplianceReport(request(), ctx)).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([[AppRole.ACCOUNTS], [AppRole.ACCOUNTS_APPROVAL], [AppRole.FACILITIES], [AppRole.USER]])("returns 403 for %s, before any query", async (role) => {
    roles = [role];
    expect((await getComplianceReport(request(), ctx)).status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 403 for someone with no role at all", async () => {
    roles = [];
    expect((await getComplianceReport(request(), ctx)).status).toBe(403);
  });

  it.each([[AppRole.CFO], [AppRole.DIRECTOR], [AppRole.ADMIN], [AppRole.FACILITIES_APPROVAL]])("lets %s in", async (role) => {
    roles = [role];
    expect((await getComplianceReport(request(), ctx)).status).toBe(200);
  });

  it("lets in someone who holds an allowed role among others", async () => {
    roles = [AppRole.USER, AppRole.FACILITIES_APPROVAL];
    expect((await getComplianceReport(request(), ctx)).status).toBe(200);
  });
});

describe("parameters", () => {
  it.each([["?buildingId=0"], ["?buildingId=abc"], ["?buildingId=1.5"], ["?buildingId=2147483648"], ["?buildingId=ALL"], ["?buildingId=7;DROP"]])(
    "returns 400 for a bad buildingId (%s)",
    async (qs) => {
      const r = await getComplianceReport(request(qs), ctx);
      expect(r.status).toBe(400);
      expect(body(r).error).toEqual(expect.stringContaining("buildingId"));
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([["?asOf=2026-13-01"], ["?asOf=23/10/2026"], ["?asOf=tomorrow"], ["?asOf=2026-02-30"], ["?asOf=2026-10-23T00:00:00Z"]])("returns 400 for an asOf that isn't a date (%s)", async (qs) => {
    const r = await getComplianceReport(request(qs), ctx);
    expect(r.status).toBe(400);
    expect(body(r).error).toEqual(expect.stringContaining("asOf"));
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 400 for a date in the past, and for one more than ten years ahead, and accepts today and the last day it allows", async () => {
    expect(readParams(request("?asOf=2000-01-01"), "2026-10-23")).toEqual({ error: expect.stringContaining("past") });
    expect(readParams(request("?asOf=2036-10-24"), "2026-10-23")).toEqual({ error: expect.stringContaining("10 years") });
    expect(readParams(request("?asOf=2026-10-23"), "2026-10-23")).toMatchObject({ asOf: "2026-10-23" });
    expect(readParams(request("?asOf=2036-10-23"), "2026-10-23")).toMatchObject({ asOf: "2036-10-23" });
    const r = await getComplianceReport(request(`?asOf=${addMonthsClamped(today, 121)}`), ctx);
    expect(r.status).toBe(400);
  });

  it("defaults to today in Darwin and all buildings, and says the date it ran for", async () => {
    const r = await getComplianceReport(request(), ctx);
    expect(r.status).toBe(200);
    expect(body(r).asOf).toBe(today);
    for (const call of query.mock.calls.filter(([, sql]) => /@BuildingId/.test(sql))) expect(param(call, "BuildingId")).toBeNull();
    expect((await getComplianceReport(request("?buildingId=all"), ctx)).status).toBe(200);
  });

  it("reads the date asked for, and hands it to the read of defects periods as a parameter", async () => {
    const later = addMonthsClamped(today, 2);
    const r = await getComplianceReport(request(`?asOf=${later}`), ctx);
    expect(body(r).asOf).toBe(later);
    expect(param(reads("DefectsPeriods")[0], "AsOf")).toBe(later);
  });
});

describe("scope", () => {
  it("loads every building in a handful of queries, whatever the number of buildings or contractors", async () => {
    const r = await getComplianceReport(request("?buildingId=all"), ctx);
    expect(r.status).toBe(200);
    expect(r.headers).toMatchObject({ "Cache-Control": "no-store" });
    expect(query).toHaveBeenCalledTimes(6);
    expect(body(r).checked).toMatchObject({ buildings: 2, contractors: 1, schedules: 1 });
    expect(body(r).buildings.map((entry: { name: string }) => entry.name)).toEqual(["Alpha House"]);
    expect(body(r).buildings[0].overdueSchedules).toEqual([expect.objectContaining({ daysOverdue: expect.any(Number), serviceScheduleId: 1, trade: "HVAC / mechanical" })]);
    expect(body(r).buildings[0].certificates).toEqual([expect.objectContaining({ contractorId: 10, name: "Cool Air", state: "missing" })]);
  });

  it("reads the contractors and their certificates once, naming the ids as a single parameter and not in the text", async () => {
    await getComplianceReport(request(), ctx);
    expect(reads("Contractors")).toHaveLength(1);
    expect(reads("RegisterDocuments")).toHaveLength(1);
    for (const [, sql, params] of [...reads("Contractors"), ...reads("RegisterDocuments")]) {
      expect(sql).toContain("OPENJSON(@Ids)");
      expect(sql).not.toMatch(/\b10\b/);
      expect(params?.find((p) => p.name === "Ids")?.value).toBe("[10]");
    }
  });

  it("names a contractor from the coverage plan too, once", async () => {
    seed({ plans: [{ BuildingId: 3, PlanJson: JSON.stringify([{ contractorIds: [10, 11], required: true, trade: "HVAC / mechanical" }]) }] });
    await getComplianceReport(request(), ctx);
    expect(param(reads("Contractors")[0], "Ids")).toBe("[10,11]");
  });

  it("skips the contractor and certificate reads when nobody is named", async () => {
    seed({ schedules: [schedule({ ContractorId: null })] });
    await getComplianceReport(request(), ctx);
    expect(query).toHaveBeenCalledTimes(4);
    expect(reads("Contractors")).toHaveLength(0);
  });

  it("stops after the building read when there is no building to report on", async () => {
    seed({ buildings: [] });
    const r = await getComplianceReport(request(), ctx);
    expect(r.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(1);
    expect(body(r)).toMatchObject({ buildings: [], checked: { buildings: 0 } });
  });

  it("scopes one building by id, passing it as a parameter to every read that takes one", async () => {
    seed({ buildings: [BUILDINGS[1]] });
    const r = await getComplianceReport(request("?buildingId=3"), ctx);
    expect(r.status).toBe(200);
    const scoped = query.mock.calls.filter(([, sql]) => /@BuildingId/.test(sql));
    expect(scoped).toHaveLength(4);
    for (const call of scoped) expect(param(call, "BuildingId")).toBe(3);
    expect(body(r).buildings).toHaveLength(1);
  });

  it("accepts a manual building's negative id", async () => {
    seed({ buildings: [{ ...BUILDINGS[0], BuildingID: -2 }], schedules: [] });
    expect((await getComplianceReport(request("?buildingId=-2"), ctx)).status).toBe(200);
    expect(param(query.mock.calls[0], "BuildingId")).toBe(-2);
  });

  it("returns 404 for a building that isn't a commercial one, or doesn't exist", async () => {
    seed({ buildings: [] });
    expect((await getComplianceReport(request("?buildingId=99"), ctx)).status).toBe(404);
  });

  it("returns the building with nothing against it, not an error, when it has nothing to show", async () => {
    seed({ buildings: [BUILDINGS[1]], schedules: [], contractors: [] });
    const r = await getComplianceReport(request("?buildingId=3"), ctx);
    expect(r.status).toBe(200);
    expect(body(r).buildings).toEqual([{ buildingId: 3, certificates: [], defectsPeriods: [], name: "Alpha House", overdueSchedules: [], referenceCode: "AL", tradeGaps: [] }]);
    expect(body(r).totals).toEqual({ buildingsWithFindings: 0, certificates: 0, defectsPeriods: 0, overdueSchedules: 0, tradeGaps: 0 });
  });
});

describe("what the reads select", () => {
  it("reads commercial buildings only, for the buildings themselves and for every record read by building", async () => {
    await getComplianceReport(request(), ctx);
    for (const table of ["Buildings", "ServiceSchedules", "DefectsPeriods", "MaintenanceCoverage"]) {
      const [call] = reads(table);
      expect(call[1]).toMatch(/Category = N'commercial'/);
      expect(call[1]).not.toMatch(/residence|development/i);
    }
  });

  it("covers every active commercial building for all, and any commercial building asked for by id", async () => {
    await getComplianceReport(request(), ctx);
    const [call] = reads("Buildings");
    expect(call[1]).toContain("(@BuildingId IS NULL AND cb.Active = 1) OR cb.BuildingID = @BuildingId");
  });

  it("never reads an archived record: schedules, defects periods and certificates", async () => {
    await getComplianceReport(request(), ctx);
    expect(reads("ServiceSchedules")[0][1]).toContain("s.ArchivedAt IS NULL");
    expect(reads("ServiceSchedules")[0][1]).toContain("s.Active = 1");
    expect(reads("DefectsPeriods")[0][1]).toContain("d.ArchivedAt IS NULL");
    expect(reads("RegisterDocuments")[0][1]).toContain("d.ArchivedAt IS NULL");
  });

  it("reads insurance certificates only", async () => {
    await getComplianceReport(request(), ctx);
    const [call] = reads("RegisterDocuments");
    expect(call[1]).toContain("d.Kind = N'certificate'");
    expect(call[1]).toContain("d.ServiceCategory = N'Insurance'");
  });

  it.each([[false], [true]])("leaves out defects periods on test tenancies unless show-test is on (show-test %s)", async (on) => {
    showTest = on;
    await getComplianceReport(request(), ctx);
    const [call] = reads("DefectsPeriods");
    expect(call[1]).toContain("(t.TenantID IS NULL OR t.IsTest = 0 OR @ShowTest = 1)");
    expect(param(call, "ShowTest")).toBe(on);
  });

  it("only reads, and only with parameters: no statement writes and none is built from the request", async () => {
    await getComplianceReport(request("?buildingId=7&asOf=2030-05-17"), ctx);
    for (const [, sql] of query.mock.calls) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|TRUNCATE)\b/i);
      expect(sql).not.toMatch(/2030|\b7\b/);
    }
  });
});

describe("failure", () => {
  it("returns a 500 without the raw error and still closes the connection", async () => {
    query.mockRejectedValue(new Error("boom with secret detail"));
    const r = await getComplianceReport(request(), ctx);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.jsonBody)).not.toContain("secret detail");
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });

  it("closes the connection after a success", async () => {
    await getComplianceReport(request(), ctx);
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });
});
