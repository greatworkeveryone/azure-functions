/// <reference types="jest" />
// D10 review: archived areas stay out of the figures, not only out of the SQL
// text. Real handlers; the database is a fake that applies what each query says
// about archived areas (fixtures/archivedPartReads), so a query that forgets its
// own filter hands the handler the archived area and the figures go wrong.
import type { HttpRequest, InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { sqlFiltersArchived } from "./fixtures/archivedPartReads";
import { getRequest, routeSql, tenancyRow, type Row } from "./fixtures/rentReviewFakes";

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  const bag = globalThis as unknown as { __figuresHandlers?: Record<string, unknown> };
  bag.__figuresHandlers = bag.__figuresHandlers ?? {};
  return { ...actual, app: { ...actual.app, http: (name: string, opts: { handler: unknown }) => ((bag.__figuresHandlers as Record<string, unknown>)[name] = opts.handler), timer: () => undefined } };
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
const handlers = (globalThis as unknown as { __figuresHandlers: Record<string, Handler> }).__figuresHandlers;
const db = require("../db") as { createRequestConnection: jest.Mock; executeQuery: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const RENT = 120000;
const area = (id: string, sqm: number, archivedAt: Date | null): Row => ({
  Area: id,
  ArchivedAt: archivedAt,
  ArchiveReason: archivedAt ? "Merged into Suite 1" : null,
  ArchivedBy: archivedAt ? "Ann Accounts" : null,
  BuildingId: 5,
  CreatedAt: new Date("2026-01-01T00:00:00Z"),
  Level: "G",
  Notes: null,
  OccupancyId: id,
  SizeSqm: sqm,
  TenantId: 7,
  UpdatedAt: new Date("2026-01-01T00:00:00Z"),
});
const AREAS = [area("occ-live", 100, null), area("occ-archived", 50, new Date("2026-10-01T00:00:00Z"))];
const areasFor = (sql: string) => (sqlFiltersArchived(sql, "TenantOccupancies") ? AREAS.filter((row) => row.ArchivedAt === null) : AREAS);
const sqmOf = (rows: Row[]) => rows.reduce((sum, row) => sum + Number(row.SizeSqm), 0);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  db.createRequestConnection.mockResolvedValue({});
  routeSql(db.executeQuery, [
    [/FROM dbo\.ScheduleChangeRequests c/, () => []],
    [/WHERE r\.State = 'awaiting_approval'/, () => []],
    // The portfolio figures: summed over whatever areas the occupancy subquery lets in.
    [/FROM dbo\.Tenants t\s+INNER JOIN \(/, (_params, sql) => {
      const sqm = sqmOf(areasFor(sql));
      return [{ ActiveSqm: sqm, ActiveTenantCount: 1, AnnualRent: RENT, BuildingId: 5, TotalSqm: sqm, UnsignedTenantCount: 0, WaleDenominatorSqm: 0, WaleNumeratorSqmDays: 0 }];
    }],
    [/FROM dbo\.TenantOccupancies/, (_params, sql) => areasFor(sql)],
    [/FROM dbo\.Tenants t WHERE BuildingId/, () => [tenancyRow({ CreatedAt: new Date(), RentPerAnnum: RENT, RowVersion: Buffer.from("0000000000000a01", "hex"), UpdatedAt: new Date() })]],
    [/FROM dbo\.TenantNotes/, () => []],
  ]);
});

const register = async (query: Record<string, string>) =>
  (await handlers.getRegisterTenants(getRequest({ buildingId: "5", ...query }), ctx)).jsonBody as { tenants: Array<Record<string, any>> };

describe("archived areas stay out of the figures (D10 review)", () => {
  it("the register: size and rent per m² count live areas only", async () => {
    const [tenant] = (await register({})).tenants;
    expect(tenant.occupancies.map((o: { occupancyId: string }) => o.occupancyId)).toEqual(["occ-live"]);
    expect(tenant.totalSizeSqm).toBe(100);
    expect(tenant.costPerSqm).toBe(RENT / 100);
  });

  it("the register's Show archived view lists the archived area but still counts live areas only", async () => {
    const [tenant] = (await register({ includeArchived: "true" })).tenants;
    expect(tenant.occupancies.map((o: { occupancyId: string }) => o.occupancyId).sort()).toEqual(["occ-archived", "occ-live"]);
    expect(tenant.totalSizeSqm).toBe(100);
    expect(tenant.costPerSqm).toBe(RENT / 100);
  });

  it("the portfolio figures: total and active m² leave the archived area out", async () => {
    const res = await handlers.getPortfolioOccupancy(getRequest({}), ctx);
    const [building] = (res.jsonBody as { buildings: Array<Record<string, number>> }).buildings;
    expect(building.totalSqm).toBe(100);
    expect(building.occupancyPercent).toBe(100);
  });
});
