/// <reference types="jest" />
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { ACTION_ROLES, exportActionRoles } from "../action-roles";
import { AppRole } from "../auth";
import { todayInDarwin } from "../darwinDate";
import { closeConnection, executeQuery } from "../db";
import { financialYearOf } from "../maintenanceSpend/financialYear";
import { getMaintenanceSpendReport } from "./getMaintenanceSpendReport";

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
const currentYear = financialYearOf(todayInDarwin()).label;

const request = (qs = "") => new HttpRequest({ url: `http://localhost/api/getMaintenanceSpendReport${qs}`, method: "GET" });

const BUILDINGS = [
  { BuildingID: 7, BuildingName: "Bravo Tower", ReferenceCode: "BR" },
  { BuildingID: 3, BuildingName: "Alpha House", ReferenceCode: "AL" },
];
const row = (over: Record<string, unknown> = {}) => ({
  Amount: 110,
  ApprovedAt: null,
  BuildingID: 3,
  Category: "Electrical",
  Direction: "incoming",
  IsOnchargeable: false,
  JobID: 1,
  JobInvoiceID: 1,
  ReceivedAt: new Date("2025-10-15T00:00:00Z"),
  ...over,
});

function seed(buildings: unknown[] = BUILDINGS, invoices: unknown[] = [row(), row({ BuildingID: 7, Category: "Cleaning", JobID: 2 })]) {
  query.mockImplementation(async (_c, sql) => {
    const from = sql.match(/FROM dbo\.(\w+)/)?.[1];
    if (from === "Buildings") return buildings as never;
    if (from === "JobInvoices") return invoices as never;
    return [];
  });
}
const body = (r: { jsonBody?: unknown }) => r.jsonBody as Record<string, any>;
const param = (call: (typeof query.mock.calls)[number], name: string) => call[2]?.find((p) => p.name === name)?.value;

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.CFO];
  token = "token";
  showTest = false;
  seed();
});

describe("access", () => {
  it("is gated by viewOperationsReports: the CFO and facilities managers, with directors and admin passing every gate", () => {
    expect(ACTION_ROLES.viewOperationsReports.routes).toContain("getMaintenanceSpendReport");
    expect([...ACTION_ROLES.viewOperationsReports.gate].sort()).toEqual([AppRole.CFO, AppRole.FACILITIES_APPROVAL]);
    expect(exportActionRoles().viewOperationsReports).toEqual([AppRole.ADMIN, AppRole.CFO, AppRole.DIRECTOR, AppRole.FACILITIES_APPROVAL]);
  });

  it("returns 401 with no token, before any query", async () => {
    token = null;
    expect((await getMaintenanceSpendReport(request(), ctx)).status).toBe(401);
    expect(query).not.toHaveBeenCalled();
  });

  it.each([[AppRole.ACCOUNTS], [AppRole.ACCOUNTS_APPROVAL], [AppRole.FACILITIES], [AppRole.USER]])("returns 403 for %s, before any query", async (role) => {
    roles = [role];
    const r = await getMaintenanceSpendReport(request(), ctx);
    expect(r.status).toBe(403);
    expect(query).not.toHaveBeenCalled();
  });

  it("returns 403 for someone with no role at all", async () => {
    roles = [];
    expect((await getMaintenanceSpendReport(request(), ctx)).status).toBe(403);
  });

  it.each([[AppRole.CFO], [AppRole.DIRECTOR], [AppRole.ADMIN], [AppRole.FACILITIES_APPROVAL]])("lets %s in", async (role) => {
    roles = [role];
    expect((await getMaintenanceSpendReport(request(), ctx)).status).toBe(200);
  });

  it("lets in someone who holds an allowed role among others", async () => {
    roles = [AppRole.USER, AppRole.FACILITIES_APPROVAL];
    expect((await getMaintenanceSpendReport(request(), ctx)).status).toBe(200);
  });
});

describe("parameters", () => {
  it.each([["?buildingId=0"], ["?buildingId=abc"], ["?buildingId=1.5"], ["?buildingId=2147483648"], ["?buildingId=ALL"], ["?buildingId=7;DROP"]])(
    "returns 400 for a bad buildingId (%s)",
    async (qs) => {
      const r = await getMaintenanceSpendReport(request(qs), ctx);
      expect(r.status).toBe(400);
      expect(body(r).error).toEqual(expect.stringContaining("buildingId"));
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([["?financialYear=2025"], ["?financialYear=2025-27"], ["?financialYear=25-26"], ["?financialYear=1999-00"], ["?financialYear=2099-00"], ["?financialYear=x"]])(
    "returns 400 for a bad financialYear (%s)",
    async (qs) => {
      const r = await getMaintenanceSpendReport(request(qs), ctx);
      expect(r.status).toBe(400);
      expect(body(r).error).toEqual(expect.stringContaining("financialYear"));
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("defaults to this financial year and all buildings", async () => {
    const r = await getMaintenanceSpendReport(request(), ctx);
    expect(r.status).toBe(200);
    expect(body(r).financialYear.label).toBe(currentYear);
    for (const call of query.mock.calls) expect(param(call, "BuildingId")).toBeNull();
    expect((await getMaintenanceSpendReport(request("?buildingId=all"), ctx)).status).toBe(200);
  });

  it("reads the year asked for, and brackets it for the read", async () => {
    const r = await getMaintenanceSpendReport(request("?financialYear=2025-26"), ctx);
    expect(body(r).financialYear).toEqual({ from: "2025-07-01", label: "2025-26", to: "2026-06-30" });
    const invoices = query.mock.calls.find(([, sql]) => /FROM dbo\.JobInvoices/.test(sql));
    expect(invoices && (param(invoices, "From") as Date).toISOString()).toBe("2025-06-30T00:00:00.000Z");
    expect(invoices && (param(invoices, "To") as Date).toISOString()).toBe("2026-07-02T00:00:00.000Z");
  });
});

describe("scope", () => {
  it("loads every building in two queries, whatever the number of buildings, with the figures laid out by building and trade ex GST", async () => {
    const r = await getMaintenanceSpendReport(request("?financialYear=2025-26&buildingId=all"), ctx);
    expect(r.status).toBe(200);
    expect(r.headers).toMatchObject({ "Cache-Control": "no-store" });
    expect(query).toHaveBeenCalledTimes(2);
    expect(body(r).buildings.map((b: { name: string }) => b.name)).toEqual(["Alpha House", "Bravo Tower"]);
    expect(body(r).buildings[0].trades).toEqual([{ jobCount: 1, onChargesRecovered: 0, spend: 100, trade: "Electrical" }]);
    expect(body(r).portfolio).toEqual({ buildingCount: 2, jobCount: 2, onChargesRecovered: 0, spend: 200 });
    expect(body(r).topTrades.map((t: { trade: string }) => t.trade)).toEqual(["Electrical", "Cleaning"]);
    expect(body(r).dating).toEqual({ approvalFallbacks: 0, undated: 0 });
    expect(body(r).generatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("scopes one building by id, passing it as a parameter to both queries", async () => {
    seed([BUILDINGS[1]]);
    const r = await getMaintenanceSpendReport(request("?financialYear=2025-26&buildingId=3"), ctx);
    expect(r.status).toBe(200);
    expect(query).toHaveBeenCalledTimes(2);
    for (const call of query.mock.calls) expect(param(call, "BuildingId")).toBe(3);
    expect(body(r).buildings).toHaveLength(1);
  });

  it("accepts a manual building's negative id", async () => {
    seed([{ ...BUILDINGS[0], BuildingID: -2 }], []);
    expect((await getMaintenanceSpendReport(request("?buildingId=-2"), ctx)).status).toBe(200);
    expect(param(query.mock.calls[0], "BuildingId")).toBe(-2);
  });

  it("returns 404 for a building that isn't a commercial one, or doesn't exist", async () => {
    seed([], []);
    expect((await getMaintenanceSpendReport(request("?buildingId=99"), ctx)).status).toBe(404);
  });

  it("returns an empty report, not an error, for a building with nothing in the year", async () => {
    seed([BUILDINGS[1]], []);
    const r = await getMaintenanceSpendReport(request("?buildingId=3"), ctx);
    expect(r.status).toBe(200);
    expect(body(r).buildings).toEqual([{ buildingId: 3, name: "Alpha House", referenceCode: "AL", total: { jobCount: 0, onChargesRecovered: 0, spend: 0 }, trades: [] }]);
  });

  it("returns an empty report for all buildings when there is nothing in the year", async () => {
    seed(BUILDINGS, []);
    const r = await getMaintenanceSpendReport(request(), ctx);
    expect(r.status).toBe(200);
    expect(body(r).buildings).toEqual([]);
    expect(body(r).portfolio).toEqual({ buildingCount: 0, jobCount: 0, onChargesRecovered: 0, spend: 0 });
  });
});

describe("what the reads select", () => {
  const sqlFor = (pattern: RegExp) => query.mock.calls.filter(([, sql]) => pattern.test(sql));

  it.each([[false], [true]])("excludes archived jobs always and test jobs and invoices unless show-test is on (show-test %s)", async (on) => {
    showTest = on;
    await getMaintenanceSpendReport(request(), ctx);
    const [call] = sqlFor(/FROM dbo\.JobInvoices/);
    expect(call[1]).toContain("j.IsArchived = 0");
    expect(call[1]).toContain("(j.IsTest = 0 OR @ShowTest = 1)");
    expect(call[1]).toContain("(i.IsTest = 0 OR @ShowTest = 1)");
    expect(param(call, "ShowTest")).toBe(on);
  });

  it("reads commercial buildings only: residences and development sites stay out of company reporting", async () => {
    await getMaintenanceSpendReport(request(), ctx);
    const reads = sqlFor(/FROM dbo\.(Buildings|JobInvoices)\b/);
    expect(reads).toHaveLength(2);
    for (const [, sql] of reads) expect(sql).toMatch(/Category = N'commercial'/);
  });

  it("reads approved invoices only, with an amount", async () => {
    await getMaintenanceSpendReport(request(), ctx);
    const [call] = sqlFor(/FROM dbo\.JobInvoices/);
    expect(call[1]).toContain("i.Status IN (N'approved', N'director_approved')");
    expect(call[1]).toContain("i.Amount IS NOT NULL");
  });

  it("only reads, and only with parameters: no statement writes and none is built from the request", async () => {
    await getMaintenanceSpendReport(request("?buildingId=7&financialYear=2025-26"), ctx);
    for (const [, sql] of query.mock.calls) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|MERGE|ALTER|DROP|TRUNCATE)\b/i);
      expect(sql).not.toMatch(/2025|\b7\b/);
    }
  });
});

describe("failure", () => {
  it("returns a 500 without the raw error and still closes the connection", async () => {
    query.mockRejectedValue(new Error("boom with secret detail"));
    const r = await getMaintenanceSpendReport(request(), ctx);
    expect(r.status).toBe(500);
    expect(JSON.stringify(r.jsonBody)).not.toContain("secret detail");
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });

  it("closes the connection after a success", async () => {
    await getMaintenanceSpendReport(request(), ctx);
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });
});
