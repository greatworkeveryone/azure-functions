/// <reference types="jest" />
// D4 (DL-04, DL-19; database-safety rule 1): a tenancy, and a lease document,
// is archived — reversible, stamped and ledgered — never hard-deleted. The one
// hard delete left is an empty draft (no schedule rows, areas, documents or jobs).
import { HttpRequest, InvocationContext } from "@azure/functions";

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status: number; jsonBody?: any }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  const g = globalThis as unknown as { __d4Handlers?: Record<string, Handler> };
  g.__d4Handlers = g.__d4Handlers ?? {};
  return {
    ...actual,
    app: { ...actual.app, http: (name: string, opts: { handler: Handler }) => void ((g.__d4Handlers as Record<string, Handler>)[name] = opts.handler), timer: jest.fn() },
  };
});
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("tok"),
  oidFromToken: jest.fn().mockReturnValue("ann-oid"),
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
jest.mock("../blob-storage", () => ({ generateReadSasUrl: jest.fn().mockReturnValue("sas"), uploadBlob: jest.fn() }));
jest.mock("../ledger");
jest.mock("../ledger/actor", () => ({
  resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Ann Accounts", role: "accounts_manager", userId: 7 }),
}));

import { AppRole } from "../auth";

const auth = jest.requireMock("../auth") as { requireRole: jest.Mock };
const db = jest.requireMock("../db") as Record<"beginTransaction" | "commitTransaction" | "executeQuery" | "rollbackTransaction", jest.Mock>;
const cache = jest.requireMock("../tenant-register-cache") as { invalidateTenant: jest.Mock };
const ledger = jest.requireMock("../ledger") as { record: jest.Mock };

require("./tenancy");
require("./tenants");
require("./tenancyAttachments");
require("./archiveTenant");
require("./unarchiveTenant");
require("./archiveTenancyDocument");
const handlers = (globalThis as unknown as { __d4Handlers: Record<string, Handler> }).__d4Handlers;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown, query: Record<string, string> = {}) =>
  ({ headers: { get: () => null }, json: async () => body, query: new URLSearchParams(query) }) as unknown as HttpRequest;

let tenant: Record<string, unknown> | null;
let documentRow: Record<string, unknown> | null;
beforeEach(() => {
  jest.clearAllMocks();
  auth.requireRole.mockResolvedValue(null);
  tenant = { ArchivedAt: null, BuildingId: 3, Documents: 0, Jobs: 0, LegalName: "Acme Pty Ltd", Occupancies: 0, ScheduledRateSteps: "[]" };
  documentRow = { ArchivedAt: null, OriginalName: "lease.pdf" };
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/FROM dbo\.Tenants t WITH \(UPDLOCK, HOLDLOCK\)/.test(sql)) return tenant ? [tenant] : [];
    if (/FROM dbo\.TenancyAttachments ta WITH \(UPDLOCK, HOLDLOCK\)/.test(sql)) return documentRow ? [documentRow] : [];
    return [];
  });
});

const sqlOf = (pattern: RegExp) =>
  db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1])).find((sql: string) => pattern.test(sql)) ?? "";
const ran = (pattern: RegExp) => sqlOf(pattern) !== "";
const order = (pattern: RegExp) => {
  const i = db.executeQuery.mock.calls.findIndex((c: unknown[]) => pattern.test(String(c[1])));
  return db.executeQuery.mock.invocationCallOrder[i];
};

describe("archiveTenant / unarchiveTenant", () => {
  it("are for accounts_manager and above (cfo, director, admin through the hierarchy)", async () => {
    await handlers.archiveTenant(post({ Reason: "Lease ended", TenantId: 7 }), ctx);
    await handlers.unarchiveTenant(post({ Reason: "Archived by mistake", TenantId: 7 }), ctx);
    expect(auth.requireRole.mock.calls.map((c: unknown[]) => c[1])).toEqual([[AppRole.ACCOUNTS_APPROVAL], [AppRole.ACCOUNTS_APPROVAL]]);
  });

  it("refuse other roles before touching the database", async () => {
    auth.requireRole.mockResolvedValue({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await handlers.archiveTenant(post({ Reason: "x", TenantId: 7 }), ctx)).status).toBe(403);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it.each([{ TenantId: 7 }, { Reason: "   ", TenantId: 7 }, { Reason: "Lease ended" }])("need a tenancy and a reason: %p → 400", async (body) => {
    expect((await handlers.archiveTenant(post(body), ctx)).status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("archive stamps who and when, ledgers it with the reason, all in one transaction", async () => {
    const res = await handlers.archiveTenant(post({ Reason: "Lease ended, keys returned", TenantId: 7 }), ctx);
    expect(res.status).toBe(200);
    const update = sqlOf(/UPDATE dbo\.Tenants SET ArchivedAt/);
    expect(update).toMatch(/ArchivedAt = SYSUTCDATETIME\(\), ArchivedBy = @By/);
    expect(update).toMatch(/WHERE TenantId = @Id AND ArchivedAt IS NULL/);
    expect(ledger.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tenancy.archive", reason: "Lease ended, keys returned", subject: { id: 7, type: "tenancy" } }),
    );
    expect(order(/UPDATE dbo\.Tenants SET ArchivedAt/)).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
    expect(ledger.record.mock.invocationCallOrder[0]).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
    expect(cache.invalidateTenant).toHaveBeenCalledWith(7);
  });

  it("archive answers 404 for an unknown tenancy and 409 for one already archived, writing nothing", async () => {
    tenant = null;
    expect((await handlers.archiveTenant(post({ Reason: "x", TenantId: 7 }), ctx)).status).toBe(404);
    tenant = { ArchivedAt: new Date(), BuildingId: 3, LegalName: "Acme Pty Ltd" };
    expect((await handlers.archiveTenant(post({ Reason: "x", TenantId: 7 }), ctx)).status).toBe(409);
    expect(ran(/UPDATE dbo\.Tenants/)).toBe(false);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("unarchive clears the stamp and ledgers it; 409 when the tenancy isn't archived", async () => {
    tenant = { ArchivedAt: new Date(), BuildingId: 3, LegalName: "Acme Pty Ltd" };
    expect((await handlers.unarchiveTenant(post({ Reason: "Archived by mistake", TenantId: 7 }), ctx)).status).toBe(200);
    expect(sqlOf(/UPDATE dbo\.Tenants SET ArchivedAt = NULL/)).toMatch(/WHERE TenantId = @Id AND ArchivedAt IS NOT NULL/);
    expect(ledger.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "tenancy.unarchive", reason: "Archived by mistake" }));
    tenant = { ArchivedAt: null, BuildingId: 3, LegalName: "Acme Pty Ltd" };
    expect((await handlers.unarchiveTenant(post({ Reason: "x", TenantId: 7 }), ctx)).status).toBe(409);
  });
});

describe.each(["deleteRegisterTenant", "deleteTenant"])("%s: only an empty draft is hard-deleted", (name) => {
  const body = name === "deleteTenant" ? { TenantID: 7 } : { TenantId: 7 };

  it.each([
    [{ ScheduledRateSteps: '[{"id":"s1","effectiveFrom":"2024-07-01","ratePercent":0}]' }, "a rent schedule"],
    [{ Occupancies: 2 }, "2 areas"],
    [{ Documents: 1 }, "1 document"],
  ])("refuses (422) a tenancy with %p and says archive instead", async (over, part) => {
    tenant = { ...tenant, ...over };
    const res = await handlers[name](post(body), ctx);
    expect(res.status).toBe(422);
    expect(res.jsonBody.error).toBe(`Acme Pty Ltd has ${part}, so it can't be deleted. Archive it instead.`);
    expect(ran(/DELETE FROM dbo\.Tenants/)).toBe(false);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("names everything it has", async () => {
    tenant = { ...tenant, Documents: 3, Occupancies: 1, ScheduledRateSteps: '[{"id":"s1","effectiveFrom":"2024-07-01","ratePercent":0}]' };
    const res = await handlers[name](post(body), ctx);
    expect(res.jsonBody.error).toBe("Acme Pty Ltd has a rent schedule, 1 area and 3 documents, so it can't be deleted. Archive it instead.");
  });

  it("still refuses a tenancy jobs refer to (400, as before)", async () => {
    tenant = { ...tenant, Jobs: 2 };
    const res = await handlers[name](post(body), ctx);
    expect(res.status).toBe(400);
    expect(res.jsonBody.error).toMatch(/Reassign first/);
  });

  it("deletes an empty draft inside one transaction and ledgers it", async () => {
    const res = await handlers[name](post(body), ctx);
    expect(res.status).toBe(200);
    expect(sqlOf(/FROM dbo\.Tenants t WITH \(UPDLOCK, HOLDLOCK\)/)).toMatch(/dbo\.TenancyAttachments/);
    expect(order(/DELETE FROM dbo\.Tenants/)).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
    expect(ledger.record).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: "tenancy.delete_draft", subject: { id: 7, type: "tenancy" } }));
    expect(db.commitTransaction).toHaveBeenCalled();
  });
});

describe("lease documents", () => {
  it("archiveTenancyDocument stamps who and when on the file and ledgers it against the tenancy", async () => {
    const res = await handlers.archiveTenancyDocument(post({ AttachmentID: 12, TenantId: 7 }), ctx);
    expect(res.status).toBe(200);
    expect(sqlOf(/UPDATE dbo\.Attachments SET ArchivedAt/)).toMatch(/ArchivedAt = SYSUTCDATETIME\(\), ArchivedBy = @By[\s\S]*WHERE Id = @AttachmentID AND ArchivedAt IS NULL/);
    expect(ledger.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "tenancy.document_archive", before: { attachmentId: 12, fileName: "lease.pdf" }, subject: { id: 7, type: "tenancy" } }),
    );
    expect(db.commitTransaction).toHaveBeenCalled();
  });

  it("archiveTenancyDocument answers 404 for a file that isn't this tenancy's and 409 for one already archived", async () => {
    documentRow = null;
    expect((await handlers.archiveTenancyDocument(post({ AttachmentID: 12, TenantId: 7 }), ctx)).status).toBe(404);
    documentRow = { ArchivedAt: new Date(), OriginalName: "lease.pdf" };
    expect((await handlers.archiveTenancyDocument(post({ AttachmentID: 12, TenantId: 7 }), ctx)).status).toBe(409);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("getTenancyAttachments leaves archived documents out unless asked for", async () => {
    await handlers.getTenancyAttachments(post(null, { tenantId: "7" }), ctx);
    expect(sqlOf(/FROM TenancyAttachments ta/)).toMatch(/AND a\.ArchivedAt IS NULL/);
    db.executeQuery.mockClear();
    await handlers.getTenancyAttachments(post(null, { includeArchived: "true", tenantId: "7" }), ctx);
    expect(sqlOf(/FROM TenancyAttachments ta/)).not.toMatch(/ArchivedAt IS NULL/);
  });
});

describe("archived tenancies stay out of normal views and counts", () => {
  it("the building register leaves them out unless asked for", async () => {
    await handlers.getRegisterTenants(post(null, { buildingId: "3" }), ctx);
    expect(sqlOf(/FROM dbo\.Tenants t WHERE BuildingId = @BuildingId/)).toMatch(/AND t\.ArchivedAt IS NULL/);
    db.executeQuery.mockClear();
    await handlers.getRegisterTenants(post(null, { buildingId: "3", includeArchived: "true" }), ctx);
    expect(sqlOf(/FROM dbo\.Tenants t WHERE BuildingId = @BuildingId/)).not.toMatch(/ArchivedAt IS NULL/);
  });

  it.each([
    ["getReviewsDue", {}],
    ["getPortfolioOccupancy", {}],
    ["getTenants", {}],
  ])("%s leaves them out", async (name, query) => {
    await handlers[name](post(null, query), ctx);
    const tenantSql = db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1])).filter((sql: string) => /FROM dbo\.Tenants t/.test(sql));
    expect(tenantSql.length).toBeGreaterThan(0);
    for (const sql of tenantSql) expect(sql).toMatch(/t\.ArchivedAt IS NULL/);
  });
});
