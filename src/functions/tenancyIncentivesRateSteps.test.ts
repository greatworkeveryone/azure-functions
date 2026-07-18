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

// ── Shared envelope fixtures ────────────────────────────────────────────────

const INCENTIVE_ID = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const STEP_ID      = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";

function validIncentiveEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    BuildingId: 5,
    TenantId: 1,
    incentive: {
      freeMonthsFromStart: 3,
      id: INCENTIVE_ID,
      kind: "rentFreeMonths",
      note: "Three months free",
    },
    ...overrides,
  };
}

function validStepEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    BuildingId: 5,
    TenantId: 1,
    step: {
      effectiveFrom: "2026-07-01",
      id: STEP_ID,
      ratePercent: 5,
    },
    ...overrides,
  };
}

// ── upsertTenantIncentive ───────────────────────────────────────────────────

describe("upsertTenantIncentive", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.upsertTenantIncentive(makeRequest(validIncentiveEnvelope()), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.upsertTenantIncentive(makeRequest(validIncentiveEnvelope()), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limit is exceeded", async () => {
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    const res = await handlers.upsertTenantIncentive(makeRequest(validIncentiveEnvelope()), ctx);
    expect(res.status).toBe(429);
    expect(res.headers?.["Retry-After"]).toBe("30");
  });

  it("returns 400 when TenantId is missing", async () => {
    const body = validIncentiveEnvelope();
    delete (body as Record<string, unknown>).TenantId;
    const res = await handlers.upsertTenantIncentive(makeRequest(body), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/TenantId/);
  });

  it("returns 400 when the incentive id is not UUID-shaped", async () => {
    const res = await handlers.upsertTenantIncentive(
      makeRequest(validIncentiveEnvelope({
        incentive: {
          freeMonthsFromStart: 3,
          id: "not-a-uuid",
          kind: "rentFreeMonths",
        },
      })),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/UUID/);
  });

  it("returns 404 when the tenant is not found", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.upsertTenantIncentive(makeRequest(validIncentiveEnvelope()), ctx);
    expect(res.status).toBe(404);
    expect((res.jsonBody as { error: string }).error).toMatch(/Tenant not found/);
  });

  it("upserts and returns the reloaded tenant on the happy path", async () => {
    db.executeQuery
      // loadTenantIncentives — SELECT Incentives
      .mockResolvedValueOnce([{ Incentives: null }])
      // UPDATE dbo.Tenants
      .mockResolvedValueOnce([])
      // reloadFullTenant — tenant row
      .mockResolvedValueOnce([
        { TenantId: 1, BuildingId: 5, LegalName: "Acme", Status: "active" },
      ])
      // reloadFullTenant — occupancies
      .mockResolvedValueOnce([]);

    const res = await handlers.upsertTenantIncentive(makeRequest(validIncentiveEnvelope()), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { tenant: { tenantId: number } };
    expect(body.tenant.tenantId).toBe(1);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
  });

  it("returns 500 when the UPDATE throws", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ Incentives: null }])
      .mockRejectedValueOnce(new Error("constraint violated"));
    const res = await handlers.upsertTenantIncentive(makeRequest(validIncentiveEnvelope()), ctx);
    expect(res.status).toBe(500);
  });
});

// ── deleteTenantIncentive ───────────────────────────────────────────────────

describe("deleteTenantIncentive", () => {
  const validDeleteBody = (): Record<string, unknown> => ({
    BuildingId: 5,
    TenantId: 1,
    incentiveId: INCENTIVE_ID,
  });

  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.deleteTenantIncentive(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.deleteTenantIncentive(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limit is exceeded", async () => {
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    const res = await handlers.deleteTenantIncentive(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(429);
    expect(res.headers?.["Retry-After"]).toBe("30");
  });

  it("returns 400 when incentiveId is not UUID-shaped", async () => {
    const body = validDeleteBody();
    body.incentiveId = "nope";
    const res = await handlers.deleteTenantIncentive(makeRequest(body), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/incentiveId/);
  });

  it("returns 404 when the tenant is not found", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.deleteTenantIncentive(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(404);
    expect((res.jsonBody as { error: string }).error).toMatch(/Tenant not found/);
  });

  it("returns 404 when the incentive id is not present on the tenant", async () => {
    db.executeQuery.mockResolvedValueOnce([{ Incentives: JSON.stringify([]) }]);
    const res = await handlers.deleteTenantIncentive(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(404);
    expect((res.jsonBody as { error: string }).error).toMatch(/Incentive not found/);
  });

  it("deletes the incentive and returns the reloaded tenant on the happy path", async () => {
    const existing = [{
      freeMonthsFromStart: 3,
      id: INCENTIVE_ID,
      kind: "rentFreeMonths" as const,
    }];
    db.executeQuery
      .mockResolvedValueOnce([{ Incentives: JSON.stringify(existing) }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { TenantId: 1, BuildingId: 5, LegalName: "Acme", Status: "active" },
      ])
      .mockResolvedValueOnce([]);

    const res = await handlers.deleteTenantIncentive(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(200);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
  });

  it("returns 500 when the UPDATE throws", async () => {
    const existing = [{
      freeMonthsFromStart: 3,
      id: INCENTIVE_ID,
      kind: "rentFreeMonths" as const,
    }];
    db.executeQuery
      .mockResolvedValueOnce([{ Incentives: JSON.stringify(existing) }])
      .mockRejectedValueOnce(new Error("locked"));
    const res = await handlers.deleteTenantIncentive(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(500);
  });
});

// ── upsertScheduledRateStep ─────────────────────────────────────────────────

describe("upsertScheduledRateStep", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.upsertScheduledRateStep(makeRequest(validStepEnvelope()), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.upsertScheduledRateStep(makeRequest(validStepEnvelope()), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limit is exceeded", async () => {
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    const res = await handlers.upsertScheduledRateStep(makeRequest(validStepEnvelope()), ctx);
    expect(res.status).toBe(429);
    expect(res.headers?.["Retry-After"]).toBe("30");
  });

  it("returns 400 when ratePercent is out of range", async () => {
    const res = await handlers.upsertScheduledRateStep(
      makeRequest(validStepEnvelope({
        step: {
          effectiveFrom: "2026-07-01",
          id: STEP_ID,
          ratePercent: 999,
        },
      })),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/ratePercent/);
  });

  it("returns 400 when TenantId is missing", async () => {
    const body = validStepEnvelope();
    delete (body as Record<string, unknown>).TenantId;
    const res = await handlers.upsertScheduledRateStep(makeRequest(body), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/TenantId/);
  });

  it("returns 404 when the tenant is not found", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.upsertScheduledRateStep(makeRequest(validStepEnvelope()), ctx);
    expect(res.status).toBe(404);
    expect((res.jsonBody as { error: string }).error).toMatch(/Tenant not found/);
  });

  it("adds a new step, writes a change log row, and invalidates cache", async () => {
    db.executeQuery
      // SELECT ScheduledRateSteps
      .mockResolvedValueOnce([{ ScheduledRateSteps: null }])
      // UPDATE dbo.Tenants
      .mockResolvedValueOnce([])
      // INSERT change log
      .mockResolvedValueOnce([]);

    const res = await handlers.upsertScheduledRateStep(makeRequest(validStepEnvelope()), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { steps: Array<{ id: string }>; changeId: string };
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0].id).toBe(STEP_ID);
    expect(typeof body.changeId).toBe("string");
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);

    const logCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("INSERT INTO dbo.RentScheduleChangeLog"),
    );
    expect(logCall).toBeDefined();
  });

  it("updates an existing step in place", async () => {
    const existing = [{
      effectiveFrom: "2026-01-01",
      id: STEP_ID,
      ratePercent: 2,
    }];
    db.executeQuery
      .mockResolvedValueOnce([{ ScheduledRateSteps: JSON.stringify(existing) }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await handlers.upsertScheduledRateStep(makeRequest(validStepEnvelope()), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { steps: Array<{ ratePercent: number }> };
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0].ratePercent).toBe(5);
  });

  it("returns 500 when the UPDATE throws", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ ScheduledRateSteps: null }])
      .mockRejectedValueOnce(new Error("constraint"));
    const res = await handlers.upsertScheduledRateStep(makeRequest(validStepEnvelope()), ctx);
    expect(res.status).toBe(500);
  });
});

// ── deleteScheduledRateStep ─────────────────────────────────────────────────

describe("deleteScheduledRateStep", () => {
  const validDeleteBody = (): Record<string, unknown> => ({
    BuildingId: 5,
    TenantId: 1,
    stepId: STEP_ID,
  });

  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.deleteScheduledRateStep(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.deleteScheduledRateStep(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate limit is exceeded", async () => {
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    const res = await handlers.deleteScheduledRateStep(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(429);
    expect(res.headers?.["Retry-After"]).toBe("30");
  });

  it("returns 400 when stepId is not UUID-shaped", async () => {
    const body = validDeleteBody();
    body.stepId = "not-a-uuid";
    const res = await handlers.deleteScheduledRateStep(makeRequest(body), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/stepId/);
  });

  it("returns 404 when the tenant is not found", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.deleteScheduledRateStep(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(404);
    expect((res.jsonBody as { error: string }).error).toMatch(/Tenant not found/);
  });

  it("returns 404 when the step id is not present on the tenant", async () => {
    db.executeQuery.mockResolvedValueOnce([{ ScheduledRateSteps: JSON.stringify([]) }]);
    const res = await handlers.deleteScheduledRateStep(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(404);
    expect((res.jsonBody as { error: string }).error).toMatch(/Step not found/);
  });

  it("deletes the step, writes a change log row, and invalidates cache", async () => {
    const existing = [{
      effectiveFrom: "2026-07-01",
      id: STEP_ID,
      ratePercent: 5,
    }];
    db.executeQuery
      .mockResolvedValueOnce([{ ScheduledRateSteps: JSON.stringify(existing) }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await handlers.deleteScheduledRateStep(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { steps: unknown[]; changeId?: string };
    expect(body.steps).toEqual([]);
    expect(typeof body.changeId).toBe("string");
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);

    const logCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("INSERT INTO dbo.RentScheduleChangeLog"),
    );
    expect(logCall).toBeDefined();
  });

  it("returns 500 when the UPDATE throws", async () => {
    const existing = [{
      effectiveFrom: "2026-07-01",
      id: STEP_ID,
      ratePercent: 5,
    }];
    db.executeQuery
      .mockResolvedValueOnce([{ ScheduledRateSteps: JSON.stringify(existing) }])
      .mockRejectedValueOnce(new Error("locked"));
    const res = await handlers.deleteScheduledRateStep(makeRequest(validDeleteBody()), ctx);
    expect(res.status).toBe(500);
  });
});
