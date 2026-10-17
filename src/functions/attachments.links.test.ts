/// <reference types="jest" />
// J9: files link to invoices the way they link to purchase orders and quotes.
// attachToInvoice / detachFromInvoice / getInvoiceAttachments run the same
// join-table handlers as the PO and quote trios, over dbo.JobInvoiceAttachments
// (migration 134). AttachedBy is the verified caller, never the body. The DB
// layer and blob storage are mocked.
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn(),
    oidFromToken: jest.fn().mockReturnValue("caller-oid"),
    requireRole: jest.fn(),
    rolesForRequest: jest.fn().mockResolvedValue(["facilities_manager"]),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn(),
  };
});
jest.mock("../blob-storage", () => ({
  deleteBlob: jest.fn(),
  generateReadSasUrl: jest.fn((blob: string) => `https://blob/${blob}?sas`),
  uploadBlob: jest.fn(),
}));
jest.mock("../mybuildings-client", () => ({ uploadAttachment: jest.fn() }));

const auth = require("../auth") as { extractToken: jest.Mock; requireRole: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as { createRequestConnection: jest.Mock; executeQuery: jest.Mock };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
require("./attachments");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
// Captured now: beforeEach's clearAllMocks wipes app.http's recorded calls.
const REGISTERED = new Map<string, { handler: Handler; methods: string[] }>(
  app.http.mock.calls.map((c: unknown[]) => [c[0] as string, c[1] as { handler: Handler; methods: string[] }]),
);
const registration = (name: string): { handler: Handler; methods: string[] } => {
  const hit = REGISTERED.get(name);
  if (!hit) throw new Error(`handler ${name} not registered`);
  return hit;
};
const handler = (name: string): Handler => registration(name).handler;

function post(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
function get(query: Record<string, string>): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn(), query: new URLSearchParams(query) } as unknown as HttpRequest;
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const sqlCalls = () =>
  db.executeQuery.mock.calls.map((c: unknown[]) => ({
    params: Object.fromEntries(((c[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value])),
    sql: String(c[1]),
  }));

// A small stand-in for the database, enough to answer what the join handlers
// send: the attach batch and the list. It reads a batch statement by statement
// (split on ";"), each on its own, as SQL runs them: an INSERT writes its row
// unless its own WHERE carries the job match (or the link already exists), and
// a SELECT ... AS Linked answers whether the file is on the parent's job. It
// applies SQL's rule that a NULL JobID equals nothing, and only checks jobs
// where the statement joins the parent table and compares a.JobID = p.JobID,
// so a handler that writes the link outside the job match is caught writing it.
// Job 9 owns PO 4, quote 7, invoice 5 and file 11; file 21 is on job 8; file
// 31 has no job (a tenancy lease or a key signature).
const FILE_JOB: Record<number, number | null> = { 11: 9, 21: 8, 31: null };
const PARENT_JOB: Record<string, Record<number, number>> = {
  JobInvoices: { 5: 9 },
  PurchaseOrders: { 4: 9 },
  Quotes: { 7: 9 },
};
/** Links already in the tables (some across jobs, made before the check). */
const LINKS: Record<string, number[]> = { JobInvoiceAttachments: [11, 21, 31], PurchaseOrderAttachments: [11, 21, 31], QuoteAttachments: [11, 21, 31] };
/** Link rows the handler wrote during a test. */
let written: { attachmentId: number; parentId: number; table: string }[] = [];

function sameJob(statement: string, parentId: number, attachmentId: number): boolean {
  const parent = /JOIN (\w+) p ON p\.\w+ = (?:@ParentID|j\.\w+)/.exec(statement)?.[1];
  if (!parent || !/\ba\.JobID = p\.JobID\b/.test(statement)) return true;
  const fileJob = FILE_JOB[attachmentId];
  return fileJob !== null && fileJob !== undefined && fileJob === PARENT_JOB[parent]?.[parentId];
}

async function fakeDb(_connection: unknown, sql: string, params: { name: string; value: unknown }[] = []): Promise<Record<string, unknown>[]> {
  const value = (name: string) => params.find((p) => p.name === name)?.value as number;
  const parentId = value("ParentID");
  // D5's transactional detach: the record's state with the link locked, the
  // ledger actor, and the job's building. The invoice here is open.
  if (/FROM dbo\.\w+ r WITH \(UPDLOCK, HOLDLOCK\)/.test(sql)) {
    return [{ FileName: "a.pdf", JobID: 9, Linked: 1, LockedBecause: null, Number: "INV-5" }];
  }
  if (/FROM dbo\.AppUsers WHERE EntraOid/.test(sql)) return [{ UserID: 3 }];
  if (/SELECT BuildingID FROM Jobs/.test(sql)) return [{ BuildingID: 5 }];
  const list = /FROM (\w+Attachments) j\s+JOIN Attachments a/.exec(sql);
  if (list) {
    return (LINKS[list[1]] ?? [])
      .filter((id) => sameJob(sql, parentId, id))
      .map((id) => ({ BlobName: blobOf(id), Id: id, JobID: FILE_JOB[id], MyBuildingsConfirmedAt: null }));
  }
  let answer: Record<string, unknown>[] = [];
  for (const statement of sql.split(";")) {
    const attachmentId = value("AttachmentID");
    const insert = /INSERT INTO (\w+Attachments)/.exec(statement);
    if (insert) {
      const table = insert[1];
      const alreadyLinked = written.some((row) => row.table === table && row.parentId === parentId && row.attachmentId === attachmentId);
      const guardsLink = statement.includes("NOT EXISTS (") && new RegExp("\\bFROM " + table + "\\s+WHERE").test(statement);
      if (sameJob(statement, parentId, attachmentId) && !(guardsLink && alreadyLinked)) {
        written.push({ attachmentId, parentId, table });
      }
    } else if (/\bAS Linked\b/.test(statement)) {
      answer = [{ Linked: sameJob(statement, parentId, attachmentId) ? 1 : 0 }];
    }
  }
  return answer;
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  auth.extractToken.mockReturnValue("token");
  auth.requireRole.mockResolvedValue(null);
  auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "abby@example.com", name: "Abby Accounts", oid: "abby-oid" });
  db.createRequestConnection.mockResolvedValue({ id: "connection" });
  db.executeQuery.mockImplementation(fakeDb);
  written = [];
});

// Minted attachment names (S1): the list route only signs names of this shape.
const blobOf = (id: number, job: number = FILE_JOB[id] ?? 0) =>
  `attachments/jobs/${job}/00000000-0000-4000-8000-${String(id).padStart(12, "0")}.pdf`;

describe("invoice attachment routes", () => {
  it("are registered with the same methods as the purchase-order trio", () => {
    expect(registration("attachToInvoice").methods).toEqual(registration("attachToPurchaseOrder").methods);
    expect(registration("detachFromInvoice").methods).toEqual(registration("detachFromPurchaseOrder").methods);
    expect(registration("getInvoiceAttachments").methods).toEqual(registration("getPurchaseOrderAttachments").methods);
  });

  it("let the accounts roles through: attaching a file is not an approval", async () => {
    await handler("attachToInvoice")(post({ AttachmentID: 11, InvoiceID: 5 }), ctx);
    await handler("attachToPurchaseOrder")(post({ AttachmentID: 11, PurchaseOrderID: 4 }), ctx);
    const [invoiceRoles, poRoles] = auth.requireRole.mock.calls.map((c: unknown[]) => c[1] as string[]);
    expect(invoiceRoles).toEqual(poRoles);
    expect(invoiceRoles).toEqual(expect.arrayContaining(["accounts", "accounts_manager"]));
  });
});

describe("attachToInvoice", () => {
  const attach = (body: Record<string, unknown>) => handler("attachToInvoice")(post(body), ctx);

  it("links the file to the invoice, once, stamped with the verified caller and not the body", async () => {
    const res = await attach({ AttachedBy: "Mallory", AttachmentID: 11, InvoiceID: 5 });

    expect(res).toEqual({ jsonBody: { ok: true }, status: 200 });
    const [call] = sqlCalls();
    expect(call.sql).toMatch(/INSERT INTO JobInvoiceAttachments \(JobInvoiceID, AttachmentID, AttachedBy\)\s+SELECT @ParentID, @AttachmentID, @AttachedBy/);
    expect(call.sql).toMatch(/AND NOT EXISTS \(\s*SELECT 1 FROM JobInvoiceAttachments\s+WHERE JobInvoiceID = @ParentID AND AttachmentID = @AttachmentID/);
    expect(written).toEqual([{ attachmentId: 11, parentId: 5, table: "JobInvoiceAttachments" }]);
    expect(call.params).toEqual({ AttachedBy: "Abby Accounts", AttachmentID: 11, ParentID: 5 });
  });

  it("is idempotent: attaching twice writes one link row and answers ok both times", async () => {
    expect((await attach({ AttachmentID: 11, InvoiceID: 5 })).status).toBe(200);
    expect((await attach({ AttachmentID: 11, InvoiceID: 5 })).status).toBe(200);
    const [first, second] = sqlCalls();
    expect(second).toEqual(first);
    expect(written).toHaveLength(1);
  });

  it("400s without a numeric InvoiceID or AttachmentID, before touching the database", async () => {
    for (const body of [{ AttachmentID: 11 }, { AttachmentID: 11, JobInvoiceID: 5 }, { AttachmentID: "11", InvoiceID: 5 }]) {
      const res = await attach(body);
      expect(res).toEqual({ jsonBody: { error: "InvoiceID (number) and AttachmentID (number) required" }, status: 400 });
    }
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("401s without a token, and without a verifiable identity", async () => {
    auth.extractToken.mockReturnValueOnce(null);
    expect((await attach({ AttachmentID: 11, InvoiceID: 5 })).status).toBe(401);
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);
    expect((await attach({ AttachmentID: 11, InvoiceID: 5 })).status).toBe(401);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("answers the role gate's 403 for a role outside the list, writing nothing", async () => {
    const gate = { jsonBody: { error: "Forbidden" }, status: 403 };
    auth.requireRole.mockResolvedValueOnce(gate);
    expect(await attach({ AttachmentID: 11, InvoiceID: 5 })).toBe(gate);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("detachFromInvoice", () => {
  const detach = (body: Record<string, unknown>) => handler("detachFromInvoice")(post(body), ctx);

  it("removes only the link row, not the attachment", async () => {
    const res = await detach({ AttachmentID: 11, InvoiceID: 5 });

    expect(res).toEqual({ jsonBody: { ok: true }, status: 200 });
    const call = sqlCalls().find((c) => /DELETE FROM JobInvoiceAttachments/.test(c.sql));
    expect(call?.sql).toMatch(/DELETE FROM JobInvoiceAttachments\s+WHERE JobInvoiceID = @ParentID AND AttachmentID = @AttachmentID/);
    expect(call?.params).toEqual({ AttachmentID: 11, ParentID: 5 });
    expect(sqlCalls().some((c) => /INSERT INTO dbo\.DecisionLedger/.test(c.sql))).toBe(true); // D5: the detach is ledgered
    expect(sqlCalls().some((c) => /DELETE FROM Attachments/.test(c.sql))).toBe(false); // the file itself stays
  });

  it("400s without InvoiceID, 401s without a token, answers the gate's 403", async () => {
    expect((await detach({ AttachmentID: 11 })).status).toBe(400);
    auth.extractToken.mockReturnValueOnce(null);
    expect((await detach({ AttachmentID: 11, InvoiceID: 5 })).status).toBe(401);
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await detach({ AttachmentID: 11, InvoiceID: 5 })).status).toBe(403);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("getInvoiceAttachments", () => {
  const list = (query: Record<string, string>) => handler("getInvoiceAttachments")(get(query), ctx);

  it("lists the invoice's files with a fresh read link, archived ones without", async () => {
    db.executeQuery.mockResolvedValue([
      { BlobName: blobOf(11, 9), Id: 11, MyBuildingsConfirmedAt: null, OriginalName: "a.pdf" },
      { BlobName: blobOf(12, 9), Id: 12, MyBuildingsConfirmedAt: new Date("2026-10-01T00:00:00Z"), OriginalName: "b.pdf" },
    ]);

    const res = await list({ invoiceId: "5" });

    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({
      attachments: [{ Id: 11, sasUrl: `https://blob/${blobOf(11, 9)}?sas` }, { Id: 12, sasUrl: null }],
      count: 2,
    });
    const [call] = sqlCalls();
    expect(call.sql).toMatch(/FROM JobInvoiceAttachments j\s+JOIN Attachments a ON a\.Id = j\.AttachmentID[\s\S]*WHERE j\.JobInvoiceID = @ParentID/);
    expect(call.params).toEqual({ ParentID: 5 });
  });

  it("reads the invoiceId query param the frontend sends, and 400s without it", async () => {
    expect(await list({})).toEqual({ jsonBody: { error: "invoiceId is required" }, status: 400 });
    expect(await list({ invoiceId: "five" })).toEqual({ jsonBody: { error: "invoiceId must be a number" }, status: 400 });
  });

  it("401s without a token and answers the gate's 403", async () => {
    auth.extractToken.mockReturnValueOnce(null);
    expect((await list({ invoiceId: "5" })).status).toBe(401);
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await list({ invoiceId: "5" })).status).toBe(403);
  });
});

describe("the purchase-order and quote trios share the token-stamped AttachedBy", () => {
  it.each([
    ["attachToPurchaseOrder", { PurchaseOrderID: 4 }, /INSERT INTO PurchaseOrderAttachments \(PurchaseOrderID, AttachmentID, AttachedBy\)/],
    ["attachToQuote", { QuoteID: 7 }, /INSERT INTO QuoteAttachments \(QuoteID, AttachmentID, AttachedBy\)/],
  ])("%s", async (name, ids, insert) => {
    const res = await handler(name)(post({ ...ids, AttachedBy: "Mallory", AttachmentID: 11 }), ctx);
    expect(res.status).toBe(200);
    const [call] = sqlCalls();
    expect(call.sql).toMatch(insert);
    expect(call.params.AttachedBy).toBe("Abby Accounts");
  });
});

// J9 review: a file can be linked to a PO, quote or invoice only when it is on
// that parent's job. Files with no job (tenancy leases, key signatures) are
// never linkable, so their own accounts-only read routes can't be walked round
// through getXxxAttachments. Links made before this check stop listing.
describe.each([
  ["attachToPurchaseOrder", "getPurchaseOrderAttachments", { PurchaseOrderID: 4 }, { purchaseOrderId: "4" }, "PurchaseOrders"],
  ["attachToQuote", "getQuoteAttachments", { QuoteID: 7 }, { quoteId: "7" }, "Quotes"],
  ["attachToInvoice", "getInvoiceAttachments", { InvoiceID: 5 }, { invoiceId: "5" }, "JobInvoices"],
])("%s only links files on the parent's job", (attachRoute, listRoute, ids, query, parentTable) => {
  const attach = (attachmentId: number) => handler(attachRoute)(post({ ...ids, AttachmentID: attachmentId }), ctx);

  it("links a file on the same job, writing one link row", async () => {
    expect(await attach(11)).toEqual({ jsonBody: { ok: true }, status: 200 });
    expect(sqlCalls()[0].sql).toMatch(new RegExp(`JOIN ${parentTable} p ON p\\.\\w+ = @ParentID`));
    expect(written).toHaveLength(1);
  });

  it("refuses a file from another job with 422, writing no link row", async () => {
    expect(await attach(21)).toEqual({ jsonBody: { error: "That file isn't on this job." }, status: 422 });
    expect(written).toEqual([]);
  });

  it("refuses a file with no job (a lease or a key signature) with 422, writing no link row", async () => {
    expect(await attach(31)).toEqual({ jsonBody: { error: "That file isn't on this job." }, status: 422 });
    expect(written).toEqual([]);
  });

  it("writes the link in one statement that carries the job match itself", async () => {
    await attach(11);
    const insert = sqlCalls()[0].sql.split(";").find((statement) => /INSERT INTO/.test(statement)) ?? "";
    expect(insert).toMatch(/WHERE EXISTS \(/);
    expect(insert).toMatch(new RegExp(`JOIN ${parentTable} p ON p\\.\\w+ = @ParentID`));
    expect(insert).toMatch(/\ba\.JobID = p\.JobID\b/);
  });

  it("leaves out links made across jobs before this check, so no read link is minted for them", async () => {
    const res = await handler(listRoute)(get(query), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ attachments: [{ Id: 11, sasUrl: `https://blob/${blobOf(11)}?sas` }], count: 1 });
  });
});
