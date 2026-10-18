/// <reference types="jest" />
// D10 (database-safety rule 1): a tenancy's areas and car parks are archived —
// stamped, reasoned, ledgered and reversible — never hard-deleted.
import { HttpRequest, InvocationContext } from "@azure/functions";

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status: number; jsonBody?: any }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  const g = globalThis as unknown as { __d10Handlers?: Record<string, Handler> };
  g.__d10Handlers = g.__d10Handlers ?? {};
  return {
    ...actual,
    app: { ...actual.app, http: (name: string, opts: { handler: Handler }) => void ((g.__d10Handlers as Record<string, Handler>)[name] = opts.handler), timer: jest.fn() },
  };
});
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("tok"),
  requireRole: jest.fn().mockResolvedValue(null),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "ann@rp", name: "Ann Accounts", oid: "ann-oid" }),
}));
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../tenant-register-cache", () => ({
  getCachedTenantDetail: jest.fn().mockReturnValue(null),
  getCachedTenantList: jest.fn().mockReturnValue(null),
  invalidateTenant: jest.fn(),
  invalidateTenantAndBuilding: jest.fn(),
  setCachedTenantDetail: jest.fn(),
  setCachedTenantList: jest.fn(),
}));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../ledger");
jest.mock("../ledger/actor", () => ({
  resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Ann Accounts", role: "accounts_manager", userId: 7 }),
}));

import { AppRole } from "../auth";

const auth = jest.requireMock("../auth") as { requireRole: jest.Mock };
const db = jest.requireMock("../db") as Record<"beginTransaction" | "commitTransaction" | "executeQuery" | "rollbackTransaction", jest.Mock>;
const cache = jest.requireMock("../tenant-register-cache") as { invalidateTenantAndBuilding: jest.Mock };
const ledger = jest.requireMock("../ledger") as { record: jest.Mock };

require("./tenancy");
require("./tenancyPartsArchive");
const handlers = (globalThis as unknown as { __d10Handlers: Record<string, Handler> }).__d10Handlers;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ headers: { get: () => null }, json: async () => body, query: new URLSearchParams() }) as unknown as HttpRequest;

let part: Record<string, unknown> | null;
beforeEach(() => {
  jest.clearAllMocks();
  auth.requireRole.mockResolvedValue(null);
  part = { ArchivedAt: null, BuildingId: 3, Label: "L2 / Suite 4", TenantId: 7 };
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (/WITH \(UPDLOCK, HOLDLOCK\)/.test(sql) ? (part ? [part] : []) : []));
});

const sqlOf = (pattern: RegExp) => db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1])).find((sql: string) => pattern.test(sql)) ?? "";
const ran = (pattern: RegExp) => sqlOf(pattern) !== "";

const KINDS = [
  { archive: "archiveOccupancy", body: { OccupancyId: "occ-1" }, id: "occ-1", kind: "occupancy", restore: "unarchiveOccupancy", table: "TenantOccupancies", where: "OccupancyId = @Id" },
  { archive: "archiveCarpark", body: { CarparkId: "cp-1" }, id: "cp-1", kind: "carpark", restore: "unarchiveCarpark", table: "Carparks", where: "CarparkId = @Id" },
] as const;

describe.each(KINDS)("$kind: archive and restore", ({ archive, body, id, kind, restore, table, where }) => {
  it("are for the roles that held the delete (accounts, accounts_manager, director, admin; cfo through the hierarchy)", async () => {
    await handlers[archive](post({ ...body, Reason: "Area merged into Suite 5" }), ctx);
    await handlers[restore](post({ ...body, Reason: "Archived by mistake" }), ctx);
    const roles = [AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR];
    expect(auth.requireRole.mock.calls.map((c: unknown[]) => c[1])).toEqual([roles, roles]);
    auth.requireRole.mockResolvedValue({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await handlers[archive](post({ ...body, Reason: "x" }), ctx)).status).toBe(403);
  });

  it.each([{}, { Reason: "   " }])("need a reason (%p → 400) before touching the database", async (extra) => {
    expect((await handlers[archive](post({ ...body, ...extra }), ctx)).status).toBe(400);
    expect((await handlers[restore](post({ ...body, ...extra }), ctx)).status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("archive reads the row under lock, stamps who, when and why, and ledgers it, all in one transaction", async () => {
    const res = await handlers[archive](post({ ...body, Reason: "Area merged into Suite 5" }), ctx);
    expect(res.status).toBe(200);
    expect(sqlOf(new RegExp(`FROM dbo\\.${table} \\w+ WITH \\(UPDLOCK, HOLDLOCK\\)`))).toMatch(new RegExp(where.replace(/[@]/g, "@")));
    const update = sqlOf(new RegExp(`UPDATE dbo\\.${table} SET ArchivedAt = SYSUTCDATETIME\\(\\)`));
    expect(update).toMatch(/ArchivedBy = @By, ArchiveReason = @Reason/);
    expect(update).toMatch(new RegExp(`WHERE ${where} AND ArchivedAt IS NULL`));
    expect(ledger.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: `${kind}.archive`, buildingId: 3, reason: "Area merged into Suite 5", subject: { id, type: kind }, tenantId: 7 }),
    );
    expect(db.beginTransaction.mock.invocationCallOrder[0]).toBeLessThan(ledger.record.mock.invocationCallOrder[0]);
    expect(ledger.record.mock.invocationCallOrder[0]).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(7, 3);
  });

  it("archive answers 404 for a missing row and 409 for one already archived, writing nothing", async () => {
    part = null;
    expect((await handlers[archive](post({ ...body, Reason: "x" }), ctx)).status).toBe(404);
    part = { ArchivedAt: new Date(), BuildingId: 3, Label: "L2 / Suite 4", TenantId: 7 };
    expect((await handlers[archive](post({ ...body, Reason: "x" }), ctx)).status).toBe(409);
    expect(ran(/UPDATE dbo\./)).toBe(false);
    expect(ledger.record).not.toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("restore clears the stamp and ledgers it; 409 when it isn't archived", async () => {
    part = { ArchivedAt: new Date(), BuildingId: 3, Label: "L2 / Suite 4", TenantId: 7 };
    expect((await handlers[restore](post({ ...body, Reason: "Archived by mistake" }), ctx)).status).toBe(200);
    expect(sqlOf(new RegExp(`UPDATE dbo\\.${table} SET ArchivedAt = NULL, ArchivedBy = NULL, ArchiveReason = NULL`))).toMatch(
      new RegExp(`WHERE ${where} AND ArchivedAt IS NOT NULL`),
    );
    expect(ledger.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: `${kind}.unarchive`, reason: "Archived by mistake" }));
    jest.clearAllMocks();
    part = { ArchivedAt: null, BuildingId: 3, Label: "L2 / Suite 4", TenantId: 7 };
    expect((await handlers[restore](post({ ...body, Reason: "x" }), ctx)).status).toBe(409);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("rolls back when the ledger write fails", async () => {
    ledger.record.mockRejectedValueOnce(new Error("ledger down"));
    expect((await handlers[archive](post({ ...body, Reason: "x" }), ctx)).status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});

describe("the hard deletes are gone", () => {
  it.each(["deleteOccupancy", "deleteCarpark"])("%s is no longer a route", (name) => {
    expect(handlers[name]).toBeUndefined();
  });
});

describe("an archived area or bay is not quietly reused", () => {
  it("upsertOccupancy onto an archived area's cell answers 409 and writes nothing", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/SELECT RentPerAnnum FROM dbo\.Tenants/.test(sql)) return [{ RentPerAnnum: 0 }];
      if (/FROM dbo\.TenantOccupancies o WITH \(UPDLOCK, ROWLOCK\)/.test(sql)) {
        return [{ ArchivedAt: new Date(), LegalName: "Acme Pty Ltd", OccupancyId: "occ-1", TenantId: 7, TradingName: null }];
      }
      return [];
    });
    const res = await handlers.upsertOccupancy(
      post({ Area: "Suite 4", BuildingId: 3, Level: "L2", OccupancyId: "occ-new", SizeSqm: 100, TenantId: 7 }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(res.jsonBody.code).toBe("OCCUPANCY_ARCHIVED");
    expect(res.jsonBody.error).toMatch(/archived/i);
    expect(ran(/INSERT INTO dbo\.TenantOccupancies|UPDATE dbo\.TenantOccupancies/)).toBe(false);
  });

  it("upsertCarpark onto an archived bay answers 409 and writes nothing", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      /FROM dbo\.Carparks\s+WHERE CarparkId = @Id/.test(sql) ? [{ ArchivedAt: new Date(), CarparkId: "cp-1" }] : [],
    );
    const res = await handlers.upsertCarpark(
      post({ AllocationKind: "vacant", BuildingId: 3, CarparkId: "cp-new", Identifier: "B12", Type: "basement" }),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(res.jsonBody.code).toBe("CARPARK_ARCHIVED");
    expect(ran(/INSERT INTO dbo\.Carparks|UPDATE dbo\.Carparks/)).toBe(false);
  });
});
