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
  closeConnection:  jest.Mock;
  createConnection: jest.Mock;
  executeQuery:     jest.Mock;
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
  db.createConnection.mockResolvedValue({});
  db.closeConnection.mockImplementation(() => undefined);
  cache.getCachedTenantList.mockReturnValue(null);
  cache.getCachedTenantDetail.mockReturnValue(null);
  planner.resolveActivePlannerTasks.mockResolvedValue(undefined);
});

// ── getRegisterTenants ──────────────────────────────────────────────────────

describe("getRegisterTenants", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.getRegisterTenants(makeRequest(null, { buildingId: "5" }), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.getRegisterTenants(makeRequest(null, { buildingId: "5" }), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 400 when buildingId is missing", async () => {
    const res = await handlers.getRegisterTenants(makeRequest(null), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/buildingId required/);
  });

  it("returns 400 when buildingId is not a number", async () => {
    const res = await handlers.getRegisterTenants(makeRequest(null, { buildingId: "abc" }), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/buildingId must be a number/);
  });

  it("returns the cached list when present", async () => {
    cache.getCachedTenantList.mockReturnValue({ tenants: [{ tenantId: 1 }] });
    const res = await handlers.getRegisterTenants(makeRequest(null, { buildingId: "5" }), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ tenants: [{ tenantId: 1 }] });
    expect(db.createConnection).not.toHaveBeenCalled();
  });

  it("short-circuits with empty array when no tenants exist", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.getRegisterTenants(makeRequest(null, { buildingId: "5" }), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ tenants: [] });
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });

  it("returns tenants with occupancies and note counts on the happy path", async () => {
    db.executeQuery
      .mockResolvedValueOnce([
        { TenantId: 1, BuildingId: 5, LegalName: "Acme Pty Ltd", Status: "active", RentPerAnnum: 50000 },
      ])
      .mockResolvedValueOnce([
        { OccupancyId: "occ-1", TenantId: 1, BuildingId: 5, Level: "G", Area: "1", SizeSqm: 100 },
      ])
      .mockResolvedValueOnce([
        { TenantId: 1, AnchorKind: "tenant", OccupancyId: "", FieldKey: "", Cnt: 2 },
      ]);

    const res = await handlers.getRegisterTenants(makeRequest(null, { buildingId: "5" }), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { tenants: Array<{ tenantId: number; occupancies: unknown[]; noteCountByAnchor: Record<string, number> }> };
    expect(body.tenants).toHaveLength(1);
    expect(body.tenants[0].tenantId).toBe(1);
    expect(body.tenants[0].occupancies).toHaveLength(1);
    expect(body.tenants[0].noteCountByAnchor.tenant).toBe(2);
  });

  it("returns 500 when a DB query throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("connection lost"));
    const res = await handlers.getRegisterTenants(makeRequest(null, { buildingId: "5" }), ctx);
    expect(res.status).toBe(500);
  });
});

// ── getRegisterTenant ───────────────────────────────────────────────────────

describe("getRegisterTenant", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.getRegisterTenant(makeRequest(null, { tenantId: "1" }), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.getRegisterTenant(makeRequest(null, { tenantId: "1" }), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 400 when tenantId is missing", async () => {
    const res = await handlers.getRegisterTenant(makeRequest(null), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when tenantId is not a number", async () => {
    const res = await handlers.getRegisterTenant(makeRequest(null, { tenantId: "abc" }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns the cached detail when present", async () => {
    cache.getCachedTenantDetail.mockReturnValue({ tenant: { tenantId: 1 } });
    const res = await handlers.getRegisterTenant(makeRequest(null, { tenantId: "1" }), ctx);
    expect(res.status).toBe(200);
    expect(db.createConnection).not.toHaveBeenCalled();
  });

  it("returns 404 when the tenant does not exist", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.getRegisterTenant(makeRequest(null, { tenantId: "1" }), ctx);
    expect(res.status).toBe(404);
  });

  it("returns full tenant detail on the happy path", async () => {
    db.executeQuery
      .mockResolvedValueOnce([
        { TenantId: 1, BuildingId: 5, LegalName: "Acme", TradingName: "Acme Trading", Status: "active" },
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await handlers.getRegisterTenant(makeRequest(null, { tenantId: "1" }), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { tenant: { tenantId: number; notes: unknown[]; reviews: unknown[]; plannerTasks: unknown[] } };
    expect(body.tenant.tenantId).toBe(1);
    expect(body.tenant.notes).toEqual([]);
    expect(body.tenant.plannerTasks).toEqual([]);
  });

  it("returns 500 when a DB query throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("boom"));
    const res = await handlers.getRegisterTenant(makeRequest(null, { tenantId: "1" }), ctx);
    expect(res.status).toBe(500);
  });
});

// ── upsertRegisterTenant ────────────────────────────────────────────────────

describe("upsertRegisterTenant", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.upsertRegisterTenant(makeRequest({ LegalName: "Acme", BuildingId: 5 }), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.upsertRegisterTenant(makeRequest({ LegalName: "Acme", BuildingId: 5 }), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 400 on create when LegalName is missing", async () => {
    const res = await handlers.upsertRegisterTenant(makeRequest({ BuildingId: 5 }), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/LegalName/);
  });

  it("returns 400 on create when LegalName is blank", async () => {
    const res = await handlers.upsertRegisterTenant(makeRequest({ LegalName: "   ", BuildingId: 5 }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 on create when BuildingId is missing", async () => {
    const res = await handlers.upsertRegisterTenant(makeRequest({ LegalName: "Acme" }), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/BuildingId/);
  });

  it("returns 400 on update when LegalName is explicitly blanked", async () => {
    const res = await handlers.upsertRegisterTenant(makeRequest({ TenantId: 1, LegalName: "" }), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/cannot be empty/);
  });

  it("creates a tenant on the happy path (INSERT + SELECT back)", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ TenantId: 42 }])
      .mockResolvedValueOnce([
        { TenantId: 42, BuildingId: 5, LegalName: "Acme", Status: "active" },
      ]);

    const res = await handlers.upsertRegisterTenant(
      makeRequest({ LegalName: "Acme", BuildingId: 5 }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as { tenant: { tenantId: number } };
    expect(body.tenant.tenantId).toBe(42);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(42, 5);

    const insertCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("INSERT INTO dbo.Tenants"),
    );
    expect(insertCall).toBeDefined();
  });

  it("updates an existing tenant on the happy path", async () => {
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { TenantId: 7, BuildingId: 3, LegalName: "Renamed", Status: "active" },
      ]);

    const res = await handlers.upsertRegisterTenant(
      makeRequest({ TenantId: 7, LegalName: "Renamed", Status: "active" }),
      ctx,
    );
    expect(res.status).toBe(200);
    const updateCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("UPDATE dbo.Tenants"),
    );
    expect(updateCall).toBeDefined();
  });

  it("returns 404 when the tenant disappears after upsert", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ TenantId: 99 }])
      .mockResolvedValueOnce([]);

    const res = await handlers.upsertRegisterTenant(
      makeRequest({ LegalName: "Acme", BuildingId: 5 }),
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("fires planner resolve when Status becomes vacated", async () => {
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { TenantId: 7, BuildingId: 3, LegalName: "Acme", Status: "vacated" },
      ]);

    await handlers.upsertRegisterTenant(
      makeRequest({ TenantId: 7, Status: "vacated" }),
      ctx,
    );
    expect(planner.resolveActivePlannerTasks).toHaveBeenCalledWith(
      "tenant",
      7,
      ["lease_expiry", "option_notice"],
    );
  });

  it("fires planner resolve when Expiry is supplied", async () => {
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { TenantId: 7, BuildingId: 3, LegalName: "Acme", Status: "active", Expiry: new Date("2027-06-30") },
      ]);

    await handlers.upsertRegisterTenant(
      makeRequest({ TenantId: 7, Expiry: "2027-06-30" }),
      ctx,
    );
    expect(planner.resolveActivePlannerTasks).toHaveBeenCalled();
  });

  it("does NOT fire planner resolve on a plain update", async () => {
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { TenantId: 7, BuildingId: 3, LegalName: "Acme", Status: "active" },
      ]);

    await handlers.upsertRegisterTenant(
      makeRequest({ TenantId: 7, Comments: "just updating a note" }),
      ctx,
    );
    expect(planner.resolveActivePlannerTasks).not.toHaveBeenCalled();
  });

  it("returns 500 when INSERT throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("constraint violated"));
    const res = await handlers.upsertRegisterTenant(
      makeRequest({ LegalName: "Acme", BuildingId: 5 }),
      ctx,
    );
    expect(res.status).toBe(500);
  });
});

// ── deleteRegisterTenant ────────────────────────────────────────────────────

describe("deleteRegisterTenant", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.deleteRegisterTenant(makeRequest({ TenantId: 1 }), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.deleteRegisterTenant(makeRequest({ TenantId: 1 }), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 400 when TenantId is missing", async () => {
    const res = await handlers.deleteRegisterTenant(makeRequest({}), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when TenantId is not a number", async () => {
    const res = await handlers.deleteRegisterTenant(makeRequest({ TenantId: "1" }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when the tenant is referenced by a job", async () => {
    db.executeQuery.mockResolvedValueOnce([{ N: 2 }]);
    const res = await handlers.deleteRegisterTenant(makeRequest({ TenantId: 1 }), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/Reassign first/);
  });

  it("deletes the tenant when no jobs reference it", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ N: 0 }])
      .mockResolvedValueOnce([]);

    const res = await handlers.deleteRegisterTenant(makeRequest({ TenantId: 1 }), ctx);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { deleted: boolean }).deleted).toBe(true);
    expect(cache.invalidateTenant).toHaveBeenCalledWith(1);

    const deleteCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("DELETE FROM dbo.Tenants"),
    );
    expect(deleteCall).toBeDefined();
  });

  it("returns 500 when DELETE throws", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ N: 0 }])
      .mockRejectedValueOnce(new Error("locked"));
    const res = await handlers.deleteRegisterTenant(makeRequest({ TenantId: 1 }), ctx);
    expect(res.status).toBe(500);
  });
});
