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
  invalidateTenantAndBuilding: jest.Mock;
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

// A UUID-shaped string accepted by isUuidShaped (/^[0-9a-f-]{36}$/i).
const FEE_ID    = "00000000-0000-0000-0000-000000000001";
const FEE_ID_2  = "00000000-0000-0000-0000-000000000002";

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  auth.oidFromToken.mockReturnValue("caller-oid-123");
  auth.unauthorizedResponse.mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } });
  db.createConnection.mockResolvedValue({});
  db.closeConnection.mockImplementation(() => undefined);
  rateLimit.checkRateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
});

// ── upsertInfoSheetSection ───────────────────────────────────────────────────

describe("upsertInfoSheetSection", () => {
  const validBody = {
    TenantId: 1,
    BuildingId: 5,
    Section: { id: "sec-1", title: "Section One", displayOrder: 0, rows: [] },
  };

  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.upsertInfoSheetSection(makeRequest(validBody), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.upsertInfoSheetSection(makeRequest(validBody), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate-limited", async () => {
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    const res = await handlers.upsertInfoSheetSection(makeRequest(validBody), ctx);
    expect(res.status).toBe(429);
    expect(res.headers).toEqual({ "Retry-After": "30" });
  });

  it("returns 400 when TenantId is missing", async () => {
    const res = await handlers.upsertInfoSheetSection(
      makeRequest({ BuildingId: 5, Section: { id: "sec-1", title: "Section One" } }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when Section.id is missing", async () => {
    const res = await handlers.upsertInfoSheetSection(
      makeRequest({ TenantId: 1, BuildingId: 5, Section: { title: "x" } }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when Section.title is missing", async () => {
    const res = await handlers.upsertInfoSheetSection(
      makeRequest({ TenantId: 1, BuildingId: 5, Section: { id: "sec-1" } }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when tenant is not found", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.upsertInfoSheetSection(makeRequest(validBody), ctx);
    expect(res.status).toBe(404);
  });

  it("upserts and returns 200 + invalidates cache on the happy path", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ InfoSheetSections: null }])
      .mockResolvedValueOnce([]);

    const res = await handlers.upsertInfoSheetSection(makeRequest(validBody), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { sections: Array<{ id: string }> };
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0].id).toBe("sec-1");
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
  });

  it("returns 500 when the SELECT throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("db down"));
    const res = await handlers.upsertInfoSheetSection(makeRequest(validBody), ctx);
    expect(res.status).toBe(500);
  });
});

// ── deleteInfoSheetSection ───────────────────────────────────────────────────

describe("deleteInfoSheetSection", () => {
  const validBody = { TenantId: 1, BuildingId: 5, SectionId: "sec-1" };

  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.deleteInfoSheetSection(makeRequest(validBody), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.deleteInfoSheetSection(makeRequest(validBody), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate-limited", async () => {
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    const res = await handlers.deleteInfoSheetSection(makeRequest(validBody), ctx);
    expect(res.status).toBe(429);
  });

  it("returns 400 when SectionId is missing", async () => {
    const res = await handlers.deleteInfoSheetSection(
      makeRequest({ TenantId: 1, BuildingId: 5 }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when TenantId is not finite", async () => {
    const res = await handlers.deleteInfoSheetSection(
      makeRequest({ TenantId: "abc", BuildingId: 5, SectionId: "sec-1" }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when tenant is not found", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.deleteInfoSheetSection(makeRequest(validBody), ctx);
    expect(res.status).toBe(404);
  });

  it("deletes and returns 200 + invalidates cache on the happy path", async () => {
    const existing = JSON.stringify([
      { id: "sec-1", title: "One", displayOrder: 0, rows: [] },
      { id: "sec-2", title: "Two", displayOrder: 1, rows: [] },
    ]);
    db.executeQuery
      .mockResolvedValueOnce([{ InfoSheetSections: existing }])
      .mockResolvedValueOnce([]);

    const res = await handlers.deleteInfoSheetSection(makeRequest(validBody), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ deleted: true, sectionId: "sec-1" });
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
  });

  it("returns 500 when the UPDATE throws", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ InfoSheetSections: "[]" }])
      .mockRejectedValueOnce(new Error("locked"));
    const res = await handlers.deleteInfoSheetSection(makeRequest(validBody), ctx);
    expect(res.status).toBe(500);
  });
});

// ── upsertInfoSheetRow ───────────────────────────────────────────────────────

describe("upsertInfoSheetRow", () => {
  const validBody = {
    TenantId: 1,
    BuildingId: 5,
    SectionId: "sec-1",
    Row: { id: "row-1", subheader: "Sub", body: "Body", displayOrder: 0 },
  };

  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.upsertInfoSheetRow(makeRequest(validBody), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.upsertInfoSheetRow(makeRequest(validBody), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate-limited", async () => {
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    const res = await handlers.upsertInfoSheetRow(makeRequest(validBody), ctx);
    expect(res.status).toBe(429);
  });

  it("returns 400 when SectionId is missing", async () => {
    const res = await handlers.upsertInfoSheetRow(
      makeRequest({ TenantId: 1, BuildingId: 5, Row: { id: "row-1" } }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when Row.id is missing", async () => {
    const res = await handlers.upsertInfoSheetRow(
      makeRequest({ TenantId: 1, BuildingId: 5, SectionId: "sec-1", Row: {} }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when tenant is not found", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.upsertInfoSheetRow(makeRequest(validBody), ctx);
    expect(res.status).toBe(404);
  });

  it("upserts and returns 200 + invalidates cache on the happy path", async () => {
    const existing = JSON.stringify([
      { id: "sec-1", title: "One", displayOrder: 0, rows: [] },
    ]);
    db.executeQuery
      .mockResolvedValueOnce([{ InfoSheetSections: existing }])
      .mockResolvedValueOnce([]);

    const res = await handlers.upsertInfoSheetRow(makeRequest(validBody), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { sections: Array<{ id: string; rows: Array<{ id: string }> }> };
    expect(body.sections[0].rows).toHaveLength(1);
    expect(body.sections[0].rows[0].id).toBe("row-1");
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
  });

  it("returns 500 when the SELECT throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("boom"));
    const res = await handlers.upsertInfoSheetRow(makeRequest(validBody), ctx);
    expect(res.status).toBe(500);
  });
});

// ── deleteInfoSheetRow ───────────────────────────────────────────────────────

describe("deleteInfoSheetRow", () => {
  const validBody = {
    TenantId: 1,
    BuildingId: 5,
    SectionId: "sec-1",
    RowId: "row-1",
  };

  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.deleteInfoSheetRow(makeRequest(validBody), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.deleteInfoSheetRow(makeRequest(validBody), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate-limited", async () => {
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    const res = await handlers.deleteInfoSheetRow(makeRequest(validBody), ctx);
    expect(res.status).toBe(429);
  });

  it("returns 400 when RowId is missing", async () => {
    const res = await handlers.deleteInfoSheetRow(
      makeRequest({ TenantId: 1, BuildingId: 5, SectionId: "sec-1" }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when BuildingId is not finite", async () => {
    const res = await handlers.deleteInfoSheetRow(
      makeRequest({ TenantId: 1, BuildingId: "x", SectionId: "sec-1", RowId: "row-1" }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when tenant is not found", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.deleteInfoSheetRow(makeRequest(validBody), ctx);
    expect(res.status).toBe(404);
  });

  it("deletes and returns 200 + invalidates cache on the happy path", async () => {
    const existing = JSON.stringify([
      {
        id: "sec-1",
        title: "One",
        displayOrder: 0,
        rows: [
          { id: "row-1", subheader: "A", body: "1", displayOrder: 0 },
          { id: "row-2", subheader: "B", body: "2", displayOrder: 1 },
        ],
      },
    ]);
    db.executeQuery
      .mockResolvedValueOnce([{ InfoSheetSections: existing }])
      .mockResolvedValueOnce([]);

    const res = await handlers.deleteInfoSheetRow(makeRequest(validBody), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ deleted: true, sectionId: "sec-1", rowId: "row-1" });
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
  });

  it("returns 500 when the UPDATE throws", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ InfoSheetSections: "[]" }])
      .mockRejectedValueOnce(new Error("locked"));
    const res = await handlers.deleteInfoSheetRow(makeRequest(validBody), ctx);
    expect(res.status).toBe(500);
  });
});

// ── upsertLeaseAdministration ────────────────────────────────────────────────

describe("upsertLeaseAdministration", () => {
  const validBody = {
    TenantId: 1,
    BuildingId: 5,
    LeaseAdministration: {
      leaseDocuments: [],
      otherDocuments: [],
      detailsEntered: [],
      leaseManager: null,
    },
  };

  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.upsertLeaseAdministration(makeRequest(validBody), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.upsertLeaseAdministration(makeRequest(validBody), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate-limited", async () => {
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    const res = await handlers.upsertLeaseAdministration(makeRequest(validBody), ctx);
    expect(res.status).toBe(429);
  });

  it("returns 400 when TenantId is missing", async () => {
    const res = await handlers.upsertLeaseAdministration(
      makeRequest({ BuildingId: 5, LeaseAdministration: {} }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when LeaseAdministration is not an object", async () => {
    const res = await handlers.upsertLeaseAdministration(
      makeRequest({ TenantId: 1, BuildingId: 5, LeaseAdministration: "not-an-object" }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when tenant is not found", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.upsertLeaseAdministration(makeRequest(validBody), ctx);
    expect(res.status).toBe(404);
  });

  it("upserts and returns 200 + invalidates cache on the happy path", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ TenantId: 1 }])
      .mockResolvedValueOnce([]);

    const res = await handlers.upsertLeaseAdministration(makeRequest(validBody), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { leaseAdministration: { leaseDocuments: unknown[] } };
    expect(body.leaseAdministration.leaseDocuments).toEqual([]);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
  });

  it("returns 500 when the SELECT throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("db down"));
    const res = await handlers.upsertLeaseAdministration(makeRequest(validBody), ctx);
    expect(res.status).toBe(500);
  });
});

// ── upsertMiscFee ────────────────────────────────────────────────────────────

describe("upsertMiscFee", () => {
  const validFee = {
    id: FEE_ID,
    title: "Cleaning",
    frequency: "monthly",
    baseAmount: 100,
    commencedAt: "2025-01-01",
  };
  const validBody = { TenantId: 1, BuildingId: 5, fee: validFee };

  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.upsertMiscFee(makeRequest(validBody), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.upsertMiscFee(makeRequest(validBody), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate-limited", async () => {
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    const res = await handlers.upsertMiscFee(makeRequest(validBody), ctx);
    expect(res.status).toBe(429);
  });

  it("returns 400 when TenantId is not a positive integer", async () => {
    const res = await handlers.upsertMiscFee(
      makeRequest({ TenantId: 0, BuildingId: 5, fee: validFee }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/TenantId/);
  });

  it("returns 400 when fee.id is not UUID-shaped", async () => {
    const res = await handlers.upsertMiscFee(
      makeRequest({ TenantId: 1, BuildingId: 5, fee: { ...validFee, id: "not-a-uuid" } }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/UUID/);
  });

  it("returns 400 when fee.frequency is invalid", async () => {
    const res = await handlers.upsertMiscFee(
      makeRequest({ TenantId: 1, BuildingId: 5, fee: { ...validFee, frequency: "weekly" } }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/frequency/);
  });

  it("returns 404 when tenant is not found", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.upsertMiscFee(makeRequest(validBody), ctx);
    expect(res.status).toBe(404);
  });

  it("upserts and returns 200 + invalidates cache on the happy path", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ MiscFees: null }])
      .mockResolvedValueOnce([]);

    const res = await handlers.upsertMiscFee(makeRequest(validBody), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { fees: Array<{ id: string }> };
    expect(body.fees).toHaveLength(1);
    expect(body.fees[0].id).toBe(FEE_ID);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
  });

  it("returns 500 when the SELECT throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("db down"));
    const res = await handlers.upsertMiscFee(makeRequest(validBody), ctx);
    expect(res.status).toBe(500);
  });
});

// ── deleteMiscFee ────────────────────────────────────────────────────────────

describe("deleteMiscFee", () => {
  const validBody = { TenantId: 1, BuildingId: 5, feeId: FEE_ID };

  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.deleteMiscFee(makeRequest(validBody), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.deleteMiscFee(makeRequest(validBody), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 429 when rate-limited", async () => {
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    const res = await handlers.deleteMiscFee(makeRequest(validBody), ctx);
    expect(res.status).toBe(429);
  });

  it("returns 400 when feeId is not UUID-shaped", async () => {
    const res = await handlers.deleteMiscFee(
      makeRequest({ TenantId: 1, BuildingId: 5, feeId: "not-a-uuid" }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/UUID/);
  });

  it("returns 400 when BuildingId is not a positive integer", async () => {
    const res = await handlers.deleteMiscFee(
      makeRequest({ TenantId: 1, BuildingId: -1, feeId: FEE_ID }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/BuildingId/);
  });

  it("returns 404 when tenant is not found", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.deleteMiscFee(makeRequest(validBody), ctx);
    expect(res.status).toBe(404);
  });

  it("returns 404 when the fee does not exist in the stored list", async () => {
    const existing = JSON.stringify([
      { id: FEE_ID_2, title: "Other", frequency: "monthly", baseAmount: 50, commencedAt: "2025-01-01" },
    ]);
    db.executeQuery.mockResolvedValueOnce([{ MiscFees: existing }]);

    const res = await handlers.deleteMiscFee(makeRequest(validBody), ctx);
    expect(res.status).toBe(404);
    expect((res.jsonBody as { error: string }).error).toMatch(/Fee not found/);
  });

  it("deletes and returns 200 + invalidates cache on the happy path", async () => {
    const existing = JSON.stringify([
      { id: FEE_ID,   title: "Cleaning", frequency: "monthly", baseAmount: 100, commencedAt: "2025-01-01" },
      { id: FEE_ID_2, title: "Other",    frequency: "monthly", baseAmount: 50,  commencedAt: "2025-01-01" },
    ]);
    db.executeQuery
      .mockResolvedValueOnce([{ MiscFees: existing }])
      .mockResolvedValueOnce([]);

    const res = await handlers.deleteMiscFee(makeRequest(validBody), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { fees: Array<{ id: string }> };
    expect(body.fees).toHaveLength(1);
    expect(body.fees[0].id).toBe(FEE_ID_2);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
  });

  it("returns 500 when the UPDATE throws", async () => {
    const existing = JSON.stringify([
      { id: FEE_ID, title: "Cleaning", frequency: "monthly", baseAmount: 100, commencedAt: "2025-01-01" },
    ]);
    db.executeQuery
      .mockResolvedValueOnce([{ MiscFees: existing }])
      .mockRejectedValueOnce(new Error("locked"));

    const res = await handlers.deleteMiscFee(makeRequest(validBody), ctx);
    expect(res.status).toBe(500);
  });
});
