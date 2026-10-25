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

// ── upsertOccupancy ─────────────────────────────────────────────────────────

describe("upsertOccupancy", () => {
  const validBody = {
    OccupancyId: "occ-uuid-1",
    TenantId: 1,
    BuildingId: 5,
    Level: "G",
    Area: "A1",
    SizeSqm: 100,
    Notes: "ground floor unit",
  };

  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.upsertOccupancy(makeRequest(validBody), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.upsertOccupancy(makeRequest(validBody), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 400 when OccupancyId is missing", async () => {
    const res = await handlers.upsertOccupancy(
      makeRequest({ ...validBody, OccupancyId: undefined }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/OccupancyId/);
  });

  it("returns 400 when OccupancyId is empty string", async () => {
    const res = await handlers.upsertOccupancy(
      makeRequest({ ...validBody, OccupancyId: "" }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when TenantId is not a number", async () => {
    const res = await handlers.upsertOccupancy(
      makeRequest({ ...validBody, TenantId: "1" }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/TenantId \+ BuildingId/);
  });

  it("returns 400 when BuildingId is missing", async () => {
    const res = await handlers.upsertOccupancy(
      makeRequest({ ...validBody, BuildingId: undefined }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when Level is not a string", async () => {
    const res = await handlers.upsertOccupancy(
      makeRequest({ ...validBody, Level: 1 }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/Level \+ Area/);
  });

  it("returns 400 when SizeSqm is not a number", async () => {
    const res = await handlers.upsertOccupancy(
      makeRequest({ ...validBody, SizeSqm: "100" }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/SizeSqm/);
  });

  it("returns 404 when tenant does not exist", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    const res = await handlers.upsertOccupancy(makeRequest(validBody), ctx);
    expect(res.status).toBe(404);
    expect((res.jsonBody as { error: string }).error).toMatch(/Tenant not found/);
  });

  it("inserts a new occupancy on the happy path when none exists at the cell", async () => {
    db.executeQuery
      // SELECT tenant rent
      .mockResolvedValueOnce([{ RentPerAnnum: 50000 }])
      // SELECT existing occupancy
      .mockResolvedValueOnce([])
      // INSERT occupancy
      .mockResolvedValueOnce([])
      // INSERT history
      .mockResolvedValueOnce([])
      // SELECT stored
      .mockResolvedValueOnce([
        {
          OccupancyId: "occ-uuid-1",
          TenantId: 1,
          BuildingId: 5,
          Level: "G",
          Area: "A1",
          SizeSqm: 100,
          Notes: "ground floor unit",
        },
      ]);

    const res = await handlers.upsertOccupancy(makeRequest(validBody), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { occupancy: { occupancyId: string } };
    expect(body.occupancy.occupancyId).toBe("occ-uuid-1");
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
    expect(db.commitTransaction).toHaveBeenCalled();

    const insertCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("INSERT INTO dbo.TenantOccupancies"),
    );
    expect(insertCall).toBeDefined();
  });

  it("dates the occupancy history on the Darwin calendar, not UTC", async () => {
    // 20:00 UTC on 18 Oct is 05:30 on 19 Oct in Darwin.
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"], now: new Date("2026-10-18T20:00:00Z") });
    try {
      db.executeQuery.mockResolvedValue([]);
      db.executeQuery.mockResolvedValueOnce([{ RentPerAnnum: 50000 }]);
      await handlers.upsertOccupancy(makeRequest(validBody), ctx);
      const history = db.executeQuery.mock.calls.find(([, sql]: [unknown, string]) => sql.includes("INSERT INTO dbo.TenantOccupancyHistory"));
      const params = history?.[2] as Array<{ name: string; value: unknown }>;
      expect(params.find((p) => p.name === "EffectiveFrom")?.value).toBe("2026-10-19");
    } finally {
      jest.useRealTimers();
    }
  });

  it("updates an existing occupancy when one matches the cell key", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ RentPerAnnum: 50000 }])
      .mockResolvedValueOnce([{ OccupancyId: "existing-occ-id", TenantId: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          OccupancyId: "existing-occ-id",
          TenantId: 1,
          BuildingId: 5,
          Level: "G",
          Area: "A1",
          SizeSqm: 100,
          Notes: null,
        },
      ]);

    const res = await handlers.upsertOccupancy(makeRequest(validBody), ctx);
    expect(res.status).toBe(200);
    const updateCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("UPDATE dbo.TenantOccupancies"),
    );
    expect(updateCall).toBeDefined();
    expect(db.commitTransaction).toHaveBeenCalled();
  });

  it("rolls back the transaction when the INSERT throws", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ RentPerAnnum: 50000 }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("constraint violated"));

    const res = await handlers.upsertOccupancy(makeRequest(validBody), ctx);
    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });

  it("returns 500 when the initial tenant SELECT throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("connection lost"));
    const res = await handlers.upsertOccupancy(makeRequest(validBody), ctx);
    expect(res.status).toBe(500);
  });

  // ── A cell held by another tenancy (PLAN WP23a, F22d) ─────────────────────

  const heldByOther = { LegalName: "Other Pty Ltd", OccupancyId: "other-occ", TenantId: 2, TradingName: "Other Co" };
  const storedOcc = [{ Area: "A1", BuildingId: 5, Level: "G", OccupancyId: "other-occ", SizeSqm: 100, TenantId: 1 }];
  const ledger = require("../ledger") as { record: jest.Mock };
  const sqlCalls = () => db.executeQuery.mock.calls.map(([, sql]: [unknown, string]) => sql);

  it("returns 409 naming the tenancy that holds the cell, and moves nothing", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ RentPerAnnum: 50000 }])
      .mockResolvedValueOnce([heldByOther]);
    const res = await handlers.upsertOccupancy(makeRequest(validBody), ctx);
    expect(res.status).toBe(409);
    const body = res.jsonBody as { error: string; heldBy: { name: string; tenantId: number } };
    expect(body.error).toMatch(/held by Other Co/);
    expect(body.heldBy).toMatchObject({ name: "Other Co", tenantId: 2 });
    expect(sqlCalls().some((sql) => sql.includes("UPDATE dbo.TenantOccupancies"))).toBe(false);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("reads the cell under an update lock", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ RentPerAnnum: 50000 }])
      .mockResolvedValueOnce([heldByOther]);
    await handlers.upsertOccupancy(makeRequest(validBody), ctx);
    expect(sqlCalls()[1]).toMatch(/TenantOccupancies o WITH \(UPDLOCK, ROWLOCK\)/);
  });

  it("returns 409 when moving an area onto a cell another row holds", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ RentPerAnnum: 50000 }])
      .mockResolvedValueOnce([
        { LegalName: "Acme", OccupancyId: "occ-uuid-1", TenantId: 1, TradingName: null },
        { LegalName: "Acme", OccupancyId: "acme-other", TenantId: 1, TradingName: null },
      ]);
    const res = await handlers.upsertOccupancy(makeRequest(validBody), ctx);
    expect(res.status).toBe(409);
    expect((res.jsonBody as { heldBy: { occupancyId: string } }).heldBy.occupancyId).toBe("acme-other");
  });

  it("'Move from {tenant}' with a reason reassigns the cell and ledgers occupancy.reassign", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ RentPerAnnum: 50000 }])
      .mockResolvedValueOnce([heldByOther])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedOcc);
    const res = await handlers.upsertOccupancy(
      makeRequest({ ...validBody, Reassign: { FromTenantId: 2, Reason: "Surrendered to Acme from 1 Oct" } }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(sqlCalls().some((sql) => sql.includes("UPDATE dbo.TenantOccupancies"))).toBe(true);
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(ledger.record.mock.calls[0][1]).toMatchObject({
      action: "occupancy.reassign",
      after: { tenantId: 1 },
      before: { tenantId: 2, tenantName: "Other Co" },
      buildingId: 5,
      reason: "Surrendered to Acme from 1 Oct",
      subject: { id: "other-occ", type: "occupancy" },
      tenantId: 1,
    });
    const order = (fn: jest.Mock) => fn.mock.invocationCallOrder[0];
    expect(order(ledger.record)).toBeLessThan(order(db.commitTransaction));
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(2, 5);
  });

  it("refuses a reassign that names a different holder", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ RentPerAnnum: 50000 }])
      .mockResolvedValueOnce([heldByOther]);
    const res = await handlers.upsertOccupancy(
      makeRequest({ ...validBody, Reassign: { FromTenantId: 99, Reason: "wrong tenant" } }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("returns 400 for a reassign without a reason", async () => {
    const res = await handlers.upsertOccupancy(
      makeRequest({ ...validBody, Reassign: { FromTenantId: 2, Reason: "  " } }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

// ── deleteOccupancy ─────────────────────────────────────────────────────────

// deleteOccupancy is gone: areas and car parks are archived, never deleted (D10, tenancyPartsArchive.test.ts).

// ── createTenantNote ────────────────────────────────────────────────────────

describe("createTenantNote", () => {
  const validBody = {
    NoteId: "note-uuid-1",
    TenantId: 1,
    AnchorKind: "tenant",
    Body: "Note body",
  };

  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.createTenantNote(makeRequest(validBody), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.createTenantNote(makeRequest(validBody), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 400 when NoteId is missing", async () => {
    const res = await handlers.createTenantNote(
      makeRequest({ ...validBody, NoteId: undefined }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/NoteId/);
  });

  it("returns 400 when NoteId is empty", async () => {
    const res = await handlers.createTenantNote(
      makeRequest({ ...validBody, NoteId: "" }),
      ctx,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when TenantId is missing", async () => {
    const res = await handlers.createTenantNote(
      makeRequest({ ...validBody, TenantId: undefined }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/TenantId/);
  });

  it("returns 400 when AnchorKind is invalid", async () => {
    const res = await handlers.createTenantNote(
      makeRequest({ ...validBody, AnchorKind: "bogus" }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/AnchorKind/);
  });

  it("returns 400 when AnchorKind is 'occupancy' but OccupancyId is missing", async () => {
    const res = await handlers.createTenantNote(
      makeRequest({ ...validBody, AnchorKind: "occupancy" }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/OccupancyId/);
  });

  it("returns 400 when AnchorKind is 'field' but FieldKey is missing", async () => {
    const res = await handlers.createTenantNote(
      makeRequest({ ...validBody, AnchorKind: "field" }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/FieldKey/);
  });

  it("returns 400 when Body is blank/whitespace", async () => {
    const res = await handlers.createTenantNote(
      makeRequest({ ...validBody, Body: "   " }),
      ctx,
    );
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/Body/);
  });

  it("creates a tenant-anchored note on the happy path", async () => {
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          NoteId: "note-uuid-1",
          TenantId: 1,
          AnchorKind: "tenant",
          OccupancyId: null,
          FieldKey: null,
          Body: "Note body",
          CreatedById: "caller-oid-123",
          CreatedByName: "Unknown user",
        },
      ]);

    const res = await handlers.createTenantNote(makeRequest(validBody), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { note: { noteId: string; tenantId: number } };
    expect(body.note.noteId).toBe("note-uuid-1");
    expect(body.note.tenantId).toBe(1);
    expect(cache.invalidateTenant).toHaveBeenCalledWith(1);

    const insertCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("INSERT INTO dbo.TenantNotes"),
    );
    expect(insertCall).toBeDefined();
  });

  it("creates an occupancy-anchored note when OccupancyId is supplied", async () => {
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          NoteId: "note-uuid-2",
          TenantId: 1,
          AnchorKind: "occupancy",
          OccupancyId: "occ-1",
          FieldKey: null,
          Body: "occ note",
          CreatedById: "caller-oid-123",
          CreatedByName: "Unknown user",
        },
      ]);

    const res = await handlers.createTenantNote(
      makeRequest({ ...validBody, NoteId: "note-uuid-2", AnchorKind: "occupancy", OccupancyId: "occ-1", Body: "occ note" }),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(cache.invalidateTenant).toHaveBeenCalledWith(1);
  });

  it("returns 500 when INSERT throws", async () => {
    db.executeQuery.mockRejectedValueOnce(new Error("FK violation"));
    const res = await handlers.createTenantNote(makeRequest(validBody), ctx);
    expect(res.status).toBe(500);
  });
});

// deleteTenantNote is gone: notes are archived (D11, tenantNotesArchive.test.ts).
