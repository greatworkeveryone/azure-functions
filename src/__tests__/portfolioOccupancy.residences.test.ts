/// <reference types="jest" />
// T10, extended to the portfolio figures (Connor, 22 Oct 2026): a residence is the
// family's own house, so its tenancy never counts in the company's occupancy, rent,
// WALE, tenant or pending-change figures. Real handler; the database is a fake that
// applies what each query says about categories, so a query that forgets its filter
// hands the handler the residence's tenancy and the totals go wrong. Operational
// reads of a residence are untouched (U8): getReviewsDue is checked at the end.
import type { HttpRequest, InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { resetBuildingCategoryColumnProbe } from "../buildingCategoryColumn";
import { addDaysIso, todayInDarwin } from "../darwinDate";
import { getRequest, reviewRow, routeSql, type Row } from "./fixtures/rentReviewFakes";

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  const bag = globalThis as unknown as { __residenceHandlers?: Record<string, unknown> };
  bag.__residenceHandlers = bag.__residenceHandlers ?? {};
  return { ...actual, app: { ...actual.app, http: (name: string, opts: { handler: unknown }) => ((bag.__residenceHandlers as Record<string, unknown>)[name] = opts.handler), timer: () => undefined } };
});
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(), executeQuery: jest.fn() }));
jest.mock("../tenant-register-cache", () => ({
  getCachedTenantDetail: jest.fn().mockReturnValue(null),
  getCachedTenantList: jest.fn().mockReturnValue(null),
  invalidateTenant: jest.fn(),
  invalidateTenantAndBuilding: jest.fn(),
  setCachedTenantDetail: jest.fn(),
  setCachedTenantList: jest.fn(),
}));

require("../functions/tenancy");
const handlers = (globalThis as unknown as { __residenceHandlers: Record<string, Handler> }).__residenceHandlers;
const db = require("../db") as { createRequestConnection: jest.Mock; executeQuery: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const TODAY = todayInDarwin();
const DAY = (n: number) => addDaysIso(TODAY, n);

const COMMERCIAL_BUILDING = 5;
const RESIDENCE = 9;
const CATEGORY_OF: Record<number, string> = { [COMMERCIAL_BUILDING]: "commercial", [RESIDENCE]: "residence" };

// What the commercial-only fragment says, wherever it appears in a query.
const COMMERCIAL_ONLY = /EXISTS \(SELECT 1 FROM dbo\.Buildings cb WHERE cb\.BuildingID = t\.BuildingId AND cb\.Category = N'commercial'\)/;
const rowsFor = (sql: string, rows: Row[], buildingOf: (row: Row) => number): Row[] =>
  COMMERCIAL_ONLY.test(sql) ? rows.filter((row) => CATEGORY_OF[buildingOf(row)] === "commercial") : rows;

const figures = (buildingId: number, rent: number, sqm: number): Row => ({
  ActiveSqm: sqm,
  ActiveTenantCount: 1,
  AnnualRent: rent,
  BuildingId: buildingId,
  TotalSqm: sqm,
  UnsignedTenantCount: 1,
  WaleDenominatorSqm: sqm,
  WaleNumeratorSqmDays: sqm * 365.25 * 2,
});
const FIGURES = [figures(COMMERCIAL_BUILDING, 100000, 100), figures(RESIDENCE, 80000, 60)];

const relief = (requestId: string, buildingId: number, tenantId: number): Row => ({
  BuildingId: buildingId,
  Kind: "relief",
  LegalName: "Pty Ltd",
  Payload: JSON.stringify({ from: DAY(30), kind: "percent", scope: ["rent"], to: DAY(60), value: 50 }),
  Reason: "Fit-out works",
  RequestId: requestId,
  RequestedAt: new Date("2026-10-01T01:00:00Z"),
  RequestedByName: "Ann Accounts",
  State: "pending",
  TenantId: tenantId,
  TradingName: null,
});
const RELIEFS = [relief("req-commercial", COMMERCIAL_BUILDING, 7), relief("req-residence", RESIDENCE, 21)];
const awaiting = (reviewId: string, buildingId: number, tenantId: number): Row =>
  reviewRow({
    BuildingId: buildingId,
    Calc: JSON.stringify({ currentAnnual: 100000, method: "fixed", newAnnual: 103000, scheduleVersion: 4 }),
    ReviewId: reviewId,
    State: "awaiting_approval",
    TenantId: tenantId,
  });
const REVIEWS = [awaiting("rev-commercial", COMMERCIAL_BUILDING, 7), awaiting("rev-residence", RESIDENCE, 21)];

let categoryColumn: boolean;
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  clearRoleCache();
  resetBuildingCategoryColumnProbe();
  categoryColumn = true;
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  db.createRequestConnection.mockResolvedValue({});
  routeSql(db.executeQuery, [
    [/COL_LENGTH\('dbo\.Buildings', 'Category'\)/, () => [{ Len: categoryColumn ? 20 : null }]],
    [/FROM dbo\.ScheduleChangeRequests c/, (_params, sql) => rowsFor(sql, RELIEFS, (row) => Number(row.BuildingId))],
    [/WHERE r\.State = 'awaiting_approval'/, (_params, sql) => rowsFor(sql, REVIEWS, (row) => Number(row.BuildingId))],
    [/FROM dbo\.Tenants t\s+INNER JOIN \(/, (_params, sql) => rowsFor(sql, FIGURES, (row) => Number(row.BuildingId))],
    [/FROM dbo\.Tenants t/, () => []],
  ]);
});

const body = (res: { jsonBody?: unknown }) => res.jsonBody as Record<string, any>;
const sqlOf = (pattern: RegExp): string[] => db.executeQuery.mock.calls.map((call: unknown[]) => String(call[1])).filter((sql: string) => pattern.test(sql));

describe("getPortfolioOccupancy leaves the family's residences out of the company figures", () => {
  it("a residence's tenancy adds no rent, m², tenants or WALE", async () => {
    const res = await handlers.getPortfolioOccupancy(getRequest({}), ctx);
    expect(res.status).toBe(200);
    const { buildings } = body(res);
    expect(buildings.map((b: { buildingId: number }) => b.buildingId)).toEqual([COMMERCIAL_BUILDING]);
    const sum = (key: string) => buildings.reduce((total: number, b: Record<string, number>) => total + b[key], 0);
    expect(sum("annualRent")).toBe(100000);
    expect(sum("totalSqm")).toBe(100);
    expect(sum("activeTenantCount")).toBe(1);
    expect(sum("unsignedTenantCount")).toBe(1);
    expect(sum("waleExpirySqm")).toBe(100);
  });

  it("a residence's pending changes are in neither the building rows nor the total", async () => {
    const res = await handlers.getPortfolioOccupancy(getRequest({}), ctx);
    const { buildings, pendingChanges } = body(res);
    expect(buildings[0].pendingChangeCount).toBe(2);
    expect(pendingChanges.count).toBe(2);
    expect(pendingChanges.items.map((item: { requestId: string }) => item.requestId).sort()).toEqual(["req-commercial", "rev-commercial"]);
  });

  it("selects commercial buildings positively and never names a residence", async () => {
    await handlers.getPortfolioOccupancy(getRequest({}), ctx);
    const reads = sqlOf(/FROM dbo\.(Tenants t\s+INNER JOIN \(|ScheduleChangeRequests c|RentReviews r)/);
    expect(reads).toHaveLength(3);
    for (const sql of reads) {
      expect(sql).toMatch(COMMERCIAL_ONLY);
      expect(sql).not.toMatch(/residence|<>\s*N?'commercial'|!=\s*N?'commercial'/i);
    }
  });

  it("before migration 136 there is no Category to name: the figures read as they did, no residence can exist", async () => {
    categoryColumn = false;
    const res = await handlers.getPortfolioOccupancy(getRequest({}), ctx);
    expect(res.status).toBe(200);
    expect(body(res).buildings).toHaveLength(2);
    for (const sql of sqlOf(/FROM dbo\.(Tenants t\s+INNER JOIN \(|ScheduleChangeRequests c|RentReviews r)/)) expect(sql).not.toMatch(/Category/);
  });

  it("the check can fail: without the commercial fragment the fake hands back the residence's tenancy", () => {
    expect(rowsFor("SELECT 1 FROM dbo.Tenants t", FIGURES, (row) => Number(row.BuildingId))).toHaveLength(2);
  });
});

describe("operational reads still see a residence (U8)", () => {
  it("getReviewsDue does not filter by category", async () => {
    db.executeQuery.mockReset();
    db.executeQuery.mockResolvedValue([]);
    await handlers.getReviewsDue(getRequest({}), ctx);
    expect(sqlOf(/FROM dbo\.Tenants t/).length).toBeGreaterThan(0);
    for (const sql of sqlOf(/./)) expect(sql).not.toMatch(/Category/);
  });
});
