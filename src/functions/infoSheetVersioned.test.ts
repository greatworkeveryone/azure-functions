/// <reference types="jest" />
// D11 (database-safety rules 6 and 7): info sheet writes run under the tenancy's
// row lock, keep every entry they don't change as stored, never write over a
// column that isn't a JSON array, and move InfoSheetVersion on. A delete names
// the version it was shown (409 when it has moved) and is ledgered with the
// whole sheet as it was.
import { HttpRequest, InvocationContext } from "@azure/functions";

type Handler = (
  req: HttpRequest,
  ctx: InvocationContext,
) => Promise<{ status: number; jsonBody?: unknown; headers?: Record<string, string> }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  type Bag = { __infoSheetHandlers?: Record<string, Handler> };
  const g = globalThis as unknown as Bag;
  g.__infoSheetHandlers = g.__infoSheetHandlers ?? {};
  return {
    ...actual,
    app: {
      ...actual.app,
      http: (name: string, opts: { handler: Handler }): void => {
        (g.__infoSheetHandlers as Record<string, Handler>)[name] = opts.handler;
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
  invalidateTenantAndBuilding: jest.Mock;
};
const rateLimit = require("../rateLimit") as { checkRateLimit: jest.Mock };

// Trigger the module's app.http registrations so the mock above captures
// every handler by name.
require("./tenancy");
const handlers = (globalThis as unknown as { __infoSheetHandlers: Record<string, Handler> }).__infoSheetHandlers;

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
  rateLimit.checkRateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
});

// ── upsertInfoSheetSection ───────────────────────────────────────────────────

const ledger = jest.requireMock("../ledger") as { newCorrelationId: jest.Mock; record: jest.Mock };

const S1 = `{"id":"sec-1","title":"Keys","rows":[{"id":"row-1","subheader":"Spare","body":"Office safe","displayOrder":0},{"id":"row-2","subheader":"Fob","body":"x","displayOrder":1}],"displayOrder":0,"legacyNote":"kept 1.50"}`;
const S2 = `{"id":"sec-2","title":"Contacts","rows":[],"displayOrder":1}`;
const STORED = `[${S1}, ${S2}]`;

let sheet: Record<string, unknown> | null;
beforeEach(() => {
  sheet = { InfoSheetSections: STORED, InfoSheetVersion: 4, UpdatedAt: new Date("2026-10-18T02:00:00Z"), UpdatedByName: "Bea Accounts" };
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/WITH \(UPDLOCK, ROWLOCK\)/.test(sql)) return sheet ? [sheet] : [];
    if (/OUTPUT INSERTED\.InfoSheetVersion/.test(sql)) return [{ InfoSheetVersion: Number(sheet?.InfoSheetVersion ?? 0) + 1 }];
    return [];
  });
});

const calls = () => db.executeQuery.mock.calls.map((c: unknown[]) => ({ params: (c[2] ?? []) as { name: string; value: unknown }[], sql: String(c[1]) }));
const written = () => calls().find((c) => /UPDATE dbo\.Tenants SET/.test(c.sql));
const writtenJson = () => written()?.params.find((p) => p.name === "InfoSheetSections")?.value as string | undefined;

// What each delete puts in the ledger's Before: only the entry removed, and where it was (S3-6).
const SECTION_REMOVED = { position: 0, section: JSON.parse(S1) };
const ROW_REMOVED = { position: 0, row: JSON.parse(S1).rows[0], sectionId: "sec-1", sectionTitle: "Keys" };
const DELETES = [
  ["deleteInfoSheetSection", { BuildingId: 5, SectionId: "sec-1", TenantId: 1 }, "tenancy.info_sheet_section_delete", { sectionId: "sec-1" }, SECTION_REMOVED],
  ["deleteInfoSheetRow", { BuildingId: 5, RowId: "row-1", SectionId: "sec-1", TenantId: 1 }, "tenancy.info_sheet_row_delete", { rowId: "row-1", sectionId: "sec-1" }, ROW_REMOVED],
] as const;

describe.each(DELETES)("%s", (route, body, action, after, before) => {
  const send = (extra: Record<string, unknown> = { InfoSheetVersion: 4 }) => handlers[route](makeRequest({ ...body, ...extra }), ctx);

  it("is the tenancy desk's, and rate-limited", async () => {
    await send();
    expect(auth.requireRole.mock.calls[0][1]).toEqual(["accounts", "accounts_manager", "admin", "director"]);
    auth.extractToken.mockReturnValue(null);
    expect((await send()).status).toBe(401);
    auth.extractToken.mockReturnValue("mock-token");
    auth.requireRole.mockResolvedValue({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await send()).status).toBe(403);
    auth.requireRole.mockResolvedValue(null);
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    expect((await send()).status).toBe(429);
  });

  it.each([{}, { InfoSheetVersion: "4" }, { InfoSheetVersion: -1 }, { InfoSheetVersion: 1.5 }])(
    "needs the version the sheet was shown at (%p → 400), before touching the database",
    async (extra) => {
      expect((await send(extra)).status).toBe(400);
      expect(db.executeQuery).not.toHaveBeenCalled();
    },
  );

  it("refuses a stale write (409) with who changed it, and writes and ledgers nothing", async () => {
    const res = await send({ InfoSheetVersion: 3 });
    expect(res.status).toBe(409);
    expect(res.jsonBody).toEqual({
      conflict: { changedAt: "2026-10-18T02:00:00.000Z", changedBy: "Bea Accounts", infoSheetVersion: 4 },
      error: "This tenancy was changed by Bea Accounts since you opened it. Reload to see their change.",
    });
    expect(written()).toBeUndefined();
    expect(ledger.record).not.toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });

  it.each([['{"id":"sec-1"}'], ['[{"id":"sec-1"'], ["not json"]])("refuses (422) a column holding %p, and writes nothing over it", async (stored) => {
    sheet = { ...sheet, InfoSheetSections: stored };
    const res = await send();
    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: string }).error).toMatch(/can't be changed safely/);
    expect(written()).toBeUndefined();
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("reads the sheet under the tenancy's row lock and writes it with the version moved on, in one transaction", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual(expect.objectContaining({ deleted: true, infoSheetVersion: 5, sectionId: "sec-1" }));
    const locked = calls().find((c) => /WITH \(UPDLOCK, ROWLOCK\)/.test(c.sql));
    expect(locked?.sql).toMatch(/FROM dbo\.Tenants WITH \(UPDLOCK, ROWLOCK\)\s+WHERE TenantId = @TenantId AND BuildingId = @BuildingId/);
    expect(written()?.sql).toMatch(/InfoSheetVersion = InfoSheetVersion \+ 1/);
    expect(db.beginTransaction.mock.invocationCallOrder[0]).toBeLessThan(db.executeQuery.mock.invocationCallOrder[0]);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
  });

  it("keeps the other section exactly as stored", async () => {
    await send();
    expect(writtenJson()).toContain(S2);
  });

  it("ledgers the entry removed, not the whole sheet, before the commit (S3-6)", async () => {
    await send();
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(ledger.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action,
        after,
        before,
        buildingId: 5,
        subject: { id: 1, type: "tenancy" },
        tenantId: 1,
      }),
    );
    expect(ledger.record.mock.invocationCallOrder[0]).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
  });

  it("rolls back when the ledger write fails", async () => {
    ledger.record.mockRejectedValueOnce(new Error("ledger down"));
    expect((await send()).status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("answers 404 for a tenancy that isn't there", async () => {
    sheet = null;
    expect((await send()).status).toBe(404);
    expect(written()).toBeUndefined();
  });
});

describe("the deletes change only what they name", () => {
  it("deleteInfoSheetSection takes the section off and nothing else", async () => {
    await handlers.deleteInfoSheetSection(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, SectionId: "sec-1", TenantId: 1 }), ctx);
    expect(writtenJson()).toBe(`[${S2}]`);
  });

  it("deleteInfoSheetRow takes the row off its section and keeps that section's other fields", async () => {
    await handlers.deleteInfoSheetRow(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, RowId: "row-1", SectionId: "sec-1", TenantId: 1 }), ctx);
    const [first] = JSON.parse(writtenJson() ?? "[]");
    expect(first.rows.map((r: { id: string }) => r.id)).toEqual(["row-2"]);
    expect(first.legacyNote).toBe("kept 1.50");
  });

  it("answers 404 for a section or row no longer there, writing nothing", async () => {
    expect((await handlers.deleteInfoSheetSection(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, SectionId: "gone", TenantId: 1 }), ctx)).status).toBe(404);
    expect((await handlers.deleteInfoSheetRow(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, RowId: "gone", SectionId: "sec-1", TenantId: 1 }), ctx)).status).toBe(404);
    expect(written()).toBeUndefined();
  });
});

const UPSERTS = [
  ["upsertInfoSheetSection", { BuildingId: 5, IsNew: true, Section: { displayOrder: 2, id: "sec-3", rows: [], title: "Parking" }, TenantId: 1 }],
  ["upsertInfoSheetRow", { BuildingId: 5, IsNew: true, Row: { body: "b", displayOrder: 2, id: "row-3", subheader: "New" }, SectionId: "sec-1", TenantId: 1 }],
] as const;

describe.each(UPSERTS)("%s", (route, body) => {
  const send = (extra: Record<string, unknown> = { InfoSheetVersion: 4 }) => handlers[route](makeRequest({ ...body, ...extra }), ctx);

  it.each([{}, { InfoSheetVersion: "4" }, { InfoSheetVersion: -1 }])("needs the version the sheet was shown at (%p → 400), before touching the database", async (extra) => {
    expect((await send(extra)).status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("refuses a stale write (409) with who changed it, and writes nothing (D11 review)", async () => {
    const res = await send({ InfoSheetVersion: 3 });
    expect(res.status).toBe(409);
    expect((res.jsonBody as { error: string }).error).toBe("This tenancy was changed by Bea Accounts since you opened it. Reload to see their change.");
    expect(written()).toBeUndefined();
  });

  it("writes under the row lock at the version shown, moves the version on and returns it", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect((res.jsonBody as { infoSheetVersion: number }).infoSheetVersion).toBe(5);
    expect(calls().some((c) => /WITH \(UPDLOCK, ROWLOCK\)/.test(c.sql))).toBe(true);
    expect(written()?.sql).toMatch(/InfoSheetVersion = InfoSheetVersion \+ 1/);
    expect(writtenJson()).toContain(S2);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("refuses (422) a column that isn't a JSON array instead of saving over it", async () => {
    sheet = { ...sheet, InfoSheetSections: '{"not":"a list"}' };
    expect((await send()).status).toBe(422);
    expect(written()).toBeUndefined();
  });

  it("is not ledgered (only deletes are)", async () => {
    await send();
    expect(ledger.record).not.toHaveBeenCalled();
  });
});

describe("a new entry can say where it goes, for Undo (S2-4)", () => {
  it("upsertInfoSheetRow puts the row at Position", async () => {
    const row = { body: "back", displayOrder: 0, id: "row-back", subheader: "Back" };
    const res = await handlers.upsertInfoSheetRow(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, IsNew: true, Position: 0, Row: row, SectionId: "sec-1", TenantId: 1 }), ctx);
    expect(res.status).toBe(200);
    expect(JSON.parse(writtenJson() ?? "[]")[0].rows.map((r: { id: string }) => r.id)).toEqual(["row-back", "row-1", "row-2"]);
  });

  it("upsertInfoSheetSection puts the section at Position", async () => {
    const section = { displayOrder: 0, id: "sec-back", rows: [], title: "Back" };
    const res = await handlers.upsertInfoSheetSection(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, IsNew: true, Position: 1, Section: section, TenantId: 1 }), ctx);
    expect(res.status).toBe(200);
    expect(JSON.parse(writtenJson() ?? "[]").map((entry: { id: string }) => entry.id)).toEqual(["sec-1", "sec-back", "sec-2"]);
  });

  it.each([[-1], [1.5], ["1"], [null]])("answers 400 for a Position of %p, before touching the database", async (position) => {
    const row = { body: "b", displayOrder: 0, id: "r", subheader: "s" };
    expect((await handlers.upsertInfoSheetRow(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, IsNew: true, Position: position, Row: row, SectionId: "sec-1", TenantId: 1 }), ctx)).status).toBe(400);
    expect((await handlers.upsertInfoSheetSection(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, IsNew: true, Position: position, Section: { displayOrder: 0, id: "s", rows: [], title: "t" }, TenantId: 1 }), ctx)).status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("a stale Undo is refused like any write: 409, nothing put back", async () => {
    const row = { body: "back", displayOrder: 0, id: "row-back", subheader: "Back" };
    const res = await handlers.upsertInfoSheetRow(makeRequest({ BuildingId: 5, InfoSheetVersion: 3, IsNew: true, Position: 0, Row: row, SectionId: "sec-1", TenantId: 1 }), ctx);
    expect(res.status).toBe(409);
    expect(written()).toBeUndefined();
  });
});

// S3-2 (D11 re-check): Undo put an entry back without a trace, so Decisions & exceptions
// still showed a deletion that had been undone. A restore (`Restore: true` on a new entry)
// is ledgered, in the same transaction, as what was put back and where.
describe("Undo is ledgered (S3-2)", () => {
  const row = { body: "Office safe", displayOrder: 0, id: "row-back", subheader: "Spare" };
  const section = { displayOrder: 1, id: "sec-back", rows: [{ body: "x", displayOrder: 0, id: "rb", subheader: "X" }], title: "Parking" };
  const restoreRow = (extra: Record<string, unknown> = {}) =>
    handlers.upsertInfoSheetRow(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, IsNew: true, Position: 0, Restore: true, Row: row, SectionId: "sec-1", TenantId: 1, ...extra }), ctx);
  const restoreSection = (extra: Record<string, unknown> = {}) =>
    handlers.upsertInfoSheetSection(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, IsNew: true, Position: 1, Restore: true, Section: section, TenantId: 1, ...extra }), ctx);
  const ledgered = () => ledger.record.mock.calls.map((call: unknown[]) => call[1] as { action: string; after?: unknown; before?: unknown; correlationId?: string });

  it("a restored row is ledgered with the row and where it went, before the commit", async () => {
    expect((await restoreRow()).status).toBe(200);
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(ledger.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "tenancy.info_sheet_row_restore",
        after: { position: 0, row, sectionId: "sec-1", sectionTitle: "Keys" },
        buildingId: 5,
        subject: { id: 1, type: "tenancy" },
        tenantId: 1,
      }),
    );
    expect(ledgered()[0].before).toBeUndefined();
    expect(ledger.record.mock.invocationCallOrder[0]).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
  });

  it("a restored section is ledgered with the section, its rows and where it went", async () => {
    expect((await restoreSection()).status).toBe(200);
    expect(ledger.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tenancy.info_sheet_section_restore", after: { position: 1, section }, tenantId: 1 }),
    );
  });

  it("records the place it actually went when Position was past the end", async () => {
    await restoreRow({ Position: 99 });
    expect(ledgered()[0].after).toEqual(expect.objectContaining({ position: 2 }));
  });

  it("an ordinary add is still not ledgered: only a restore is", async () => {
    await handlers.upsertInfoSheetRow(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, IsNew: true, Row: row, SectionId: "sec-1", TenantId: 1 }), ctx);
    await handlers.upsertInfoSheetSection(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, IsNew: true, Section: section, TenantId: 1 }), ctx);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it.each([
    ["Restore without IsNew", { IsNew: undefined }],
    ["Restore on an edit (IsNew false)", { IsNew: false }],
    ["Restore that isn't true or false", { Restore: "true" }],
    ["Restore as null", { Restore: null }],
  ])("answers 400 for %s, before touching the database", async (_label, extra) => {
    expect((await restoreRow(extra)).status).toBe(400);
    expect((await restoreSection(extra)).status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("a stale Undo (409) writes nothing and ledgers nothing", async () => {
    expect((await restoreRow({ InfoSheetVersion: 3 })).status).toBe(409);
    expect((await restoreSection({ InfoSheetVersion: 3 })).status).toBe(409);
    expect(written()).toBeUndefined();
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("an Undo that can't be put back (the section is gone, the id is already there) ledgers nothing", async () => {
    expect((await restoreRow({ SectionId: "gone" })).status).toBe(404);
    expect((await restoreRow({ Row: { ...row, id: "row-1" } })).status).toBe(409);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("rolls back, putting nothing back, when the ledger write fails", async () => {
    ledger.record.mockRejectedValueOnce(new Error("ledger down"));
    expect((await restoreRow()).status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("is the tenancy desk's, like the other writes", async () => {
    auth.requireRole.mockResolvedValue({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await restoreRow()).status).toBe(403);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("a restored section too big for one ledger row is split across several, with one correlation id, losing nothing", async () => {
    ledger.newCorrelationId.mockReturnValue("11111111-2222-4333-8444-555555555555");
    const huge = { ...section, rows: [1, 2, 3].map((n) => ({ body: "z".repeat(40_000), displayOrder: n, id: `h${n}`, subheader: "Clause" })) };
    expect((await restoreSection({ Section: huge })).status).toBe(200);
    const rows = ledgered();
    expect(rows.length).toBeGreaterThan(2);
    expect(new Set(rows.map((entry) => entry.correlationId))).toEqual(new Set(["11111111-2222-4333-8444-555555555555"]));
    const parts = rows.map((entry) => entry.after as { json: string; part: number; parts: number });
    expect(JSON.parse(parts.map((part) => part.json).join(""))).toEqual({ position: 1, section: huge });
  });
});

describe("upsertInfoSheetSection on an empty sheet", () => {
  it("starts the list", async () => {
    sheet = { ...sheet, InfoSheetSections: null };
    const section = { displayOrder: 0, id: "sec-9", rows: [], title: "First" };
    const res = await handlers.upsertInfoSheetSection(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, IsNew: true, Section: section, TenantId: 1 }), ctx);
    expect(res.status).toBe(200);
    expect(JSON.parse(writtenJson() ?? "null")).toEqual([section]);
  });
});

describe("a screen out of date can't undo a colleague's change (the D11 review's three cases)", () => {
  const upsertSection = (section: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    handlers.upsertInfoSheetSection(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, Section: section, TenantId: 1, ...extra }), ctx);

  it("a rename sent with stale rows keeps the stored rows: the row a colleague added survives", async () => {
    const stale = { ...JSON.parse(S1), rows: [JSON.parse(S1).rows[0]], title: "Keys and fobs" };
    expect((await upsertSection(stale)).status).toBe(200);
    const [first, second] = JSON.parse(writtenJson() ?? "[]");
    expect(first.title).toBe("Keys and fobs");
    expect(first.rows.map((r: { id: string }) => r.id)).toEqual(["row-1", "row-2"]);
    expect(first.legacyNote).toBe("kept 1.50");
    expect(second).toEqual(JSON.parse(S2));
  });

  it("editing a section a colleague deleted answers 404 and doesn't bring it back", async () => {
    const res = await upsertSection({ displayOrder: 5, id: "sec-deleted", rows: [], title: "Old" });
    expect(res.status).toBe(404);
    expect(written()).toBeUndefined();
  });

  it("editing a row a colleague deleted answers 404 and doesn't add it again", async () => {
    const res = await handlers.upsertInfoSheetRow(
      makeRequest({ BuildingId: 5, InfoSheetVersion: 4, Row: { body: "x", displayOrder: 9, id: "row-deleted", subheader: "Gone" }, SectionId: "sec-1", TenantId: 1 }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(written()).toBeUndefined();
  });

  it("a 'new' section or row whose id is already there is a 409, not an overwrite", async () => {
    expect((await upsertSection(JSON.parse(S2), { IsNew: true })).status).toBe(409);
    const row = { body: "y", displayOrder: 0, id: "row-1", subheader: "Spare" };
    expect((await handlers.upsertInfoSheetRow(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, IsNew: true, Row: row, SectionId: "sec-1", TenantId: 1 }), ctx)).status).toBe(409);
    expect(written()).toBeUndefined();
  });
});

// S3-6 (D11 re-check): the whole array was ledgered against a 64 KB cap, so a delete
// on a sheet over 64 KB failed with a 500. Only the removed entry is ledgered now;
// one too big for a ledger row is split across several rows in the same
// transaction, and never refused for size.
describe("deletes on a sheet over 64 KB (S3-6)", () => {
  const bigRow = (id: string, size: number) => ({ body: "x".repeat(size), displayOrder: 0, id, subheader: "Clause" });
  const section = (id: string, rows: unknown[], order = 0) => ({ displayOrder: order, id, rows, title: `Section ${id}` });
  const setSheet = (sections: unknown[]) => {
    sheet = { ...sheet, InfoSheetSections: JSON.stringify(sections) };
  };
  const ledgered = () => ledger.record.mock.calls.map((call: unknown[]) => call[1] as { after?: unknown; before?: unknown; correlationId?: string });
  const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

  it("takes a small section off a 100 KB sheet and ledgers just that section", async () => {
    setSheet([section("big-1", [bigRow("a", 30_000)]), section("big-2", [bigRow("b", 30_000)]), section("big-3", [bigRow("c", 30_000)]), section("small", [bigRow("d", 20)], 3)]);
    const res = await handlers.deleteInfoSheetSection(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, SectionId: "small", TenantId: 1 }), ctx);
    expect(res.status).toBe(200);
    expect(ledgered()).toHaveLength(1);
    expect(bytes(ledgered()[0].before)).toBeLessThan(1000);
    expect(ledgered()[0].before).toEqual({ position: 3, section: section("small", [bigRow("d", 20)], 3) });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("takes a small row off a section that holds 100 KB and ledgers just that row", async () => {
    setSheet([section("s", [bigRow("a", 40_000), bigRow("b", 40_000), bigRow("small", 10), bigRow("c", 40_000)])]);
    const res = await handlers.deleteInfoSheetRow(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, RowId: "small", SectionId: "s", TenantId: 1 }), ctx);
    expect(res.status).toBe(200);
    expect(ledgered()).toHaveLength(1);
    expect(ledgered()[0].before).toEqual({ position: 2, row: bigRow("small", 10), sectionId: "s", sectionTitle: "Section s" });
  });

  it("a section too big for one ledger row is logged across several, in the same transaction, losing no text", async () => {
    const huge = section("huge", [bigRow("a", 40_000), bigRow("b", 40_000), bigRow("c", 40_000)], 1);
    setSheet([section("first", []), huge]);
    ledger.newCorrelationId.mockReturnValue("11111111-2222-4333-8444-555555555555");
    const res = await handlers.deleteInfoSheetSection(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, SectionId: "huge", TenantId: 1 }), ctx);
    expect(res.status).toBe(200);

    const rows = ledgered();
    expect(rows.length).toBeGreaterThan(2);
    expect(new Set(rows.map((row) => row.correlationId))).toEqual(new Set(["11111111-2222-4333-8444-555555555555"]));
    for (const row of rows) expect(bytes(row.before)).toBeLessThanOrEqual(64 * 1024);
    const parts = rows.map((row) => row.before as { json: string; part: number; parts: number });
    expect(parts.map((part) => part.part)).toEqual(parts.map((_part, index) => index + 1));
    expect(new Set(parts.map((part) => part.parts))).toEqual(new Set([rows.length]));
    expect(JSON.parse(parts.map((part) => part.json).join(""))).toEqual({ position: 1, section: huge });
    expect(ledger.record.mock.invocationCallOrder.at(-1)).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
    expect(writtenJson()).toBe(JSON.stringify([section("first", [])]));
  });

  it("rolls back, removing nothing, when any part of a split ledger entry fails", async () => {
    setSheet([section("huge", [bigRow("a", 40_000), bigRow("b", 40_000)])]);
    ledger.record.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("ledger down"));
    const res = await handlers.deleteInfoSheetSection(makeRequest({ BuildingId: 5, InfoSheetVersion: 4, SectionId: "huge", TenantId: 1 }), ctx);
    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });
});
