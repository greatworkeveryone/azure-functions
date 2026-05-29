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
});

// ── deleteOccupancy ─────────────────────────────────────────────────────────

describe("deleteOccupancy", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.deleteOccupancy(makeRequest({ OccupancyId: "occ-1" }), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.deleteOccupancy(makeRequest({ OccupancyId: "occ-1" }), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 400 when OccupancyId is missing", async () => {
    const res = await handlers.deleteOccupancy(makeRequest({}), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/OccupancyId/);
  });

  it("returns 400 when OccupancyId is not a string", async () => {
    const res = await handlers.deleteOccupancy(makeRequest({ OccupancyId: 1 }), ctx);
    expect(res.status).toBe(400);
  });

  it("deletes an occupancy and invalidates the tenant+building cache on the happy path", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ TenantId: 1, BuildingId: 5 }])
      .mockResolvedValueOnce([]);

    const res = await handlers.deleteOccupancy(makeRequest({ OccupancyId: "occ-1" }), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { deleted: boolean; occupancyId: string };
    expect(body.deleted).toBe(true);
    expect(body.occupancyId).toBe("occ-1");
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);

    const deleteCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("DELETE FROM dbo.TenantOccupancies"),
    );
    expect(deleteCall).toBeDefined();
  });

  it("still returns 200 (and skips cache invalidation) when the occupancy did not exist", async () => {
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await handlers.deleteOccupancy(makeRequest({ OccupancyId: "missing-occ" }), ctx);
    expect(res.status).toBe(200);
    expect(cache.invalidateTenantAndBuilding).not.toHaveBeenCalled();
  });

  it("returns 500 when DELETE throws", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ TenantId: 1, BuildingId: 5 }])
      .mockRejectedValueOnce(new Error("locked"));
    const res = await handlers.deleteOccupancy(makeRequest({ OccupancyId: "occ-1" }), ctx);
    expect(res.status).toBe(500);
  });
});

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

// ── deleteTenantNote ────────────────────────────────────────────────────────

describe("deleteTenantNote", () => {
  it("returns 401 when no token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await handlers.deleteTenantNote(makeRequest({ NoteId: "note-1" }), ctx);
    expect(res.status).toBe(401);
  });

  it("returns 403 when role check fails", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handlers.deleteTenantNote(makeRequest({ NoteId: "note-1" }), ctx);
    expect(res.status).toBe(403);
  });

  it("returns 400 when NoteId is missing", async () => {
    const res = await handlers.deleteTenantNote(makeRequest({}), ctx);
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/NoteId/);
  });

  it("returns 400 when NoteId is not a string", async () => {
    const res = await handlers.deleteTenantNote(makeRequest({ NoteId: 42 }), ctx);
    expect(res.status).toBe(400);
  });

  it("deletes a note and invalidates the tenant cache on the happy path", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ TenantId: 7 }])
      .mockResolvedValueOnce([]);

    const res = await handlers.deleteTenantNote(makeRequest({ NoteId: "note-1" }), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as { deleted: boolean; noteId: string };
    expect(body.deleted).toBe(true);
    expect(body.noteId).toBe("note-1");
    expect(cache.invalidateTenant).toHaveBeenCalledWith(7);

    const deleteCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("DELETE FROM dbo.TenantNotes"),
    );
    expect(deleteCall).toBeDefined();
  });

  it("returns 200 without cache invalidation when the note did not exist", async () => {
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await handlers.deleteTenantNote(makeRequest({ NoteId: "missing" }), ctx);
    expect(res.status).toBe(200);
    expect(cache.invalidateTenant).not.toHaveBeenCalled();
  });

  it("returns 500 when DELETE throws", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ TenantId: 7 }])
      .mockRejectedValueOnce(new Error("locked"));
    const res = await handlers.deleteTenantNote(makeRequest({ NoteId: "note-1" }), ctx);
    expect(res.status).toBe(500);
  });
});
