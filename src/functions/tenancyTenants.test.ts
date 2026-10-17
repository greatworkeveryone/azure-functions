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

const ledger = require("../ledger") as { record: jest.Mock };
const CONNECTION = { id: "conn" };
const ROW_VERSION = "00000000000007d1";

/** The tenant row upsertRegisterTenant reads under UPDLOCK before an update. */
function lockedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    BuildingId: 3,
    Expiry: null,
    RowVersion: Buffer.from(ROW_VERSION, "hex"),
    Status: "current",
    TenantId: 7,
    UpdatedAt: new Date("2026-10-01T02:00:00Z"),
    UpdatedByName: "Earlier Editor",
    ...over,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  auth.oidFromToken.mockReturnValue("caller-oid-123");
  auth.unauthorizedResponse.mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } });
  db.createRequestConnection.mockResolvedValue(CONNECTION);
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
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("short-circuits with empty array when no tenants exist", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.getRegisterTenants(makeRequest(null, { buildingId: "5" }), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ pendingChanges: { count: 0, items: [] }, tenants: [] });
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
      ])
      // WP26c: the building's relief requests and reviews awaiting approval.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

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
    expect(db.createRequestConnection).not.toHaveBeenCalled();
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
      .mockResolvedValueOnce([])
      // WP26c: the tenancy's relief requests and reviews awaiting approval.
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
      .mockResolvedValueOnce([lockedRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { TenantId: 7, BuildingId: 3, LegalName: "Renamed", Status: "current" },
      ]);

    const res = await handlers.upsertRegisterTenant(
      makeRequest({ TenantId: 7, LegalName: "Renamed", Status: "current" }),
      ctx,
    );
    expect(res.status).toBe(200);
    const updateCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("UPDATE dbo.Tenants"),
    );
    expect(updateCall).toBeDefined();
    expect(db.commitTransaction).toHaveBeenCalled();
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
      .mockResolvedValueOnce([lockedRow()])
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
      .mockResolvedValueOnce([lockedRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { TenantId: 7, BuildingId: 3, LegalName: "Acme", Status: "current", Expiry: new Date("2027-06-30") },
      ]);

    await handlers.upsertRegisterTenant(
      makeRequest({ TenantId: 7, Expiry: "2027-06-30" }),
      ctx,
    );
    expect(planner.resolveActivePlannerTasks).toHaveBeenCalled();
  });

  it("does NOT fire planner resolve on a plain update", async () => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { TenantId: 7, BuildingId: 3, LegalName: "Acme", Status: "current" },
      ]);

    const res = await handlers.upsertRegisterTenant(
      makeRequest({ TenantId: 7, Comments: "just updating a note" }),
      ctx,
    );
    expect(res.status).toBe(200);
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

// ── upsertRegisterTenant: write integrity (PLAN WP23a) ──────────────────────

describe("upsertRegisterTenant — write integrity", () => {
  const storedRow = (over: Record<string, unknown> = {}) => [
    { TenantId: 7, BuildingId: 3, LegalName: "Acme", Status: "current", ...over },
  ];
  const updateSql = (): string | undefined =>
    (db.executeQuery.mock.calls.find(([, sql]: [unknown, string]) =>
      sql.includes("UPDATE dbo.Tenants"),
    ) as [unknown, string] | undefined)?.[1];

  it("reads the row under an update lock inside a transaction", async () => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow());
    await handlers.upsertRegisterTenant(makeRequest({ TenantId: 7, Comments: "x", RowVersion: ROW_VERSION }), ctx);
    expect(db.beginTransaction).toHaveBeenCalled();
    expect(db.executeQuery.mock.calls[0][1]).toMatch(/WITH \(UPDLOCK, ROWLOCK\)/);
  });

  it("returns 409 naming who changed it when the RowVersion is stale, and writes nothing", async () => {
    db.executeQuery.mockResolvedValueOnce([
      lockedRow({ RowVersion: Buffer.from("00000000000007d2", "hex"), UpdatedByName: "Priya Accounts" }),
    ]);
    const res = await handlers.upsertRegisterTenant(
      makeRequest({ TenantId: 7, Comments: "mine", RowVersion: ROW_VERSION }),
      ctx,
    );
    expect(res.status).toBe(409);
    const body = res.jsonBody as { error: string; conflict: { changedBy: string; rowVersion: string } };
    expect(body.error).toMatch(/Priya Accounts/);
    expect(body.conflict.changedBy).toBe("Priya Accounts");
    expect(body.conflict.rowVersion).toBe("00000000000007d2");
    expect(updateSql()).toBeUndefined();
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("accepts the RowVersion case-insensitively", async () => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow());
    const res = await handlers.upsertRegisterTenant(
      makeRequest({ TenantId: 7, Comments: "x", RowVersion: ROW_VERSION.toUpperCase() }),
      ctx,
    );
    expect(res.status).toBe(200);
  });

  it("returns 400 for a malformed RowVersion", async () => {
    const res = await handlers.upsertRegisterTenant(makeRequest({ TenantId: 7, RowVersion: "abc" }), ctx);
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("does not store a re-sent derived holdover status (expiry passed, stored current)", async () => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow({ Expiry: new Date("2020-06-30T00:00:00Z"), Status: "current" })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow());
    const res = await handlers.upsertRegisterTenant(
      makeRequest({ TenantId: 7, Status: "holdover", Comments: "edited after expiry" }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(updateSql()).toBeDefined();
    expect(updateSql()).not.toMatch(/Status = @Status/);
    expect(updateSql()).toMatch(/Comments = @Comments/);
  });

  it("reads holdover only while the expiry has passed, so extending it reads current", async () => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow({ Expiry: new Date("2020-06-30T00:00:00Z") })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow({ Expiry: new Date("2031-06-30T00:00:00Z") }));
    const res = await handlers.upsertRegisterTenant(makeRequest({ TenantId: 7, Expiry: "2031-06-30" }), ctx);
    expect((res.jsonBody as { tenant: { status: string } }).tenant.status).toBe("current");
  });

  it("stores an explicit status change", async () => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow({ Status: "holdover", Expiry: new Date("2031-06-30T00:00:00Z") })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow());
    await handlers.upsertRegisterTenant(makeRequest({ TenantId: 7, Status: "current" }), ctx);
    expect(updateSql()).toMatch(/Status = @Status/);
  });

  it("skips the UPDATE entirely when nothing would change", async () => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow()])
      .mockResolvedValueOnce(storedRow());
    const res = await handlers.upsertRegisterTenant(makeRequest({ TenantId: 7, Status: "current" }), ctx);
    expect(res.status).toBe(200);
    expect(updateSql()).toBeUndefined();
    expect(db.commitTransaction).toHaveBeenCalled();
  });

  it("ledgers schedule-term changes as schedule.terms_edit in the write's transaction and bumps ScheduleVersion", async () => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow({ FixedReviewPercent: 3, ReviewType: "Fixed 3%" })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow());
    const res = await handlers.upsertRegisterTenant(
      makeRequest({ TenantId: 7, FixedReviewPercent: 3.5, ReviewType: "Fixed 3%", RowVersion: ROW_VERSION }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(updateSql()).toMatch(/ScheduleVersion = ScheduleVersion \+ 1/);
    expect(ledger.record).toHaveBeenCalledTimes(1);
    const [tx, entry] = ledger.record.mock.calls[0];
    expect(tx).toBe(CONNECTION);
    expect(entry).toMatchObject({
      action: "schedule.terms_edit",
      actor: { kind: "user", name: "Test User" },
      after: { fixedReviewPercent: 3.5 },
      before: { fixedReviewPercent: 3 },
      buildingId: 3,
      subject: { id: 7, type: "tenancy" },
      tenantId: 7,
    });
    // Unchanged terms are not part of the record.
    expect(entry.after).not.toHaveProperty("reviewType");
    const order = (fn: jest.Mock) => fn.mock.invocationCallOrder[0];
    expect(order(ledger.record)).toBeLessThan(order(db.commitTransaction));
  });

  it("does not ledger or bump ScheduleVersion when no schedule term changes", async () => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow({ RentPerAnnum: 120000 })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow());
    await handlers.upsertRegisterTenant(makeRequest({ TenantId: 7, RentPerAnnum: 120000, Comments: "x" }), ctx);
    expect(ledger.record).not.toHaveBeenCalled();
    expect(updateSql()).not.toMatch(/ScheduleVersion/);
  });

  it("rolls the edit back when the ledger write fails", async () => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow({ RentPerAnnum: 100000 })])
      .mockResolvedValueOnce([]);
    ledger.record.mockRejectedValueOnce(new Error("ledger unavailable"));
    const res = await handlers.upsertRegisterTenant(makeRequest({ TenantId: 7, RentPerAnnum: 110000 }), ctx);
    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("exposes rowVersion and scheduleVersion on the tenant", async () => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow({ RowVersion: Buffer.from("00000000000007d1", "hex"), ScheduleVersion: 4 }));
    const res = await handlers.upsertRegisterTenant(makeRequest({ TenantId: 7, Comments: "x" }), ctx);
    const { tenant } = res.jsonBody as { tenant: { rowVersion: string; scheduleVersion: number } };
    expect(tenant.rowVersion).toBe("00000000000007d1");
    expect(tenant.scheduleVersion).toBe(4);
  });

  // M4 (WP26c): the lease's CPI reference-quarter rule, set with its terms at sign-off.
  it("stores the lease's CPI reference-quarter rule as a schedule term, ledgered, and shows it on the tenant (M4)", async () => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow({ CpiReferenceQuarterRule: null })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow({ CpiReferenceQuarterRule: "latest_published_before_review" }));
    const res = await handlers.upsertRegisterTenant(
      makeRequest({ TenantId: 7, CpiReferenceQuarterRule: "latest_published_before_review", RowVersion: ROW_VERSION }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(updateSql()).toMatch(/CpiReferenceQuarterRule = @CpiReferenceQuarterRule/);
    expect(updateSql()).toMatch(/ScheduleVersion = ScheduleVersion \+ 1/);
    expect(ledger.record.mock.calls[0][1]).toMatchObject({
      action: "schedule.terms_edit",
      after: { cpiReferenceQuarterRule: "latest_published_before_review" },
      before: { cpiReferenceQuarterRule: null },
    });
    expect((res.jsonBody as { tenant: Record<string, unknown> }).tenant.cpiReferenceQuarterRule).toBe("latest_published_before_review");
  });

  it("puts the rule back to the default with an empty string (M4)", async () => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow({ CpiReferenceQuarterRule: "latest_published_before_review" })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow());
    await handlers.upsertRegisterTenant(makeRequest({ TenantId: 7, CpiReferenceQuarterRule: "" }), ctx);
    const update = db.executeQuery.mock.calls.find(([, sql]: [unknown, string]) => sql.includes("UPDATE dbo.Tenants"));
    expect(update?.[2]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "CpiReferenceQuarterRule", value: null })]));
    expect(ledger.record.mock.calls[0][1]).toMatchObject({ after: { cpiReferenceQuarterRule: null }, before: { cpiReferenceQuarterRule: "latest_published_before_review" } });
  });

  it.each([["quarter_before_review"], ["latest"], [3]])("refuses %p as a reference-quarter rule before touching the database (M4)", async (rule) => {
    const res = await handlers.upsertRegisterTenant(makeRequest({ TenantId: 7, CpiReferenceQuarterRule: rule }), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toBe(
      "CpiReferenceQuarterRule must be one of quarter_before_review_date, latest_published_before_review, or null",
    );
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("takes the rule on create (M4)", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ TenantId: 42 }])
      .mockResolvedValueOnce([{ TenantId: 42, BuildingId: 5, LegalName: "Acme", Status: "current" }]);
    const res = await handlers.upsertRegisterTenant(
      makeRequest({ BuildingId: 5, CpiReferenceQuarterRule: "latest_published_before_review", LegalName: "Acme" }),
      ctx,
    );
    expect(res.status).toBe(200);
    const insert = db.executeQuery.mock.calls.find(([, sql]: [unknown, string]) => sql.includes("INSERT INTO dbo.Tenants"));
    expect(insert?.[1]).toMatch(/@CpiReferenceQuarterRule/);
    expect(insert?.[2]).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "CpiReferenceQuarterRule", value: "latest_published_before_review" })]),
    );
  });
});

// ── upsertRegisterTenant: review terms and next review (PLAN WP23b) ─────────

describe("upsertRegisterTenant — review terms and next review", () => {
  const STEP = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
  const schedule = JSON.stringify([
    { baseRentPerAnnum: 100000, effectiveFrom: "2024-07-01", id: STEP, methodKind: "commencement", ratePercent: 0 },
    { effectiveFrom: "2027-07-01", id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", methodKind: "cpi", ratePercent: 0 },
  ]);
  const storedRow = (over: Record<string, unknown> = {}) => [
    { TenantId: 7, BuildingId: 3, LegalName: "Acme", Status: "current", ...over },
  ];
  const updateCall = () =>
    db.executeQuery.mock.calls.find(([, sql]: [unknown, string]) => sql.includes("UPDATE dbo.Tenants")) as
      | [unknown, string, Array<{ name: string; value: unknown }>]
      | undefined;
  const param = (name: string) => updateCall()?.[2].find((entry) => entry.name === name)?.value;
  const actions = () => ledger.record.mock.calls.map(([, entry]) => entry.action);

  it("ledgers the ratchet as a schedule term and bumps ScheduleVersion", async () => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow({ ReviewRatchet: false })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow({ ReviewRatchet: true }));
    const res = await handlers.upsertRegisterTenant(makeRequest({ ReviewRatchet: true, TenantId: 7 }), ctx);
    expect(res.status).toBe(200);
    expect(updateCall()?.[1]).toMatch(/ReviewRatchet = @ReviewRatchet/);
    expect(updateCall()?.[1]).toMatch(/ScheduleVersion = ScheduleVersion \+ 1/);
    expect(ledger.record.mock.calls[0][1]).toMatchObject({
      action: "schedule.terms_edit",
      after: { reviewRatchet: true },
      before: { reviewRatchet: false },
    });
    expect((res.jsonBody as { tenant: { reviewRatchet: boolean } }).tenant.reviewRatchet).toBe(true);
  });

  it("refuses a ratchet that isn't a boolean, before touching the database", async () => {
    const res = await handlers.upsertRegisterTenant(makeRequest({ ReviewRatchet: "yes", TenantId: 7 }), ctx);
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("refuses a CPI floor above the cap (checked against the stored cap) and writes nothing", async () => {
    db.executeQuery.mockResolvedValueOnce([lockedRow({ CpiCapPercent: 4, CpiFloorPercent: 1 })]);
    const res = await handlers.upsertRegisterTenant(makeRequest({ CpiFloorPercent: 5, TenantId: 7 }), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/floor \(5%\) can't be above the CPI cap \(4%\)/);
    expect(updateCall()).toBeUndefined();
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });

  it("refuses a CPI cap outside 0–100", async () => {
    const res = await handlers.upsertRegisterTenant(makeRequest({ CpiCapPercent: -1, TenantId: 7 }), ctx);
    expect(res.status).toBe(400);
  });

  it("re-derives NextReviewDate when a review date field changes; a derived date alone isn't ledgered", async () => {
    db.executeQuery
      .mockResolvedValueOnce([
        lockedRow({ NextReviewDate: new Date("2025-07-01T00:00:00Z"), ScheduledRateSteps: schedule }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow());
    await handlers.upsertRegisterTenant(makeRequest({ Commencement: "2024-07-01", TenantId: 7 }), ctx);
    expect(param("NextReviewDate")).toBe("2027-07-01");
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("ignores a typed NextReviewDate on a tenancy with a schedule — the schedule decides", async () => {
    db.executeQuery
      .mockResolvedValueOnce([
        lockedRow({ NextReviewDate: new Date("2027-07-01T00:00:00Z"), ScheduledRateSteps: schedule }),
      ])
      .mockResolvedValueOnce(storedRow());
    const res = await handlers.upsertRegisterTenant(makeRequest({ NextReviewDate: "2030-01-01", TenantId: 7 }), ctx);
    expect(res.status).toBe(200);
    expect(updateCall()).toBeUndefined();
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("stores a typed NextReviewDate on a tenancy without a schedule, unledgered", async () => {
    db.executeQuery
      .mockResolvedValueOnce([
        lockedRow({ Commencement: new Date("2018-03-01T00:00:00Z"), NextReviewDate: new Date("2026-03-01T00:00:00Z") }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow());
    await handlers.upsertRegisterTenant(makeRequest({ NextReviewDate: "2027-03-01", TenantId: 7 }), ctx);
    expect(param("NextReviewDate")).toBe("2027-03-01");
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("carries a moved review date in the terms edit's ledger entry, not a row of its own", async () => {
    db.executeQuery
      .mockResolvedValueOnce([
        lockedRow({ NextReviewDate: new Date("2025-07-01T00:00:00Z"), ReviewIntervalMonths: 12, ScheduledRateSteps: schedule }),
      ])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow());
    await handlers.upsertRegisterTenant(makeRequest({ ReviewIntervalMonths: 24, TenantId: 7 }), ctx);
    expect(actions()).toEqual(["schedule.terms_edit"]);
    const entry = ledger.record.mock.calls[0][1];
    expect(entry.before).toEqual({ nextReviewDate: "2025-07-01", reviewIntervalMonths: 12 });
    expect(entry.after).toEqual({ nextReviewDate: "2027-07-01", reviewIntervalMonths: 24 });
  });

  it("derives a new tenancy's first review from its commencement when none is sent", async () => {
    db.executeQuery.mockResolvedValueOnce([{ TenantId: 42 }]).mockResolvedValueOnce(storedRow());
    await handlers.upsertRegisterTenant(
      makeRequest({ BuildingId: 3, Commencement: "2026-12-01", LegalName: "New Co", ReviewRatchet: true }),
      ctx,
    );
    const [, sql, params] = db.executeQuery.mock.calls[0] as [unknown, string, Array<{ name: string; value: unknown }>];
    expect(sql).toMatch(/INSERT INTO dbo\.Tenants/);
    expect(params.find((entry) => entry.name === "NextReviewDate")?.value).toBe("2027-12-01");
    expect(params.find((entry) => entry.name === "ReviewRatchet")?.value).toBe(true);
  });

  it("keeps a new tenancy's sent review date", async () => {
    db.executeQuery.mockResolvedValueOnce([{ TenantId: 42 }]).mockResolvedValueOnce(storedRow());
    await handlers.upsertRegisterTenant(
      makeRequest({ BuildingId: 3, Commencement: "2018-03-01", LegalName: "Old Co", NextReviewDate: "2027-03-01" }),
      ctx,
    );
    const params = db.executeQuery.mock.calls[0][2] as Array<{ name: string; value: unknown }>;
    expect(params.find((entry) => entry.name === "NextReviewDate")?.value).toBe("2027-03-01");
  });

  it("reads the next review for today: a keyed past step has settled, a keyed future step is upcoming", async () => {
    const keyed = JSON.stringify([
      { baseRentPerAnnum: 100000, effectiveFrom: "2020-07-01", id: STEP, methodKind: "commencement", ratePercent: 0 },
      { effectiveFrom: "2021-07-01", id: "dddddddd-dddd-dddd-dddd-dddddddddddd", methodKind: "fixed", ratePercent: 3 },
      { effectiveFrom: "2099-07-01", id: "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", methodKind: "fixed", ratePercent: 3 },
    ]);
    db.executeQuery
      .mockResolvedValueOnce([lockedRow()])
      .mockResolvedValueOnce([])
      // The stored date still points at the 2021 step.
      .mockResolvedValueOnce(
        storedRow({ NextReviewDate: new Date("2021-07-01T00:00:00Z"), ScheduledRateSteps: keyed }),
      );
    const res = await handlers.upsertRegisterTenant(makeRequest({ Comments: "x", TenantId: 7 }), ctx);
    const { tenant } = res.jsonBody as { tenant: { nextReviewDate: string; reviewState: string } };
    expect(tenant.nextReviewDate).toBe("2099-07-01");
    expect(tenant.reviewState).toBe("green");
  });

  it("applies the CPI cap to the headline rent", async () => {
    const steps = JSON.stringify([
      { baseRentPerAnnum: 100000, effectiveFrom: "2024-07-01", id: STEP, methodKind: "commencement", ratePercent: 0 },
      { cpiValue: 105, cpiValuePrev: 100, effectiveFrom: "2025-07-01", id: "cccccccc-cccc-cccc-cccc-cccccccccccc", methodKind: "cpi", ratePercent: 5 },
    ]);
    db.executeQuery
      .mockResolvedValueOnce([lockedRow()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow({ CpiCapPercent: 3, ReviewRatchet: false, ScheduledRateSteps: steps }));
    const res = await handlers.upsertRegisterTenant(makeRequest({ Comments: "x", TenantId: 7 }), ctx);
    expect((res.jsonBody as { tenant: { effectiveRentPerAnnum: number } }).tenant.effectiveRentPerAnnum).toBe(103000);
  });

  // WP26c (M2): once reviews run through the workflow, a row keyed ahead moves
  // the rent only when a review applies it, so its arrears are never counted twice.
  describe("with REVIEW_WORKFLOW_LIVE_FROM set", () => {
    const keyedAhead = JSON.stringify([
      { baseRentPerAnnum: 100000, effectiveFrom: "2024-07-01", id: STEP, methodKind: "commencement", ratePercent: 0 },
      { effectiveFrom: "2025-07-01", id: "cccccccc-cccc-cccc-cccc-cccccccccccc", methodKind: "fixed", ratePercent: 3 },
    ]);
    afterEach(() => {
      delete process.env.REVIEW_WORKFLOW_LIVE_FROM;
    });

    it("keeps the rent before a review row keyed ahead until a review applies it, and says when the workflow went live", async () => {
      process.env.REVIEW_WORKFLOW_LIVE_FROM = "2025-01-01";
      db.executeQuery
        .mockResolvedValueOnce([lockedRow()])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(storedRow({ ReviewRatchet: false, ScheduledRateSteps: keyedAhead }));
      const res = await handlers.upsertRegisterTenant(makeRequest({ Comments: "x", TenantId: 7 }), ctx);
      const { tenant } = res.jsonBody as { tenant: { effectiveRentPerAnnum: number; reviewWorkflowLiveFrom: string | null } };
      expect(tenant.effectiveRentPerAnnum).toBe(100000);
      expect(tenant.reviewWorkflowLiveFrom).toBe("2025-01-01");
    });

    it("moves it once the row is settled, and reads every row as keyed while the setting is unset", async () => {
      process.env.REVIEW_WORKFLOW_LIVE_FROM = "2025-01-01";
      const applied = keyedAhead.replace('"ratePercent":3}', '"ratePercent":3,"resolution":"applied","reviewId":"rev-1"}');
      db.executeQuery
        .mockResolvedValueOnce([lockedRow()])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(storedRow({ ReviewRatchet: false, ScheduledRateSteps: applied }));
      const settled = await handlers.upsertRegisterTenant(makeRequest({ Comments: "x", TenantId: 7 }), ctx);
      expect((settled.jsonBody as { tenant: { effectiveRentPerAnnum: number } }).tenant.effectiveRentPerAnnum).toBe(103000);

      delete process.env.REVIEW_WORKFLOW_LIVE_FROM;
      db.executeQuery
        .mockResolvedValueOnce([lockedRow()])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(storedRow({ ReviewRatchet: false, ScheduledRateSteps: keyedAhead }));
      const unset = await handlers.upsertRegisterTenant(makeRequest({ Comments: "x", TenantId: 7 }), ctx);
      const { tenant } = unset.jsonBody as { tenant: { effectiveRentPerAnnum: number; reviewWorkflowLiveFrom: string | null } };
      expect(tenant.effectiveRentPerAnnum).toBe(103000);
      expect(tenant.reviewWorkflowLiveFrom).toBeNull();
    });
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
    // The draft facts (D4: every table that refers to the tenancy, under lock),
    // then the optional sign-off / defects-period read.
    db.executeQuery
      .mockResolvedValueOnce([{ Jobs: 2, LegalName: "Acme", ScheduledRateSteps: "[]" }])
      .mockResolvedValueOnce([{ DefectsPeriods: 0, SignedOff: 0 }]);
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
