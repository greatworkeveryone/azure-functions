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
jest.mock("../ledgerActor", () => ({
  ledgerActorFor: jest.fn().mockResolvedValue({ kind: "user", name: "Test User", role: "accounts", userId: 7 }),
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
  beginTransaction:    jest.Mock;
  closeConnection:     jest.Mock;
  commitTransaction:   jest.Mock;
  createRequestConnection: jest.Mock;
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
  db.createRequestConnection.mockResolvedValue({});
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

// ── Schedule write integrity (PLAN WP23a, F15) ──────────────────────────────

describe("schedule writes — versioned, transactional, ledgered", () => {
  const ledger = require("../ledger") as { record: jest.Mock };
  const PREV_ID = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const locked = (over: Record<string, unknown> = {}) => ({
    BuildingId: 5,
    Incentives: null,
    ScheduleVersion: 3,
    ScheduledRateSteps: null,
    TenantId: 1,
    UpdatedAt: new Date("2026-10-01T02:00:00Z"),
    UpdatedByName: "Priya Accounts",
    ...over,
  });
  const sqlCalls = () => db.executeQuery.mock.calls.map(([, sql]: [unknown, string]) => sql);

  it("locks the tenant row inside a transaction before reading the schedule", async () => {
    db.executeQuery
      .mockResolvedValueOnce([locked()])
      .mockResolvedValueOnce([{ RowVersion: Buffer.from("00000000000000aa", "hex"), ScheduleVersion: 4 }])
      .mockResolvedValueOnce([]);
    const res = await handlers.upsertScheduledRateStep(makeRequest(validStepEnvelope({ ScheduleVersion: 3 })), ctx);
    expect(res.status).toBe(200);
    expect(sqlCalls()[0]).toMatch(/FROM dbo\.Tenants t WITH \(UPDLOCK, ROWLOCK\)/);
    expect(sqlCalls()[1]).toMatch(/ScheduleVersion = ScheduleVersion \+ 1/);
    expect(res.jsonBody).toMatchObject({ rowVersion: "00000000000000aa", scheduleVersion: 4 });
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns 409 naming who changed the schedule when ScheduleVersion is stale", async () => {
    db.executeQuery.mockResolvedValueOnce([locked({ ScheduleVersion: 5 })]);
    const res = await handlers.upsertScheduledRateStep(makeRequest(validStepEnvelope({ ScheduleVersion: 3 })), ctx);
    expect(res.status).toBe(409);
    const body = res.jsonBody as { error: string; conflict: { changedBy: string; scheduleVersion: number } };
    expect(body.error).toMatch(/Priya Accounts/);
    expect(body.conflict).toMatchObject({ changedBy: "Priya Accounts", scheduleVersion: 5 });
    expect(sqlCalls().some((sql) => sql.includes("UPDATE dbo.Tenants"))).toBe(false);
    expect(ledger.record).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 for a malformed ScheduleVersion", async () => {
    const res = await handlers.upsertScheduledRateStep(makeRequest(validStepEnvelope({ ScheduleVersion: "3" })), ctx);
    expect(res.status).toBe(400);
  });

  it("ledgers the step as schedule.manual_edit with before and after, inside the transaction", async () => {
    const existing = [{ effectiveFrom: "2026-01-01", effectiveTo: "2026-07-01", id: STEP_ID, ratePercent: 2 }];
    db.executeQuery
      // NextReviewDate already where the edit leaves it, so only the step is ledgered.
      .mockResolvedValueOnce([locked({ NextReviewDate: new Date("2027-07-01T00:00:00Z"), ScheduledRateSteps: JSON.stringify(existing) })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await handlers.upsertScheduledRateStep(makeRequest(validStepEnvelope()), ctx);
    expect(ledger.record).toHaveBeenCalledTimes(1);
    const [, entry] = ledger.record.mock.calls[0];
    expect(entry).toMatchObject({
      action: "schedule.manual_edit",
      actor: { name: "Test User", role: "accounts", userId: 7 },
      after: { effectiveFrom: "2026-07-01", id: STEP_ID, ratePercent: 5 },
      before: { effectiveFrom: "2026-01-01", id: STEP_ID, ratePercent: 2 },
      buildingId: 5,
      subject: { id: STEP_ID, type: "rate_step" },
      tenantId: 1,
    });
    const order = (fn: jest.Mock) => fn.mock.invocationCallOrder[0];
    expect(order(ledger.record)).toBeLessThan(order(db.commitTransaction));
  });

  it("adding a row closes the open-ended row before it, and ledgers that too", async () => {
    const existing = [{ effectiveFrom: "2025-07-01", id: PREV_ID, methodKind: "commencement", ratePercent: 0, baseRentPerAnnum: 100000 }];
    db.executeQuery
      .mockResolvedValueOnce([locked({ NextReviewDate: new Date("2027-07-01T00:00:00Z"), ScheduledRateSteps: JSON.stringify(existing) })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await handlers.upsertScheduledRateStep(makeRequest(validStepEnvelope()), ctx);
    const steps = (res.jsonBody as { steps: Array<{ id: string; effectiveTo?: string }> }).steps;
    expect(steps.find((s) => s.id === PREV_ID)?.effectiveTo).toBe("2026-07-01");
    expect(ledger.record).toHaveBeenCalledTimes(2);
    expect(ledger.record.mock.calls[1][1]).toMatchObject({
      action: "schedule.manual_edit",
      after: { effectiveTo: "2026-07-01", id: PREV_ID },
      before: { id: PREV_ID },
      subject: { id: PREV_ID, type: "rate_step" },
    });
    expect(ledger.record.mock.calls[1][1].before).not.toHaveProperty("effectiveTo");
    const logInserts = sqlCalls().filter((sql) => sql.includes("INSERT INTO dbo.RentScheduleChangeLog"));
    expect(logInserts).toHaveLength(2);
  });

  it("rolls the step back when the ledger write fails", async () => {
    db.executeQuery
      .mockResolvedValueOnce([locked()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    ledger.record.mockRejectedValueOnce(new Error("ledger unavailable"));
    const res = await handlers.upsertScheduledRateStep(makeRequest(validStepEnvelope()), ctx);
    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(cache.invalidateTenantAndBuilding).not.toHaveBeenCalled();
  });

  it("ledgers a deleted step with its before snapshot", async () => {
    const existing = [{ effectiveFrom: "2026-07-01", id: STEP_ID, ratePercent: 5 }];
    db.executeQuery
      .mockResolvedValueOnce([locked({ ScheduledRateSteps: JSON.stringify(existing) })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await handlers.deleteScheduledRateStep(
      makeRequest({ BuildingId: 5, ScheduleVersion: 3, stepId: STEP_ID, TenantId: 1 }),
      ctx,
    );
    expect(ledger.record.mock.calls[0][1]).toMatchObject({
      action: "schedule.manual_edit",
      after: null,
      before: { id: STEP_ID, ratePercent: 5 },
      subject: { id: STEP_ID, type: "rate_step" },
    });
  });

  it("ledgers incentive writes as schedule.manual_edit on the incentive", async () => {
    db.executeQuery
      .mockResolvedValueOnce([locked()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ TenantId: 1, BuildingId: 5, LegalName: "Acme", Status: "current" }])
      .mockResolvedValueOnce([]);
    const res = await handlers.upsertTenantIncentive(makeRequest(validIncentiveEnvelope({ ScheduleVersion: 3 })), ctx);
    expect(res.status).toBe(200);
    expect(ledger.record.mock.calls[0][1]).toMatchObject({
      action: "schedule.manual_edit",
      after: { id: INCENTIVE_ID, kind: "rentFreeMonths" },
      before: null,
      subject: { id: INCENTIVE_ID, type: "incentive" },
    });
  });

  it("returns 409 on a stale incentive write", async () => {
    db.executeQuery.mockResolvedValueOnce([locked({ ScheduleVersion: 9 })]);
    const res = await handlers.deleteTenantIncentive(
      makeRequest({ BuildingId: 5, incentiveId: INCENTIVE_ID, ScheduleVersion: 3, TenantId: 1 }),
      ctx,
    );
    expect(res.status).toBe(409);
  });
});

// ── NextReviewDate follows every schedule write (PLAN WP23b, D1) ────────────

describe("schedule writes — next review date", () => {
  const ledger = require("../ledger") as { record: jest.Mock };
  const COMMENCEMENT_ID = "dddddddd-dddd-dddd-dddd-dddddddddddd";
  const commencementRow = {
    baseRentPerAnnum: 100000,
    effectiveFrom: "2024-07-01",
    id: COMMENCEMENT_ID,
    methodKind: "commencement",
    ratePercent: 0,
  };
  const locked = (over: Record<string, unknown> = {}) => ({
    BuildingId: 5,
    Commencement: new Date("2024-07-01T00:00:00Z"),
    NextReviewDate: new Date("2025-07-01T00:00:00Z"),
    ReviewIntervalMonths: 12,
    ScheduleVersion: 3,
    ScheduledRateSteps: JSON.stringify([commencementRow]),
    TenantId: 1,
    ...over,
  });
  const updateCall = () =>
    db.executeQuery.mock.calls.find(([, sql]: [unknown, string]) => sql.includes("UPDATE dbo.Tenants")) as
      | [unknown, string, Array<{ name: string; value: unknown }>]
      | undefined;

  it("derives NextReviewDate from the schedule in the same UPDATE and ledgers the move under the write's correlation", async () => {
    db.executeQuery.mockResolvedValueOnce([locked()]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    const res = await handlers.upsertScheduledRateStep(
      makeRequest({
        BuildingId: 5,
        step: { effectiveFrom: "2027-07-01", id: STEP_ID, methodKind: "cpi", ratePercent: 0 },
        TenantId: 1,
      }),
      ctx,
    );
    expect(res.status).toBe(200);
    const [, sql, params] = updateCall()!;
    expect(sql).toMatch(/NextReviewDate = @NextReviewDate/);
    // The earliest review row nothing has settled is next: the CPI row waiting on its index.
    expect(params.find((param) => param.name === "NextReviewDate")?.value).toBe("2027-07-01");
    const recompute = ledger.record.mock.calls.find(([, entry]) => entry.action === "schedule.recompute_next_review");
    expect(recompute?.[1]).toMatchObject({
      after: { nextReviewDate: "2027-07-01" },
      before: { nextReviewDate: "2025-07-01" },
      subject: { id: 1, type: "tenancy" },
      tenantId: 1,
    });
    const correlations = new Set(ledger.record.mock.calls.map(([, entry]) => entry.correlationId));
    expect(correlations.size).toBe(1);
  });

  it("re-derives on a car park, misc fee or incentive write too", async () => {
    db.executeQuery
      // A hand-kept date the schedule doesn't support: only a commencement row,
      // so the first anniversary is the next review.
      .mockResolvedValueOnce([locked({ NextReviewDate: new Date("2031-01-01T00:00:00Z") })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ TenantId: 1, BuildingId: 5, LegalName: "Acme", Status: "current" }])
      .mockResolvedValueOnce([]);
    await handlers.upsertTenantIncentive(makeRequest(validIncentiveEnvelope()), ctx);
    const [, sql, params] = updateCall()!;
    expect(sql).toMatch(/NextReviewDate = @NextReviewDate/);
    expect(params.find((param) => param.name === "NextReviewDate")?.value).toBe("2025-07-01");
  });

  it("leaves NextReviewDate alone, and ledgers nothing about it, when it doesn't move", async () => {
    db.executeQuery
      .mockResolvedValueOnce([locked()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await handlers.upsertScheduledRateStep(
      makeRequest({ BuildingId: 5, step: { ...commencementRow, note: "checked" }, TenantId: 1 }),
      ctx,
    );
    expect(updateCall()![1]).not.toMatch(/NextReviewDate/);
    expect(ledger.record.mock.calls.map(([, entry]) => entry.action)).toEqual(["schedule.manual_edit"]);
  });

  it("a waived review settles its row; the next review is the following anniversary", async () => {
    const review = { effectiveFrom: "2027-07-01", id: STEP_ID, methodKind: "cpi", ratePercent: 0 };
    db.executeQuery
      .mockResolvedValueOnce([
        locked({
          LastReviewDate: new Date("2027-07-01T00:00:00Z"),
          NextReviewDate: new Date("2027-07-01T00:00:00Z"),
          ScheduledRateSteps: JSON.stringify([commencementRow, review]),
        }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    await handlers.upsertScheduledRateStep(
      makeRequest({ BuildingId: 5, step: { ...review, resolution: "waived" }, TenantId: 1 }),
      ctx,
    );
    const params = updateCall()![2];
    expect(params.find((param) => param.name === "NextReviewDate")?.value).toBe("2028-07-01");
  });

  it("rolls back the derived date with the write when the ledger fails", async () => {
    db.executeQuery.mockResolvedValueOnce([locked()]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    ledger.record.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("ledger unavailable"));
    const res = await handlers.upsertScheduledRateStep(
      makeRequest({
        BuildingId: 5,
        step: { effectiveFrom: "2027-07-01", id: STEP_ID, methodKind: "cpi", ratePercent: 0 },
        TenantId: 1,
      }),
      ctx,
    );
    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});
