/// <reference types="jest" />
// S2-3 (D11 re-check): a bulk add of info sheet rows is ONE write. All the rows go
// in under one row lock, one version check and one transaction, so a stale screen
// gets a 409 with nothing written, a retry can't add them twice, and a long paste
// is one request against the 60 writes a minute, not one per row.
import { HttpRequest, InvocationContext } from "@azure/functions";

type Handler = (
  req: HttpRequest,
  ctx: InvocationContext,
) => Promise<{ status: number; jsonBody?: unknown; headers?: Record<string, string> }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  type Bag = { __bulkHandlers?: Record<string, Handler> };
  const g = globalThis as unknown as Bag;
  g.__bulkHandlers = g.__bulkHandlers ?? {};
  return {
    ...actual,
    app: {
      ...actual.app,
      http: (name: string, opts: { handler: Handler }): void => {
        (g.__bulkHandlers as Record<string, Handler>)[name] = opts.handler;
      },
    },
  };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    oidFromToken: jest.fn().mockReturnValue("caller-oid-123"),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    errorResponse: jest.fn().mockImplementation((msg: string, detail: string) => ({ status: 500, jsonBody: { error: msg, detail } })),
  };
});

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../tenant-register-cache", () => ({ invalidateTenantAndBuilding: jest.fn() }));
jest.mock("../ledger");
jest.mock("../ledger/actor", () => ({
  resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Test User", role: "accounts", userId: 7 }),
}));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }) }));

const auth = require("../auth") as { extractToken: jest.Mock; requireRole: jest.Mock };
const db = require("../db") as Record<"beginTransaction" | "commitTransaction" | "createRequestConnection" | "executeQuery" | "rollbackTransaction", jest.Mock>;
const cache = require("../tenant-register-cache") as { invalidateTenantAndBuilding: jest.Mock };
const rateLimit = require("../rateLimit") as { checkRateLimit: jest.Mock };
const ledger = jest.requireMock("../ledger") as { newCorrelationId: jest.Mock; record: jest.Mock };

require("./addInfoSheetRows");
const handlers = (globalThis as unknown as { __bulkHandlers: Record<string, Handler> }).__bulkHandlers;
const handler = handlers.addInfoSheetRows;

const makeRequest = (body: unknown): HttpRequest =>
  ({ json: jest.fn().mockResolvedValue(body), query: { get: () => null }, headers: { get: () => null } }) as unknown as HttpRequest;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const S1 = `{"id":"sec-1","title":"Keys","rows":[{"id":"row-1","subheader":"Spare","body":"Office safe","displayOrder":0}],"displayOrder":0,"legacyNote":"kept 1.50"}`;
const S2 = `{"id":"sec-2","title":"Contacts","rows":[],"displayOrder":1}`;
const STORED = `[${S1}, ${S2}]`;

let sheet: Record<string, unknown> | null;
beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  db.createRequestConnection.mockResolvedValue({});
  rateLimit.checkRateLimit.mockReturnValue({ allowed: true, retryAfterMs: 0 });
  sheet = { InfoSheetSections: STORED, InfoSheetVersion: 4, UpdatedAt: new Date("2026-10-18T02:00:00Z"), UpdatedByName: "Bea Accounts" };
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/WITH \(UPDLOCK, ROWLOCK\)/.test(sql)) return sheet ? [sheet] : [];
    if (/OUTPUT INSERTED\.InfoSheetVersion/.test(sql)) return [{ InfoSheetVersion: Number(sheet?.InfoSheetVersion ?? 0) + 1 }];
    return [];
  });
});

const calls = () => db.executeQuery.mock.calls.map((c: unknown[]) => ({ params: (c[2] ?? []) as { name: string; value: unknown }[], sql: String(c[1]) }));
const writes = () => calls().filter((c) => /UPDATE dbo\.Tenants SET/.test(c.sql));
const writtenJson = () => writes()[0]?.params.find((p) => p.name === "InfoSheetSections")?.value as string | undefined;
const row = (id: string, subheader = "S", body = "B") => ({ body, id, subheader });
const send = (extra: Record<string, unknown> = {}) =>
  handler(
    makeRequest({
      Additions: [{ IsNew: false, Rows: [row("r-new-1", "Fob", "Reception"), row("r-new-2", "Pin", "1234")], Section: { id: "sec-1" } }],
      BuildingId: 5,
      InfoSheetVersion: 4,
      TenantId: 1,
      ...extra,
    }),
    ctx,
  );

describe("addInfoSheetRows: who and how often", () => {
  it("is the tenancy desk's, like the other info sheet writes", async () => {
    await send();
    expect(auth.requireRole.mock.calls[0][1]).toEqual(["accounts", "accounts_manager", "admin", "director"]);
    auth.extractToken.mockReturnValue(null);
    expect((await send()).status).toBe(401);
    auth.extractToken.mockReturnValue("mock-token");
    auth.requireRole.mockResolvedValue({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await send()).status).toBe(403);
    expect(db.createRequestConnection).toHaveBeenCalledTimes(1);
  });

  it("is rate limited in the same bucket as the other info sheet writes, and a long paste counts as one write", async () => {
    const many = Array.from({ length: 120 }, (_unused, index) => row(`r${index}`));
    expect((await send({ Additions: [{ IsNew: false, Rows: many, Section: { id: "sec-1" } }] })).status).toBe(200);
    expect(rateLimit.checkRateLimit).toHaveBeenCalledTimes(1);
    expect(rateLimit.checkRateLimit).toHaveBeenCalledWith("infosheet:caller-oid-123", { limit: 60, windowMs: 60_000 });
    rateLimit.checkRateLimit.mockReturnValue({ allowed: false, retryAfterMs: 30000 });
    const refused = await send();
    expect(refused.status).toBe(429);
    expect(refused.headers?.["Retry-After"]).toBe("30");
  });
});

describe("addInfoSheetRows: what it accepts", () => {
  const section = { id: "sec-1" };
  it.each([
    ["no version", { InfoSheetVersion: undefined }],
    ["a version that isn't a whole number", { InfoSheetVersion: "4" }],
    ["no additions", { Additions: [] }],
    ["additions that aren't a list", { Additions: { Rows: [row("a")], Section: section } }],
    ["an addition with no rows", { Additions: [{ IsNew: false, Rows: [], Section: section }] }],
    ["no section id", { Additions: [{ IsNew: false, Rows: [row("a")], Section: {} }] }],
    ["a new section with no title", { Additions: [{ IsNew: true, Rows: [row("a")], Section: { id: "sec-9" } }] }],
    ["a row with no id", { Additions: [{ IsNew: false, Rows: [{ body: "b", subheader: "s" }], Section: section }] }],
    ["a row whose text isn't text", { Additions: [{ IsNew: false, Rows: [{ body: 5, id: "a", subheader: "s" }], Section: section }] }],
    ["a row whose order isn't a whole number", { Additions: [{ IsNew: false, Rows: [{ body: "b", displayOrder: 1.5, id: "a", subheader: "s" }], Section: section }] }],
    ["the same row id twice", { Additions: [{ IsNew: false, Rows: [row("a"), row("a")], Section: section }] }],
    ["the same section twice", { Additions: [{ IsNew: false, Rows: [row("a")], Section: section }, { IsNew: false, Rows: [row("b")], Section: section }] }],
    ["the same row id in two sections", { Additions: [{ IsNew: false, Rows: [row("a")], Section: section }, { IsNew: false, Rows: [row("a")], Section: { id: "sec-2" } }] }],
    ["more than 500 rows", { Additions: [{ IsNew: false, Rows: Array.from({ length: 501 }, (_unused, index) => row(`r${index}`)), Section: section }] }],
    ["no tenancy", { TenantId: "x" }],
  ])("answers 400 for %s, before touching the database", async (_label, extra) => {
    expect((await send(extra)).status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("accepts exactly 500 rows", async () => {
    const rows = Array.from({ length: 500 }, (_unused, index) => row(`r${index}`));
    expect((await send({ Additions: [{ IsNew: false, Rows: rows, Section: { id: "sec-1" } }] })).status).toBe(200);
  });
});

describe("addInfoSheetRows: one write", () => {
  it("adds every row to the section in one UPDATE, under the row lock, at the version shown, in one transaction", async () => {
    const res = await send();
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual(expect.objectContaining({ infoSheetVersion: 5 }));
    expect(writes()).toHaveLength(1);
    expect(calls().find((c) => /WITH \(UPDLOCK, ROWLOCK\)/.test(c.sql))?.sql).toMatch(/FROM dbo\.Tenants WITH \(UPDLOCK, ROWLOCK\)\s+WHERE TenantId = @TenantId AND BuildingId = @BuildingId/);
    expect(writes()[0].sql).toMatch(/InfoSheetVersion = InfoSheetVersion \+ 1/);
    expect(db.beginTransaction.mock.invocationCallOrder[0]).toBeLessThan(db.executeQuery.mock.invocationCallOrder[0]);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
    const [first] = JSON.parse(writtenJson() ?? "[]");
    expect(first.rows.map((r: { id: string }) => r.id)).toEqual(["row-1", "r-new-1", "r-new-2"]);
    expect(first.rows[1]).toEqual({ body: "Reception", displayOrder: 1, id: "r-new-1", subheader: "Fob" });
    expect(first.rows[2].displayOrder).toBe(2);
  });

  it("keeps every other section, and the one it adds to, exactly as stored", async () => {
    await send();
    expect(writtenJson()).toContain(S2);
    expect(JSON.parse(writtenJson() ?? "[]")[0].legacyNote).toBe("kept 1.50");
  });

  it("adds a new section with its first rows, and rows to an existing one, together", async () => {
    const res = await send({
      Additions: [
        { IsNew: false, Rows: [row("a", "Fob")], Section: { id: "sec-2" } },
        { IsNew: true, Rows: [row("b", "Bay 1"), row("c", "Bay 2")], Section: { displayOrder: 2, id: "sec-3", title: "Parking" } },
      ],
    });
    expect(res.status).toBe(200);
    expect(writes()).toHaveLength(1);
    const [, second, third] = JSON.parse(writtenJson() ?? "[]");
    expect(second.rows.map((r: { id: string }) => r.id)).toEqual(["a"]);
    expect(third).toEqual({ displayOrder: 2, id: "sec-3", rows: [{ body: "B", displayOrder: 0, id: "b", subheader: "Bay 1" }, { body: "B", displayOrder: 1, id: "c", subheader: "Bay 2" }], title: "Parking" });
    expect((res.jsonBody as { sections: unknown[] }).sections).toHaveLength(3);
  });

  it("starts an empty sheet with the new section", async () => {
    sheet = { ...sheet, InfoSheetSections: null };
    expect((await send({ Additions: [{ IsNew: true, Rows: [row("a")], Section: { id: "s", title: "First" } }] })).status).toBe(200);
    expect(JSON.parse(writtenJson() ?? "null")).toHaveLength(1);
  });
});

describe("addInfoSheetRows: nothing is written unless all of it is", () => {
  it("a stale version is a 409 naming who changed it, with nothing written or ledgered", async () => {
    const res = await send({ InfoSheetVersion: 3 });
    expect(res.status).toBe(409);
    expect((res.jsonBody as { conflict: unknown }).conflict).toEqual({ changedAt: "2026-10-18T02:00:00.000Z", changedBy: "Bea Accounts", infoSheetVersion: 4 });
    expect(writes()).toHaveLength(0);
    expect(ledger.record).not.toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });

  it("a retry after a save that did go through can't add the rows twice: the version has moved on", async () => {
    expect((await send()).status).toBe(200);
    sheet = { ...sheet, InfoSheetSections: writtenJson(), InfoSheetVersion: 5 };
    const retry = await send();
    expect(retry.status).toBe(409);
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(writtenJson() ?? "[]")[0].rows).toHaveLength(3);
  });

  it("a section a colleague removed is a 404 and none of the other additions are written either", async () => {
    const res = await send({
      Additions: [
        { IsNew: false, Rows: [row("a")], Section: { id: "sec-2" } },
        { IsNew: false, Rows: [row("b")], Section: { id: "gone" } },
      ],
    });
    expect(res.status).toBe(404);
    expect(writes()).toHaveLength(0);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["a row id already in its section", { Additions: [{ IsNew: false, Rows: [row("row-1")], Section: { id: "sec-1" } }] }],
    ["a new section whose id is already there", { Additions: [{ IsNew: true, Rows: [row("a")], Section: { id: "sec-2", title: "Contacts" } }] }],
    ["a row id already in another section", { Additions: [{ IsNew: false, Rows: [row("row-1")], Section: { id: "sec-2" } }] }],
  ])("answers 409 for %s, writing nothing", async (_label, extra) => {
    expect((await send(extra)).status).toBe(409);
    expect(writes()).toHaveLength(0);
  });

  it.each([['{"id":"sec-1"}'], ['[{"id":"sec-1"'], ["not json"]])("refuses (422) a column holding %p, and writes nothing over it", async (stored) => {
    sheet = { ...sheet, InfoSheetSections: stored };
    expect((await send()).status).toBe(422);
    expect(writes()).toHaveLength(0);
  });

  it("answers 404 for a tenancy that isn't there", async () => {
    sheet = null;
    expect((await send()).status).toBe(404);
    expect(writes()).toHaveLength(0);
  });
});

describe("addInfoSheetRows: the ledger keeps only the rows added (S3-6)", () => {
  it("records one entry holding the added rows, not the sheet, before the commit", async () => {
    await send();
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(ledger.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "tenancy.info_sheet_rows_added",
        after: {
          additions: [
            {
              isNew: false,
              rows: [
                { body: "Reception", displayOrder: 1, id: "r-new-1", subheader: "Fob" },
                { body: "1234", displayOrder: 2, id: "r-new-2", subheader: "Pin" },
              ],
              sectionId: "sec-1",
              sectionTitle: "Keys",
            },
          ],
        },
        buildingId: 5,
        subject: { id: 1, type: "tenancy" },
        tenantId: 1,
      }),
    );
    expect(ledger.record.mock.calls[0][1].before).toBeUndefined();
    expect(ledger.record.mock.invocationCallOrder[0]).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
  });

  it("rolls back when the ledger write fails", async () => {
    ledger.record.mockRejectedValueOnce(new Error("ledger down"));
    expect((await send()).status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("adds to a sheet already over 64 KB, ledgering just the new rows", async () => {
    const big = Array.from({ length: 4 }, (_unused, index) => ({ displayOrder: index, id: `big-${index}`, rows: [{ body: "x".repeat(30_000), displayOrder: 0, id: `br-${index}`, subheader: "Clause" }], title: `Big ${index}` }));
    sheet = { ...sheet, InfoSheetSections: JSON.stringify([...big, JSON.parse(S1)]) };
    expect((await send()).status).toBe(200);
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(Buffer.byteLength(JSON.stringify(ledger.record.mock.calls[0][1].after), "utf8")).toBeLessThan(2000);
  });

  it("splits added rows too big for one ledger row across several, with the same correlation id", async () => {
    ledger.newCorrelationId.mockReturnValue("11111111-2222-4333-8444-555555555555");
    const rows = [row("big-1", "A", "y".repeat(40_000)), row("big-2", "B", "z".repeat(40_000))];
    expect((await send({ Additions: [{ IsNew: false, Rows: rows, Section: { id: "sec-1" } }] })).status).toBe(200);
    const entries = ledger.record.mock.calls.map((call: unknown[]) => call[1] as { after: { json: string; part: number; parts: number }; correlationId: string });
    expect(entries.length).toBeGreaterThan(1);
    expect(new Set(entries.map((entry) => entry.correlationId))).toEqual(new Set(["11111111-2222-4333-8444-555555555555"]));
    const joined = JSON.parse(entries.map((entry) => entry.after.json).join(""));
    expect(joined.additions[0].rows.map((r: { id: string }) => r.id)).toEqual(["big-1", "big-2"]);
  });
});
