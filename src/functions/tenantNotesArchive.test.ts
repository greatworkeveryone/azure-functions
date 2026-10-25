/// <reference types="jest" />
// D11 (database-safety rule 1): a tenancy's notes, the change notes written when
// a lease field is edited among them, are archived (stamped, reasoned, ledgered
// and reversible), never hard-deleted.
import { HttpRequest, InvocationContext } from "@azure/functions";

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status: number; jsonBody?: any }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  const g = globalThis as unknown as { __d11Handlers?: Record<string, Handler> };
  g.__d11Handlers = g.__d11Handlers ?? {};
  return {
    ...actual,
    app: { ...actual.app, http: (name: string, opts: { handler: Handler }) => void ((g.__d11Handlers as Record<string, Handler>)[name] = opts.handler), timer: jest.fn() },
  };
});
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("tok"),
  requireRole: jest.fn().mockResolvedValue(null),
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

import { ACTION_ROLES } from "../action-roles";
import { AppRole } from "../auth";

const auth = jest.requireMock("../auth") as { requireRole: jest.Mock };
const db = jest.requireMock("../db") as Record<"beginTransaction" | "commitTransaction" | "executeQuery" | "rollbackTransaction", jest.Mock>;
const cache = jest.requireMock("../tenant-register-cache") as { invalidateTenantAndBuilding: jest.Mock };
const ledger = jest.requireMock("../ledger") as { record: jest.Mock };

require("./tenancy");
require("./tenantNotesArchive");
const handlers = (globalThis as unknown as { __d11Handlers: Record<string, Handler> }).__d11Handlers;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ headers: { get: () => null }, json: async () => body, query: new URLSearchParams() }) as unknown as HttpRequest;
const get = (query: Record<string, string>) =>
  ({ headers: { get: () => null }, json: async () => null, query: new URLSearchParams(query) }) as unknown as HttpRequest;

const LOCKED = /FROM dbo\.TenantNotes n WITH \(UPDLOCK, HOLDLOCK\)/;
let note: Record<string, unknown> | null;
beforeEach(() => {
  jest.clearAllMocks();
  auth.requireRole.mockResolvedValue(null);
  note = { ArchivedAt: null, BuildingId: 3, TenantId: 7 };
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (LOCKED.test(sql) ? (note ? [note] : []) : []));
});

const sqls = () => db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1]));
const sqlOf = (pattern: RegExp) => sqls().find((sql: string) => pattern.test(sql)) ?? "";
const ran = (pattern: RegExp) => sqlOf(pattern) !== "";

describe("archiveTenantNote and unarchiveTenantNote", () => {
  it("are the tenancy desk's, the roles table's editTenancy gate (accounts, accounts_manager, director, admin; cfo through the hierarchy)", async () => {
    await handlers.archiveTenantNote(post({ NoteId: "note-1", Reason: "Duplicate" }), ctx);
    await handlers.unarchiveTenantNote(post({ NoteId: "note-1", Reason: "Archived by mistake" }), ctx);
    const gates = auth.requireRole.mock.calls.map((c: unknown[]) => c[1]);
    expect(gates).toEqual([ACTION_ROLES.editTenancy.gate, ACTION_ROLES.editTenancy.gate]);
    expect(gates[0]).toEqual([AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
    expect([...ACTION_ROLES.editTenancy.routes]).toEqual(expect.arrayContaining(["archiveTenantNote", "unarchiveTenantNote"]));
    auth.requireRole.mockResolvedValue({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await handlers.archiveTenantNote(post({ NoteId: "note-1", Reason: "x" }), ctx)).status).toBe(403);
  });

  it.each([{ NoteId: "note-1" }, { NoteId: "note-1", Reason: "   " }, { Reason: "x" }, { NoteId: "note-1", Reason: "x".repeat(2001) }])(
    "refuse %p (400) before touching the database",
    async (body) => {
      expect((await handlers.archiveTenantNote(post(body), ctx)).status).toBe(400);
      expect((await handlers.unarchiveTenantNote(post(body), ctx)).status).toBe(400);
      expect(db.executeQuery).not.toHaveBeenCalled();
    },
  );

  it("archive reads the note under lock, stamps who, when and why, and ledgers it with the reason, in one transaction", async () => {
    const res = await handlers.archiveTenantNote(post({ NoteId: "note-1", Reason: "  Entered on the wrong tenancy " }), ctx);
    expect(res).toEqual({ jsonBody: { archived: true, noteId: "note-1" }, status: 200 });
    expect(sqlOf(LOCKED)).toMatch(/WHERE n\.NoteId = @Id/);
    const update = sqlOf(/UPDATE dbo\.TenantNotes SET ArchivedAt = SYSUTCDATETIME\(\)/);
    expect(update).toMatch(/ArchivedBy = @By, ArchiveReason = @Reason/);
    expect(update).toMatch(/WHERE NoteId = @Id AND ArchivedAt IS NULL/);
    expect(ledger.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: "tenancy_note.archive",
        buildingId: 3,
        reason: "Entered on the wrong tenancy",
        subject: { id: "note-1", type: "tenancy_note" },
        tenantId: 7,
      }),
    );
    expect(db.beginTransaction.mock.invocationCallOrder[0]).toBeLessThan(ledger.record.mock.invocationCallOrder[0]);
    expect(ledger.record.mock.invocationCallOrder[0]).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(7, 3);
  });

  it("archive answers 404 for a missing note and 409 for one already archived, writing nothing", async () => {
    note = null;
    expect((await handlers.archiveTenantNote(post({ NoteId: "note-1", Reason: "x" }), ctx)).status).toBe(404);
    note = { ArchivedAt: new Date(), BuildingId: 3, TenantId: 7 };
    const res = await handlers.archiveTenantNote(post({ NoteId: "note-1", Reason: "x" }), ctx);
    expect(res.status).toBe(409);
    expect(res.jsonBody.error).toMatch(/already archived/);
    expect(ran(/UPDATE dbo\./)).toBe(false);
    expect(ledger.record).not.toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("restore clears the stamp and ledgers it; 409 when the note isn't archived", async () => {
    note = { ArchivedAt: new Date(), BuildingId: 3, TenantId: 7 };
    expect((await handlers.unarchiveTenantNote(post({ NoteId: "note-1", Reason: "Archived by mistake" }), ctx)).status).toBe(200);
    expect(sqlOf(/UPDATE dbo\.TenantNotes SET ArchivedAt = NULL, ArchivedBy = NULL, ArchiveReason = NULL/)).toMatch(
      /WHERE NoteId = @Id AND ArchivedAt IS NOT NULL/,
    );
    expect(ledger.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "tenancy_note.unarchive", reason: "Archived by mistake" }));
    jest.clearAllMocks();
    note = { ArchivedAt: null, BuildingId: 3, TenantId: 7 };
    expect((await handlers.unarchiveTenantNote(post({ NoteId: "note-1", Reason: "x" }), ctx)).status).toBe(409);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("rolls back when the ledger write fails", async () => {
    ledger.record.mockRejectedValueOnce(new Error("ledger down"));
    expect((await handlers.archiveTenantNote(post({ NoteId: "note-1", Reason: "x" }), ctx)).status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});

describe("the hard delete is gone", () => {
  it("deleteTenantNote is no longer a route", () => {
    expect(handlers.deleteTenantNote).toBeUndefined();
  });
});

describe("getArchivedTenantNotes: the Archived view", () => {
  it("reads one tenancy's archived notes, newest archived first, with who archived them and why", async () => {
    db.executeQuery.mockResolvedValueOnce([
      {
        AnchorKind: "tenant",
        ArchiveReason: "Duplicate",
        ArchivedAt: new Date("2026-10-18T01:00:00Z"),
        ArchivedBy: "Ann Accounts",
        Body: "Called the tenant",
        CreatedAt: new Date("2026-10-01T01:00:00Z"),
        CreatedById: "oid-1",
        CreatedByName: "Bob",
        FieldKey: null,
        NoteId: "note-1",
        OccupancyId: null,
        TenantId: 7,
      },
    ]);
    const res = await handlers.getArchivedTenantNotes(get({ tenantId: "7" }), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody.notes).toEqual([
      expect.objectContaining({ archiveReason: "Duplicate", archivedAt: "2026-10-18T01:00:00.000Z", archivedBy: "Ann Accounts", noteId: "note-1" }),
    ]);
    const [, sql, params] = db.executeQuery.mock.calls[0] as [unknown, string, { name: string; value: unknown }[]];
    expect(sql).toMatch(/WHERE TenantId = @TenantId AND ArchivedAt IS NOT NULL/);
    expect(sql).toMatch(/ORDER BY ArchivedAt DESC/);
    expect(params).toEqual([expect.objectContaining({ name: "TenantId", value: 7 })]);
  });

  it("is for the tenancy's readers, and needs a tenantId", async () => {
    expect(auth.requireRole.mock.calls).toHaveLength(0);
    await handlers.getArchivedTenantNotes(get({ tenantId: "7" }), ctx);
    expect(auth.requireRole.mock.calls[0][1]).toEqual([AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.ADMIN, AppRole.DIRECTOR]);
    expect((await handlers.getArchivedTenantNotes(get({}), ctx)).status).toBe(400);
  });
});
