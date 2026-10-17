/// <reference types="jest" />
// WP26c: every read that returns rent carries pendingChanges { count, items }:
// the register list and getRegisterTenant (with who asked and why, and what is
// charged today under a ratified relief), the portfolio figures and the Next 90
// days feed (dates and names only), getRentReview's tenancy summary,
// getRentReviews and getScheduleChanges. Real handlers, real requireRole (dev
// role header), the database answered by SQL shape.
import type { HttpRequest, InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { addDaysIso, todayInDarwin } from "../darwinDate";
import { getRentReview } from "../functions/getRentReview";
import { getRentReviews } from "../functions/getRentReviews";
import { getScheduleChanges } from "../functions/getScheduleChanges";
import { getUpcomingLeaseEvents } from "../functions/getUpcomingLeaseEvents";
import { loadPendingChanges } from "../scheduleChange/pending";
import { getRequest, reviewRow, routeSql, tenancyRow, type Row } from "./fixtures/rentReviewFakes";

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  const bag = globalThis as unknown as { __pendingHandlers?: Record<string, unknown> };
  bag.__pendingHandlers = bag.__pendingHandlers ?? {};
  return { ...actual, app: { ...actual.app, http: (name: string, opts: { handler: unknown }) => ((bag.__pendingHandlers as Record<string, unknown>)[name] = opts.handler), timer: () => undefined } };
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
const handlers = (globalThis as unknown as { __pendingHandlers: Record<string, Handler> }).__pendingHandlers;
const db = require("../db") as { createRequestConnection: jest.Mock; executeQuery: jest.Mock };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const TODAY = todayInDarwin();
const DAY = (n: number) => addDaysIso(TODAY, n);
const RELIEF = { from: DAY(-10), kind: "percent", scope: ["rent"], to: DAY(20), value: 50 };
const changeRow = (over: Row = {}): Row => ({
  BuildingId: 5,
  Kind: "relief",
  LegalName: "Acme Pty Ltd",
  Payload: JSON.stringify({ ...RELIEF, from: DAY(30), to: DAY(60) }),
  Reason: "Fit-out works",
  RequestId: "req-1",
  RequestedAt: new Date("2026-10-01T01:00:00Z"),
  RequestedByName: "Ann Accounts",
  State: "pending",
  TenantId: 7,
  TradingName: null,
  ...over,
});
const awaiting = reviewRow({
  Calc: JSON.stringify({ currentAnnual: 100000, method: "fixed", newAnnual: 103000, scheduleVersion: 4 }),
  PreparedByName: "Ann Accounts",
  ReviewId: "rev-9",
  State: "awaiting_approval",
  SubmittedAt: new Date("2026-10-02T01:00:00Z"),
});
const steps = JSON.stringify([{ baseRentPerAnnum: 100000, effectiveFrom: DAY(-400), id: "aaaaaaaa-0000-4000-8000-000000000001", methodKind: "commencement", ratePercent: 0 }]);
const tenantColumns = (over: Row = {}): Row => ({ ...tenancyRow({ ScheduledRateSteps: steps }), CreatedAt: new Date(), RowVersion: Buffer.from("0000000000000a01", "hex"), UpdatedAt: new Date(), ...over });

let changes: Row[];
let reviews: Row[];
let tenantOver: Row;
beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  clearRoleCache();
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  db.createRequestConnection.mockResolvedValue({});
  changes = [changeRow()];
  reviews = [awaiting];
  tenantOver = {};
  routeSql(db.executeQuery, [
    [/FROM dbo\.ScheduleChangeRequests c/, () => changes],
    [/WHERE r\.State = 'awaiting_approval'/, () => reviews],
    // The register's tenant query carries a "FROM dbo.RentReviews rr" subquery, so it goes first.
    [/FROM dbo\.Tenants t WHERE (BuildingId|TenantId)/, () => [tenantColumns(tenantOver)]],
    [/FROM dbo\.RentReviews r\s/, () => [reviewRow({ ReviewId: "rev-1" })]],
    [/FROM dbo\.RentReviews\s+WHERE TenantId/, () => []],
    [/FROM dbo\.Tenants t\s+LEFT JOIN dbo\.Buildings/, () => [tenancyRow({ ScheduledRateSteps: steps, ...tenantOver })]],
    [/FROM dbo\.Tenants t\s+WHERE t\.Status <> 'vacated'/, () => []],
    [/FROM dbo\.Tenants t\s+INNER JOIN \(/, () => [{ ActiveSqm: 100, ActiveTenantCount: 1, AnnualRent: 100000, BuildingId: 5, TotalSqm: 100, UnsignedTenantCount: 0, WaleDenominatorSqm: 0, WaleNumeratorSqmDays: 0 }]],
    [/FROM dbo\.TenantOccupancies/, () => [{ Area: "1", BuildingId: 5, CreatedAt: new Date(), Level: "G", OccupancyId: "occ-1", SizeSqm: 100, Sqm: 100, TenantId: 7, UpdatedAt: new Date() }]],
    [/FROM dbo\.TenantNotes/, () => []],
    [/FROM dbo\.TenantOccupancyHistory/, () => []],
    [/FROM dbo\.RentScheduleChangeLog/, () => []],
    [/FROM dbo\.PlannerTasks/, () => []],
    [/FROM dbo\.CpiIndex/, () => []],
  ]);
});

const body = (res: { jsonBody?: unknown }) => res.jsonBody as Record<string, any>;
const ids = (pending: { items: Array<{ requestId: string }> }) => pending.items.map((item) => item.requestId);

describe("the pending loader", () => {
  it("reads relief requests and reviews awaiting approval, oldest date first, with who asked and why", async () => {
    const items = await loadPendingChanges({} as never, { tenantId: 7 }, "full");
    expect(items).toEqual([
      {
        buildingId: 5,
        from: awaiting.ScheduledFor instanceof Date ? (awaiting.ScheduledFor as Date).toISOString().slice(0, 10) : null,
        kind: "rent_review",
        reason: null,
        requestId: "rev-9",
        requestedAt: "2026-10-02T01:00:00.000Z",
        requestedByName: "Ann Accounts",
        summary: expect.stringMatching(/^Rent review \d\d\/\d\d\/\d{4}: \$100,000\.00 to \$103,000\.00 a year, awaiting approval$/),
        tenantId: 7,
        tenantName: "Acme Pty Ltd",
        to: null,
      },
      {
        buildingId: 5,
        from: DAY(30),
        kind: "relief",
        reason: "Fit-out works",
        requestId: "req-1",
        requestedAt: "2026-10-01T01:00:00.000Z",
        requestedByName: "Ann Accounts",
        summary: expect.stringMatching(/^Rent relief: 50% off the rent, /),
        tenantId: 7,
        tenantName: "Acme Pty Ltd",
        to: DAY(60),
      },
    ]);
  });

  it("gives dates and names only where the readers never see rent, and skips rows that aren't pending", async () => {
    reviews = [awaiting, reviewRow({ ReviewId: "rev-x", State: "in_progress" })];
    changes = [changeRow(), changeRow({ RequestId: "req-x", State: "ratified" })];
    const items = await loadPendingChanges({} as never, { all: true }, "dates_only");
    expect(items.map((item) => item.requestId)).toEqual(["rev-9", "req-1"]);
    for (const item of items) {
      expect(item.summary).not.toMatch(/\$|%/);
      expect(item).not.toHaveProperty("reason");
      expect(item).not.toHaveProperty("requestedByName");
    }
  });

  it("scopes the queries: one tenancy, a building (archived left out), or the portfolio (archived left out)", async () => {
    await loadPendingChanges({} as never, { tenantId: 7 }, "full");
    await loadPendingChanges({} as never, { buildingId: 5 }, "full");
    await loadPendingChanges({} as never, { all: true }, "full");
    const sqls = db.executeQuery.mock.calls.map((call) => String(call[1]));
    expect(sqls[0]).toMatch(/c\.TenantId = @TenantId$/);
    expect(sqls[1]).toMatch(/r\.TenantId = @TenantId$/);
    expect(sqls[2]).toMatch(/t\.BuildingId = @BuildingId AND t\.ArchivedAt IS NULL$/);
    expect(sqls[4]).toMatch(/AND t\.ArchivedAt IS NULL$/);
    expect(sqls[4]).not.toMatch(/@BuildingId|@TenantId/);
  });
});

describe("every read that returns rent says what is waiting", () => {
  it("getRegisterTenants: on the list and on each tenancy", async () => {
    const res = await handlers.getRegisterTenants(getRequest({ buildingId: "5" }), ctx);
    expect(res.status).toBe(200);
    expect(ids(body(res).pendingChanges)).toEqual(["rev-9", "req-1"]);
    expect(body(res).pendingChanges.count).toBe(2);
    expect(ids(body(res).tenants[0].pendingChanges)).toEqual(["rev-9", "req-1"]);
  });

  it("getRegisterTenant: with who asked and why, and what is charged today under a ratified relief", async () => {
    tenantOver = { RentReliefs: JSON.stringify([{ ...RELIEF, id: "rel-1" }]) };
    const res = await handlers.getRegisterTenant(getRequest({ tenantId: "7" }), ctx);
    expect(res.status).toBe(200);
    const tenant = body(res).tenant;
    expect(tenant.pendingChanges.items[1]).toMatchObject({ reason: "Fit-out works", requestedByName: "Ann Accounts" });
    expect(tenant.effectiveRentPerAnnum).toBe(100000);
    expect(tenant.chargedRentPerAnnum).toBe(50000);
    expect(tenant.activeReliefIds).toEqual(["rel-1"]);
    expect(tenant.rentReliefs).toEqual([{ ...RELIEF, id: "rel-1" }]);
  });

  it("getRegisterTenant: charges the lease's rent once a relief has ended", async () => {
    tenantOver = { RentReliefs: JSON.stringify([{ ...RELIEF, from: DAY(-30), id: "rel-old", to: DAY(-1) }]) };
    const tenant = body(await handlers.getRegisterTenant(getRequest({ tenantId: "7" }), ctx)).tenant;
    expect(tenant.chargedRentPerAnnum).toBe(100000);
    expect(tenant.activeReliefIds).toEqual([]);
  });

  it("getPortfolioOccupancy: per building and in all, dates and names only", async () => {
    const res = await handlers.getPortfolioOccupancy(getRequest({}), ctx);
    expect(res.status).toBe(200);
    expect(body(res).buildings[0].pendingChangeCount).toBe(2);
    expect(body(res).pendingChanges.count).toBe(2);
    expect(JSON.stringify(body(res).pendingChanges)).not.toMatch(/Fit-out|\$|%/);
  });

  it("getUpcomingLeaseEvents (the Next 90 days and its export): dates and names only", async () => {
    const res = await getUpcomingLeaseEvents(getRequest({}), ctx);
    expect(res.status).toBe(200);
    expect(ids(body(res).pendingChanges)).toEqual(["rev-9", "req-1"]);
    expect(JSON.stringify(body(res).pendingChanges)).not.toMatch(/Fit-out|\$|%/);
  });

  it("getRentReview: on the tenancy summary, with what is charged today", async () => {
    tenantOver = { RentReliefs: JSON.stringify([{ ...RELIEF, id: "rel-1" }]) };
    const res = await getRentReview(getRequest({ reviewId: "rev-1" }), ctx);
    expect(res.status).toBe(200);
    expect(ids(body(res).tenancy.pendingChanges)).toEqual(["rev-9", "req-1"]);
    expect(body(res).tenancy.chargedRentPerAnnum).toBe(body(res).tenancy.effectiveRentPerAnnum / 2);
  });

  it("getRentReviews and getScheduleChanges: for the scope asked about", async () => {
    expect(ids(body(await getRentReviews(getRequest({ tenantId: "7" }), ctx)).pendingChanges)).toEqual(["rev-9", "req-1"]);
    expect(ids(body(await getScheduleChanges(getRequest({ state: "pending" }), ctx)).pendingChanges)).toEqual(["rev-9", "req-1"]);
  });

  it("says nothing is waiting when nothing is", async () => {
    changes = [];
    reviews = [];
    expect(body(await handlers.getRegisterTenants(getRequest({ buildingId: "5" }), ctx)).pendingChanges).toEqual({ count: 0, items: [] });
    expect(body(await getUpcomingLeaseEvents(getRequest({}), ctx)).pendingChanges).toEqual({ count: 0, items: [] });
  });
});
