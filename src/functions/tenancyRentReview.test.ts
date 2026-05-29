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
  createConnection:    jest.fn(),
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
  createConnection:    jest.Mock;
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
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
  db.createConnection.mockResolvedValue({});
  db.closeConnection.mockImplementation(() => undefined);
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  cache.getCachedTenantList.mockReturnValue(null);
  cache.getCachedTenantDetail.mockReturnValue(null);
  planner.resolveActivePlannerTasks.mockResolvedValue(undefined);
});

// ── applyRentReview ─────────────────────────────────────────────────────────

describe("applyRentReview", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.applyRentReview(
      makeRequest({ ReviewId: "rev-1", NewRentPerAnnum: 60000 }),
      ctx,
    );
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.applyRentReview(
      makeRequest({ ReviewId: "rev-1", NewRentPerAnnum: 60000 }),
      ctx,
    );
    expect(res.status).toBe(403);
  });

  it("returns 400 when ReviewId is missing", async () => {
    const res = await handlers.applyRentReview(
      makeRequest({ NewRentPerAnnum: 60000 }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/ReviewId required/);
  });

  it("returns 400 when ReviewId is empty string", async () => {
    const res = await handlers.applyRentReview(
      makeRequest({ ReviewId: "", NewRentPerAnnum: 60000 }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/ReviewId required/);
  });

  it("returns 400 when NewRentPerAnnum is missing", async () => {
    const res = await handlers.applyRentReview(
      makeRequest({ ReviewId: "rev-1" }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/NewRentPerAnnum required/);
  });

  it("returns 400 when NewRentPerAnnum is not a number", async () => {
    const res = await handlers.applyRentReview(
      makeRequest({ ReviewId: "rev-1", NewRentPerAnnum: "60000" }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/NewRentPerAnnum required/);
  });

  it("returns 400 when NewRentPerAnnum is NaN", async () => {
    const res = await handlers.applyRentReview(
      makeRequest({ ReviewId: "rev-1", NewRentPerAnnum: Number.NaN }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/NewRentPerAnnum required/);
  });

  it("returns 404 when the review does not exist", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.applyRentReview(
      makeRequest({ ReviewId: "rev-missing", NewRentPerAnnum: 60000 }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect((res.jsonBody as { error: string }).error).toMatch(/Review not found/);
  });

  it("applies the rent review on the happy path", async () => {
    db.executeQuery
      .mockResolvedValueOnce([
        { ReviewId: "rev-1", TenantId: 7, RentPerAnnum: 50000, ReviewIntervalMonths: 12 },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await handlers.applyRentReview(
      makeRequest({ ReviewId: "rev-1", NewRentPerAnnum: 55000, Source: "manual" }),
      ctx,
    );

    expect(res.status).toBe(200);
    const body = res.jsonBody as {
      applied: boolean;
      increasePercent: number;
      nextReviewDate: string;
      reviewId: string;
      tenantId: number;
    };
    expect(body.applied).toBe(true);
    expect(body.reviewId).toBe("rev-1");
    expect(body.tenantId).toBe(7);
    expect(body.increasePercent).toBe(10);
    expect(body.nextReviewDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
    expect(cache.invalidateTenant).toHaveBeenCalledWith(7);
  });

  it("uses the supplied IncreasePercent when provided", async () => {
    db.executeQuery
      .mockResolvedValueOnce([
        { ReviewId: "rev-1", TenantId: 7, RentPerAnnum: 50000, ReviewIntervalMonths: 12 },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await handlers.applyRentReview(
      makeRequest({ ReviewId: "rev-1", NewRentPerAnnum: 55000, IncreasePercent: 4.25 }),
      ctx,
    );

    expect(res.status).toBe(200);
    const body = res.jsonBody as { increasePercent: number };
    expect(body.increasePercent).toBe(4.25);
  });

  it("fires planner resolve on success", async () => {
    db.executeQuery
      .mockResolvedValueOnce([
        { ReviewId: "rev-1", TenantId: 7, RentPerAnnum: 50000, ReviewIntervalMonths: 12 },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await handlers.applyRentReview(
      makeRequest({ ReviewId: "rev-1", NewRentPerAnnum: 55000 }),
      ctx,
    );

    expect(planner.resolveActivePlannerTasks).toHaveBeenCalledWith(
      "tenant",
      7,
      ["rent_review"],
    );
  });

  it("rolls back and returns 500 when the UPDATE inside the transaction throws", async () => {
    db.executeQuery
      .mockResolvedValueOnce([
        { ReviewId: "rev-1", TenantId: 7, RentPerAnnum: 50000, ReviewIntervalMonths: 12 },
      ])
      .mockRejectedValueOnce(new Error("update failed"));

    const res = await handlers.applyRentReview(
      makeRequest({ ReviewId: "rev-1", NewRentPerAnnum: 55000 }),
      ctx,
    );

    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(planner.resolveActivePlannerTasks).not.toHaveBeenCalled();
  });

  it("returns 500 when the initial SELECT throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("connection lost"));
    const res = await handlers.applyRentReview(
      makeRequest({ ReviewId: "rev-1", NewRentPerAnnum: 55000 }),
      ctx,
    );
    expect(res.status).toBe(500);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });
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
    expect(params).toEqual([]);
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
    expect(params).toHaveLength(1);
    expect(params[0].name).toBe("BuildingId");
    expect(params[0].value).toBe(9);
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
    ]);

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
    ]);

    const res = await handlers.getPortfolioOccupancy(makeRequest(null), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as {
      buildings: Array<{ occupancyPercent: number; waleYears: number }>;
    };
    expect(body.buildings[0].occupancyPercent).toBe(0);
    expect(body.buildings[0].waleYears).toBe(0);
  });

  it("returns an empty array when no buildings have tenants", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
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
