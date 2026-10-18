/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

type Handler = (
  req: HttpRequest,
  ctx: InvocationContext,
) => Promise<{ status: number; jsonBody?: unknown; headers?: Record<string, string> }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  type Bag = { __tenancyHandlers?: Record<string, Handler> };
  const g = globalThis as unknown as Bag;
  g.__tenancyHandlers = g.__tenancyHandlers ?? {};
  return {
    ...actual,
    app: {
      ...actual.app,
      http: (name: string, opts: { handler: Handler }): void => {
        (g.__tenancyHandlers as Record<string, Handler>)[name] = opts.handler;
      },
    },
  };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    extractToken:         jest.fn().mockReturnValue("mock-token"),
    requireRole:          jest.fn().mockResolvedValue(null),
    oidFromToken:         jest.fn().mockReturnValue("caller-oid-123"),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    errorResponse:        jest.fn().mockImplementation((msg: string, detail: string) => ({
      status: 500,
      jsonBody: { error: msg, detail },
    })),
  };
});

jest.mock("../db", () => ({
  beginTransaction:    jest.fn().mockResolvedValue(undefined),
  closeConnection:     jest.fn(),
  commitTransaction:   jest.fn().mockResolvedValue(undefined),
  createRequestConnection:    jest.fn(),
  executeQuery:        jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../tenant-register-cache", () => ({
  getCachedTenantList:         jest.fn().mockReturnValue(null),
  setCachedTenantList:         jest.fn(),
  getCachedTenantDetail:       jest.fn().mockReturnValue(null),
  setCachedTenantDetail:       jest.fn(),
  invalidateTenant:            jest.fn(),
  invalidateTenantAndBuilding: jest.fn(),
}));

jest.mock("../planner", () => ({
  resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined),
}));

// Ledger rows are asserted on the mock, never stored (PLAN WP19b owns storage).
jest.mock("../ledger");
jest.mock("../ledger/actor", () => ({
  resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Test User", role: "accounts", userId: 7 }),
}));

const auth = require("../auth") as {
  extractToken:         jest.Mock;
  requireRole:          jest.Mock;
  oidFromToken:         jest.Mock;
  unauthorizedResponse: jest.Mock;
};
const db = require("../db") as {
  beginTransaction:    jest.Mock;
  closeConnection:     jest.Mock;
  commitTransaction:   jest.Mock;
  createRequestConnection:    jest.Mock;
  executeQuery:        jest.Mock;
  rollbackTransaction: jest.Mock;
};
const cache = require("../tenant-register-cache") as {
  getCachedTenantList:         jest.Mock;
  getCachedTenantDetail:       jest.Mock;
  invalidateTenant:            jest.Mock;
  invalidateTenantAndBuilding: jest.Mock;
};
const planner = require("../planner") as {
  resolveActivePlannerTasks: jest.Mock;
};

// Trigger the module's app.http registrations so the mock above captures
// every handler by name.
require("./tenancy");
const handlers = (globalThis as unknown as { __tenancyHandlers: Record<string, Handler> }).__tenancyHandlers;

function makeRequest(
  body: unknown,
  query: Record<string, string> = {},
  headers: Record<string, string> = {},
): HttpRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
    query: {
      get: (k: string): string | null => query[k] ?? null,
    },
    headers: { get: (k: string): string | null => headers[k.toLowerCase()] ?? null },
  } as unknown as HttpRequest;
}

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  auth.oidFromToken.mockReturnValue("caller-oid-123");
  auth.unauthorizedResponse.mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } });
  db.createRequestConnection.mockResolvedValue({});
  db.closeConnection.mockImplementation(() => undefined);
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  cache.getCachedTenantList.mockReturnValue(null);
  cache.getCachedTenantDetail.mockReturnValue(null);
  planner.resolveActivePlannerTasks.mockResolvedValue(undefined);
});

// ── getReviewsDue ───────────────────────────────────────────────────────────

describe("getReviewsDue", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.getReviewsDue(makeRequest(null), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.getReviewsDue(makeRequest(null), ctx);
    expect(res.status).toBe(403);
  });

  it("returns tenants on the happy path without a buildingId", async () => {
    db.executeQuery.mockResolvedValueOnce([
      { TenantId: 1, BuildingId: 5, LegalName: "Acme Pty Ltd", Status: "current", NextReviewDate: new Date("2026-07-01") },
    ]);

    const res = await handlers.getReviewsDue(makeRequest(null), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { tenants: unknown[] };
    expect(Array.isArray(body.tenants)).toBe(true);
    expect(body.tenants).toHaveLength(1);

    const [, sql, params] = db.executeQuery.mock.calls[0] as [unknown, string, unknown[]];
    expect(sql).toContain("NextReviewDate");
    expect(sql).not.toContain("WHERE BuildingId = @BuildingId");
    // Only the Show test data toggle (D9), off.
    expect(params).toEqual([expect.objectContaining({ name: "ShowTest", value: false })]);
  });

  it("filters by buildingId when supplied", async () => {
    db.executeQuery.mockResolvedValueOnce([
      { TenantId: 2, BuildingId: 9, LegalName: "Beta", Status: "current", NextReviewDate: new Date("2026-07-01") },
    ]);

    const res = await handlers.getReviewsDue(
      makeRequest(null, { buildingId: "9" }),
      ctx,
    );
    expect(res.status).toBe(200);

    const [, sql, params] = db.executeQuery.mock.calls[0] as [
      unknown,
      string,
      Array<{ name: string; value: unknown }>,
    ];
    expect(sql).toContain("WHERE BuildingId = @BuildingId");
    expect(params).toHaveLength(2);
    expect(params[0].name).toBe("BuildingId");
    expect(params[0].value).toBe(9);
  });

  it("leaves out a tenancy whose keyed review has since passed and moved on", async () => {
    const keyed = JSON.stringify([
      { baseRentPerAnnum: 100000, effectiveFrom: "2020-07-01", id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", methodKind: "commencement", ratePercent: 0 },
      { effectiveFrom: "2021-07-01", id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", methodKind: "fixed", ratePercent: 3 },
      { effectiveFrom: "2099-07-01", id: "cccccccc-cccc-cccc-cccc-cccccccccccc", methodKind: "fixed", ratePercent: 3 },
    ]);
    db.executeQuery.mockResolvedValueOnce([
      { TenantId: 1, BuildingId: 5, LegalName: "Keyed Ahead", Status: "current", NextReviewDate: new Date("2021-07-01"), ScheduledRateSteps: keyed },
      { TenantId: 2, BuildingId: 5, LegalName: "Overdue", Status: "current", NextReviewDate: new Date("2021-07-01") },
    ]);
    const res = await handlers.getReviewsDue(makeRequest(undefined), ctx);
    const { tenants } = res.jsonBody as { tenants: Array<{ legalName: string }> };
    expect(tenants.map((tenant) => tenant.legalName)).toEqual(["Overdue"]);
  });

  describe("lease events", () => {
    const { addDaysIso, todayInDarwin } = require("../darwinDate") as {
      addDaysIso: (iso: string, days: number) => string;
      todayInDarwin: () => string;
    };
    const inDays = (days: number) => new Date(`${addDaysIso(todayInDarwin(), days)}T00:00:00Z`);

    it("also asks the database for expiries and option deadlines in the next 90 days", async () => {
      db.executeQuery.mockResolvedValueOnce([]);
      await handlers.getReviewsDue(makeRequest(null), ctx);
      const [, sql] = db.executeQuery.mock.calls[0] as [unknown, string];
      expect(sql).toContain("NextReviewDate");
      expect(sql).toContain("Expiry");
      expect(sql).toContain("OptionNoticeMonths");
      expect(sql).toContain("DATEADD(month");
      expect(sql).toContain("Status <> 'vacated'");
    });

    it("keeps the building filter in front of the lease-event conditions", async () => {
      db.executeQuery.mockResolvedValueOnce([]);
      await handlers.getReviewsDue(makeRequest(null, { buildingId: "9" }), ctx);
      const [, sql] = db.executeQuery.mock.calls[0] as [unknown, string];
      expect(sql).toContain("WHERE BuildingId = @BuildingId AND");
    });

    it("returns a lease that expires in 45 days although its next review is a year away", async () => {
      db.executeQuery.mockResolvedValueOnce([
        { TenantId: 1, BuildingId: 5, LegalName: "Expiring Soon", Status: "current", Expiry: inDays(45), NextReviewDate: inDays(365) },
      ]);
      const res = await handlers.getReviewsDue(makeRequest(null), ctx);
      const { tenants } = res.jsonBody as { tenants: Array<{ legalName: string; daysToExpiry: number }> };
      expect(tenants.map((tenant) => tenant.legalName)).toEqual(["Expiring Soon"]);
      expect(tenants[0].daysToExpiry).toBe(45);
    });

    it("returns a lease whose option deadline is 20 days away", async () => {
      db.executeQuery.mockResolvedValueOnce([
        {
          TenantId: 2, BuildingId: 5, LegalName: "Option Deadline", Status: "current",
          Expiry: inDays(20 + 91), OptionNoticeMonths: 3, NextReviewDate: inDays(400),
        },
      ]);
      const res = await handlers.getReviewsDue(makeRequest(null), ctx);
      const { tenants } = res.jsonBody as { tenants: Array<{ legalName: string }> };
      expect(tenants.map((tenant) => tenant.legalName)).toEqual(["Option Deadline"]);
    });

    it("leaves out a lease with nothing due in the window", async () => {
      db.executeQuery.mockResolvedValueOnce([
        { TenantId: 3, BuildingId: 5, LegalName: "Far Off", Status: "current", Expiry: inDays(400), NextReviewDate: inDays(400) },
        { TenantId: 4, BuildingId: 5, LegalName: "Expired Long Ago", Status: "holdover", Expiry: inDays(-200), NextReviewDate: inDays(400) },
      ]);
      const res = await handlers.getReviewsDue(makeRequest(null), ctx);
      expect((res.jsonBody as { tenants: unknown[] }).tenants).toEqual([]);
    });

    it("still returns an overdue review that has no expiry", async () => {
      db.executeQuery.mockResolvedValueOnce([
        { TenantId: 5, BuildingId: 5, LegalName: "Overdue Review", Status: "current", NextReviewDate: inDays(-10) },
      ]);
      const res = await handlers.getReviewsDue(makeRequest(null), ctx);
      const { tenants } = res.jsonBody as { tenants: Array<{ legalName: string }> };
      expect(tenants.map((tenant) => tenant.legalName)).toEqual(["Overdue Review"]);
    });
  });

  it("returns an empty list when no tenants are due", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.getReviewsDue(makeRequest(null), ctx);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { tenants: unknown[] }).tenants).toEqual([]);
  });

  it("returns 500 when the DB query throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("boom"));
    const res = await handlers.getReviewsDue(makeRequest(null), ctx);
    expect(res.status).toBe(500);
  });
});

// ── getPortfolioOccupancy ───────────────────────────────────────────────────

describe("getPortfolioOccupancy", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.getPortfolioOccupancy(makeRequest(null), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.getPortfolioOccupancy(makeRequest(null), ctx);
    expect(res.status).toBe(403);
  });

  it("returns a building summary on the happy path", async () => {
    db.executeQuery.mockResolvedValueOnce([
      {
        BuildingId: 5,
        ActiveSqm: 800,
        TotalSqm: 1000,
        AnnualRent: 250000,
        ActiveTenantCount: 4,
        WaleNumeratorSqmDays: 800 * 365 * 3,
        WaleDenominatorSqm: 800,
      },
    ]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const res = await handlers.getPortfolioOccupancy(makeRequest(null), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as {
      buildings: Array<{
        activeSqm: number;
        activeTenantCount: number;
        annualRent: number;
        buildingId: number;
        occupancyPercent: number;
        totalSqm: number;
        waleExpirySqm: number;
        waleYears: number;
      }>;
    };
    expect(body.buildings).toHaveLength(1);
    const b = body.buildings[0];
    expect(b.buildingId).toBe(5);
    expect(b.activeSqm).toBe(800);
    expect(b.totalSqm).toBe(1000);
    expect(b.annualRent).toBe(250000);
    expect(b.activeTenantCount).toBe(4);
    expect(b.occupancyPercent).toBeCloseTo(80, 5);
    expect(b.waleExpirySqm).toBe(800);
    expect(b.waleYears).toBeGreaterThan(2.9);
    expect(b.waleYears).toBeLessThan(3.1);
  });

  it("returns zeros when a building has no SQM", async () => {
    db.executeQuery.mockResolvedValueOnce([
      {
        BuildingId: 6,
        ActiveSqm: 0,
        TotalSqm: 0,
        AnnualRent: 0,
        ActiveTenantCount: 0,
        WaleNumeratorSqmDays: 0,
        WaleDenominatorSqm: 0,
      },
    ]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);

    const res = await handlers.getPortfolioOccupancy(makeRequest(null), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as {
      buildings: Array<{ occupancyPercent: number; waleYears: number }>;
    };
    expect(body.buildings[0].occupancyPercent).toBe(0);
    expect(body.buildings[0].waleYears).toBe(0);
  });

  it("returns an empty array when no buildings have tenants", async () => {
    db.executeQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await handlers.getPortfolioOccupancy(makeRequest(null), ctx);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { buildings: unknown[] }).buildings).toEqual([]);
  });

  it("returns 500 when the DB query throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("connection lost"));
    const res = await handlers.getPortfolioOccupancy(makeRequest(null), ctx);
    expect(res.status).toBe(500);
  });
});
