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

jest.mock("../rateLimit", () => ({
  checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }),
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
const rateLimit = require("../rateLimit") as { checkRateLimit: jest.Mock };

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
  cache.getCachedTenantList.mockReturnValue(null);
  cache.getCachedTenantDetail.mockReturnValue(null);
  planner.resolveActivePlannerTasks.mockResolvedValue(undefined);
  rateLimit.checkRateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
});

// ── Reusable fixtures ───────────────────────────────────────────────────────

const VALID_CARPARK_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
const VALID_GROUP_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const VALID_STEP_ID  = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function validCarparkBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    CarparkId: VALID_CARPARK_ID,
    BuildingId: 5,
    Type: "standard",
    Identifier: "B1-001",
    AllocationKind: "vacant",
    TenantId: null,
    RentPerAnnum: 1200,
    Comments: "first bay",
    ...over,
  };
}

function validGroupBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    TenantId: 1,
    BuildingId: 5,
    group: {
      id: VALID_GROUP_ID,
      label: "Lot A",
      carparkIds: [VALID_CARPARK_ID],
      baseMonthlyRate: 1000,
      commencedAt: "2026-07-01",
      rateSteps: [
        {
          id: VALID_STEP_ID,
          effectiveFrom: "2027-07-01",
          ratePercent: 5,
        },
      ],
    },
    ...over,
  };
}

// ── getCarparks ─────────────────────────────────────────────────────────────

describe("getCarparks", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.getCarparks(makeRequest(null, { buildingId: "5" }), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.getCarparks(makeRequest(null, { buildingId: "5" }), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 400 when buildingId is missing", async () => {
    const res = await handlers.getCarparks(makeRequest(null), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/buildingId required/);
  });

  it("returns 400 when buildingId is not numeric", async () => {
    const res = await handlers.getCarparks(makeRequest(null, { buildingId: "abc" }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns carparks on the happy path", async () => {
    db.executeQuery.mockResolvedValueOnce([
      {
        CarparkId: VALID_CARPARK_ID,
        BuildingId: 5,
        Type: "standard",
        Identifier: "B1-001",
        AllocationKind: "vacant",
        TenantId: null,
        RentPerAnnum: 1200,
        Comments: null,
        CreatedAt: new Date("2026-01-01"),
        UpdatedAt: new Date("2026-01-02"),
      },
    ]);
    const res = await handlers.getCarparks(makeRequest(null, { buildingId: "5" }), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { carparks: Array<{ carparkId: string; identifier: string }> };
    expect(body.carparks).toHaveLength(1);
    expect(body.carparks[0].carparkId).toBe(VALID_CARPARK_ID);
    expect(body.carparks[0].identifier).toBe("B1-001");
  });

  it("returns 500 when DB throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("connection lost"));
    const res = await handlers.getCarparks(makeRequest(null, { buildingId: "5" }), ctx);
    expect(res.status).toBe(500);
  });
});

// ── upsertCarpark ───────────────────────────────────────────────────────────

describe("upsertCarpark", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.upsertCarpark(makeRequest(validCarparkBody()), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.upsertCarpark(makeRequest(validCarparkBody()), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 400 when CarparkId is missing", async () => {
    const res = await handlers.upsertCarpark(makeRequest(validCarparkBody({ CarparkId: undefined })), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/CarparkId/);
  });

  it("returns 400 when BuildingId is missing", async () => {
    const res = await handlers.upsertCarpark(makeRequest(validCarparkBody({ BuildingId: undefined })), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/BuildingId/);
  });

  it("returns 400 when AllocationKind is invalid", async () => {
    const res = await handlers.upsertCarpark(makeRequest(validCarparkBody({ AllocationKind: "weird" })), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/AllocationKind/);
  });

  it("returns 400 when AllocationKind=tenant but TenantId missing", async () => {
    const res = await handlers.upsertCarpark(
      makeRequest(validCarparkBody({ AllocationKind: "tenant", TenantId: null })),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/TenantId required/);
  });

  it("inserts a new carpark when it does not yet exist", async () => {
    // SELECT TOP 1 → empty (no existing), INSERT, SELECT back
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          CarparkId: VALID_CARPARK_ID,
          BuildingId: 5,
          Type: "standard",
          Identifier: "B1-001",
          AllocationKind: "vacant",
          TenantId: null,
          RentPerAnnum: 1200,
          Comments: null,
          CreatedAt: new Date("2026-01-01"),
          UpdatedAt: new Date("2026-01-01"),
        },
      ]);
    const res = await handlers.upsertCarpark(makeRequest(validCarparkBody()), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { carpark: { carparkId: string } };
    expect(body.carpark.carparkId).toBe(VALID_CARPARK_ID);
    const insertCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("INSERT INTO dbo.Carparks"),
    );
    expect(insertCall).toBeDefined();
  });

  it("updates an existing carpark", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ CarparkId: VALID_CARPARK_ID }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          CarparkId: VALID_CARPARK_ID,
          BuildingId: 5,
          Type: "standard",
          Identifier: "B1-001",
          AllocationKind: "vacant",
          TenantId: null,
          RentPerAnnum: 1500,
          Comments: null,
          CreatedAt: new Date("2026-01-01"),
          UpdatedAt: new Date("2026-01-02"),
        },
      ]);
    const res = await handlers.upsertCarpark(makeRequest(validCarparkBody({ RentPerAnnum: 1500 })), ctx);
    expect(res.status).toBe(200);
    const updateCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("UPDATE dbo.Carparks"),
    );
    expect(updateCall).toBeDefined();
  });

  it("returns 500 when DB throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("boom"));
    const res = await handlers.upsertCarpark(makeRequest(validCarparkBody()), ctx);
    expect(res.status).toBe(500);
  });
});

// ── upsertCarparksBulk ──────────────────────────────────────────────────────

describe("upsertCarparksBulk", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.upsertCarparksBulk(makeRequest({ Carparks: [validCarparkBody()] }), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.upsertCarparksBulk(makeRequest({ Carparks: [validCarparkBody()] }), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 400 when Carparks is missing", async () => {
    const res = await handlers.upsertCarparksBulk(makeRequest({}), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/non-empty array/);
  });

  it("returns 400 when Carparks is not an array", async () => {
    const res = await handlers.upsertCarparksBulk(makeRequest({ Carparks: "not-an-array" }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns 400 when Carparks is an empty array", async () => {
    const res = await handlers.upsertCarparksBulk(makeRequest({ Carparks: [] }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns per-row results for a valid bulk insert", async () => {
    // Each upsertCarparkRow: SELECT TOP 1, INSERT/UPDATE, SELECT back ← 3 calls
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          CarparkId: VALID_CARPARK_ID,
          BuildingId: 5,
          Type: "standard",
          Identifier: "B1-001",
          AllocationKind: "vacant",
          TenantId: null,
          RentPerAnnum: 1200,
          Comments: null,
          CreatedAt: new Date(),
          UpdatedAt: new Date(),
        },
      ]);
    const res = await handlers.upsertCarparksBulk(
      makeRequest({ Carparks: [validCarparkBody()] }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as {
      results: Array<{ ok: boolean }>;
      successCount: number;
      failureCount: number;
    };
    expect(body.successCount).toBe(1);
    expect(body.failureCount).toBe(0);
    expect(body.results).toHaveLength(1);
  });

  it("records validation failures per-row without aborting the batch", async () => {
    // One valid + one invalid (missing CarparkId)
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          CarparkId: VALID_CARPARK_ID,
          BuildingId: 5,
          Type: "standard",
          Identifier: "B1-001",
          AllocationKind: "vacant",
          TenantId: null,
          RentPerAnnum: 1200,
          Comments: null,
          CreatedAt: new Date(),
          UpdatedAt: new Date(),
        },
      ]);
    const res = await handlers.upsertCarparksBulk(
      makeRequest({
        Carparks: [validCarparkBody(), validCarparkBody({ CarparkId: undefined, Identifier: "X" })],
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const body = res.jsonBody as {
      results: Array<{ ok: boolean; error?: string; identifier?: string }>;
      successCount: number;
      failureCount: number;
    };
    expect(body.successCount).toBe(1);
    expect(body.failureCount).toBe(1);
    expect(body.results[1].ok).toBe(false);
    expect(body.results[1].identifier).toBe("X");
  });

  it("returns 500 when request.json() itself throws", async () => {
    const req = makeRequest(null);
    (req.json as jest.Mock).mockRejectedValueOnce(new Error("parse failed"));
    const res = await handlers.upsertCarparksBulk(req, ctx);
    expect(res.status).toBe(500);
  });
});

// ── deleteCarpark ───────────────────────────────────────────────────────────

describe("deleteCarpark", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.deleteCarpark(makeRequest({ CarparkId: VALID_CARPARK_ID }), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.deleteCarpark(makeRequest({ CarparkId: VALID_CARPARK_ID }), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 400 when CarparkId is missing", async () => {
    const res = await handlers.deleteCarpark(makeRequest({}), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/CarparkId required/);
  });

  it("returns 400 when CarparkId is not a string", async () => {
    const res = await handlers.deleteCarpark(makeRequest({ CarparkId: 5 }), ctx);
    expect(res.status).toBe(400);
  });

  it("deletes a carpark on the happy path", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.deleteCarpark(makeRequest({ CarparkId: VALID_CARPARK_ID }), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { deleted: boolean; carparkId: string };
    expect(body.deleted).toBe(true);
    expect(body.carparkId).toBe(VALID_CARPARK_ID);
    const deleteCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("DELETE FROM dbo.Carparks"),
    );
    expect(deleteCall).toBeDefined();
  });

  it("returns 500 when DB throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("locked"));
    const res = await handlers.deleteCarpark(makeRequest({ CarparkId: VALID_CARPARK_ID }), ctx);
    expect(res.status).toBe(500);
  });
});

// ── upsertCarparkScheduleGroup ──────────────────────────────────────────────

describe("upsertCarparkScheduleGroup", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.upsertCarparkScheduleGroup(makeRequest(validGroupBody()), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.upsertCarparkScheduleGroup(makeRequest(validGroupBody()), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate-limited", async () => {
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    const res = await handlers.upsertCarparkScheduleGroup(makeRequest(validGroupBody()), ctx);
    expect(res.status).toBe(429);
    expect(res.headers?.["Retry-After"]).toBe("30");
  });

  it("returns 400 when envelope is missing TenantId", async () => {
    const res = await handlers.upsertCarparkScheduleGroup(
      makeRequest(validGroupBody({ TenantId: undefined })),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/TenantId/);
  });

  it("returns 400 when group is invalid (bad UUID)", async () => {
    const res = await handlers.upsertCarparkScheduleGroup(
      makeRequest(validGroupBody({
        group: {
          id: "not-a-uuid",
          label: "Lot A",
          carparkIds: [VALID_CARPARK_ID],
          baseMonthlyRate: 1000,
          commencedAt: "2026-07-01",
        },
      })),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/UUID/);
  });

  it("returns 404 when the tenant does not exist", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.upsertCarparkScheduleGroup(makeRequest(validGroupBody()), ctx);
    expect(res.status).toBe(404);
    expect((res.jsonBody as { error: string }).error).toMatch(/Tenant not found/);
  });

  it("upserts a new schedule group on the happy path", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ CarparkScheduleGroups: null }])
      .mockResolvedValueOnce([]);
    const res = await handlers.upsertCarparkScheduleGroup(makeRequest(validGroupBody()), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { groups: Array<{ id: string; label: string }> };
    expect(body.groups).toHaveLength(1);
    expect(body.groups[0].id).toBe(VALID_GROUP_ID);
    expect(body.groups[0].label).toBe("Lot A");
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
  });

  it("returns 500 when DB throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("network"));
    const res = await handlers.upsertCarparkScheduleGroup(makeRequest(validGroupBody()), ctx);
    expect(res.status).toBe(500);
  });
});

// ── deleteCarparkScheduleGroup ──────────────────────────────────────────────

describe("deleteCarparkScheduleGroup", () => {
  const validDeleteBody = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    TenantId: 1,
    BuildingId: 5,
    groupId: VALID_GROUP_ID,
    ...over,
  });

  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.deleteCarparkScheduleGroup(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.deleteCarparkScheduleGroup(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate-limited", async () => {
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    const res = await handlers.deleteCarparkScheduleGroup(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(429);
    expect(res.headers?.["Retry-After"]).toBe("30");
  });

  it("returns 400 when groupId is not UUID-shaped", async () => {
    const res = await handlers.deleteCarparkScheduleGroup(
      makeRequest(validDeleteBody({ groupId: "not-a-uuid" })),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/UUID/);
  });

  it("returns 400 when TenantId is missing", async () => {
    const res = await handlers.deleteCarparkScheduleGroup(
      makeRequest(validDeleteBody({ TenantId: undefined })),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when the tenant does not exist", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.deleteCarparkScheduleGroup(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(404);
    expect((res.jsonBody as { error: string }).error).toMatch(/Tenant not found/);
  });

  it("returns 404 when the group is not in the stored set", async () => {
    db.executeQuery.mockResolvedValueOnce([{ CarparkScheduleGroups: "[]" }]);
    const res = await handlers.deleteCarparkScheduleGroup(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(404);
    expect((res.jsonBody as { error: string }).error).toMatch(/Group not found/);
  });

  it("deletes the group on the happy path", async () => {
    const existingGroups = JSON.stringify([
      {
        id: VALID_GROUP_ID,
        label: "Lot A",
        carparkIds: [VALID_CARPARK_ID],
        baseMonthlyRate: 1000,
        commencedAt: "2026-07-01",
      },
    ]);
    db.executeQuery
      .mockResolvedValueOnce([{ CarparkScheduleGroups: existingGroups }])
      .mockResolvedValueOnce([]);
    const res = await handlers.deleteCarparkScheduleGroup(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { groups: unknown[] };
    expect(body.groups).toEqual([]);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
  });

  it("returns 500 when DB throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("network"));
    const res = await handlers.deleteCarparkScheduleGroup(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(500);
  });
});
