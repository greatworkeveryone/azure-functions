/// <reference types="jest" />
// D5 (database-safety rule 1): a file that backs a quote, purchase order or
// invoice is relied on. It can't be hard-deleted while any of them links it,
// and it can't be taken off one that has been approved, paid, sent or marked
// in MYOB. Every detach that does go ahead is ledgered against the record.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("tok"),
  requireRole: jest.fn().mockResolvedValue(null),
  rolesForRequest: jest.fn().mockResolvedValue(["facilities_manager"]),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "fm@rp", name: "Fay Manager", oid: "fay-oid" }),
}));
jest.mock("../blob-storage", () => ({ deleteBlob: jest.fn(), generateReadSasUrl: jest.fn().mockReturnValue("sas"), uploadBlob: jest.fn() }));
jest.mock("../mybuildings-client", () => ({ uploadAttachment: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }) }));

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;
const db = jest.requireMock("../db") as Record<"beginTransaction" | "commitTransaction" | "executeQuery" | "rollbackTransaction", jest.Mock>;
const blob = jest.requireMock("../blob-storage") as { deleteBlob: jest.Mock };
require("./attachments");
const { app } = jest.requireMock("@azure/functions") as { app: { http: jest.Mock } };
const registered = new Map<string, Handler>(app.http.mock.calls.map((c: [string, { handler: Handler }]) => [c[0], c[1].handler]));
const handler = (name: string): Handler => registered.get(name) as Handler;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ headers: { get: () => null }, json: async () => body, query: new URLSearchParams() }) as unknown as HttpRequest;

let links: { Id: number; Kind: string; Number: string | null }[];
let target: Record<string, unknown> | null;

beforeEach(() => {
  jest.clearAllMocks();
  links = [];
  target = { FileName: "quote.pdf", JobID: 42, Linked: 1, LockedBecause: null, Number: "261014-QT-42-ACM-1" };
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/FROM Attachments a\s+LEFT JOIN Jobs/.test(sql)) return [{ BlobName: "attachments/jobs/42/3f2b6c1e-8a4d-4f7e-9b21-6c0d5e7a9f10.pdf", JobID: 42, MyBuildingsConfirmedAt: null, UploadedBy: "fay-oid" }];
    if (/AS Kind/.test(sql)) return links;
    if (/FROM dbo\.(Quotes|PurchaseOrders) r WITH \(UPDLOCK, HOLDLOCK\)/.test(sql)) return target ? [target] : [];
    if (/FROM dbo\.AppUsers WHERE EntraOid/.test(sql)) return [{ UserID: 3 }];
    if (/SELECT BuildingID FROM Jobs/.test(sql)) return [{ BuildingID: 5 }];
    return [];
  });
});

const ran = (pattern: RegExp) => db.executeQuery.mock.calls.some((c: unknown[]) => pattern.test(String(c[1])));
const order = (pattern: RegExp) => {
  const i = db.executeQuery.mock.calls.findIndex((c: unknown[]) => pattern.test(String(c[1])));
  return db.executeQuery.mock.invocationCallOrder[i];
};

describe("deleteAttachment", () => {
  it("refuses with 422, naming the record, while a quote links the file; nothing is deleted", async () => {
    links = [{ Id: 9, Kind: "quote", Number: "261014-QT-42-ACM-1" }];
    const res = await handler("deleteAttachment")(post({ AttachmentID: 7 }), ctx);
    expect(res.status).toBe(422);
    expect(res.jsonBody.error).toBe(
      "This file is attached to quote 261014-QT-42-ACM-1, so it can't be deleted. Take it off there first.",
    );
    expect(blob.deleteBlob).not.toHaveBeenCalled();
    expect(ran(/DELETE FROM Attachments/)).toBe(false);
  });

  it("names every record when several link it, including an invoice", async () => {
    links = [
      { Id: 9, Kind: "quote", Number: "QT-1" },
      { Id: 4, Kind: "purchase order", Number: null },
      { Id: 2, Kind: "invoice", Number: "IV-2" },
    ];
    const res = await handler("deleteAttachment")(post({ AttachmentID: 7 }), ctx);
    expect(res.jsonBody.error).toBe(
      "This file is attached to quote QT-1, purchase order #4 and invoice IV-2, so it can't be deleted. Take it off there first.",
    );
  });

  it("checks the invoice links table only where it exists (migration 134)", async () => {
    await handler("deleteAttachment")(post({ AttachmentID: 7 }), ctx);
    const sql = String(db.executeQuery.mock.calls.find((c: unknown[]) => /AS Kind/.test(String(c[1])))[1]);
    expect(sql).toMatch(/IF OBJECT_ID\(N'dbo\.JobInvoiceAttachments', N'U'\) IS NOT NULL/);
  });

  it("still deletes a file nothing links, for its uploader", async () => {
    const res = await handler("deleteAttachment")(post({ AttachmentID: 7 }), ctx);
    expect(res.status).toBe(200);
    expect(blob.deleteBlob).toHaveBeenCalledWith("attachments/jobs/42/3f2b6c1e-8a4d-4f7e-9b21-6c0d5e7a9f10.pdf");
    expect(ran(/DELETE FROM Attachments WHERE Id = @Id/)).toBe(true);
  });
});

describe("detach from a quote or purchase order", () => {
  it.each([
    ["detachFromQuote", { QuoteID: 9 }, "approved", "Quote 261014-QT-42-ACM-1 has been approved, so its files stay with it."],
    ["detachFromQuote", { QuoteID: 9 }, "approved by a director", "Quote 261014-QT-42-ACM-1 has been approved by a director, so its files stay with it."],
    ["detachFromQuote", { QuoteID: 9 }, "paid", "Quote 261014-QT-42-ACM-1 has been paid, so its files stay with it."],
    ["detachFromPurchaseOrder", { PurchaseOrderID: 4 }, "marked in MYOB", "Purchase order 261014-QT-42-ACM-1 has been marked in MYOB, so its files stay with it."],
    ["detachFromQuote", { QuoteID: 9 }, "sent to a director for approval", "Quote 261014-QT-42-ACM-1 has been sent to a director for approval, so its files stay with it."],
    ["detachFromQuote", { QuoteID: 9 }, "sent to MYOB", "Quote 261014-QT-42-ACM-1 has been sent to MYOB, so its files stay with it."],
  ])("%s refuses (422) when the record has been (%#) locked, and writes nothing", async (name, ids, because, message) => {
    target = { ...target, LockedBecause: because };
    const res = await handler(name)(post({ ...ids, AttachmentID: 7 }), ctx);
    expect(res).toEqual({ jsonBody: { error: message }, status: 422 });
    expect(ran(/^\s*DELETE FROM/)).toBe(false);
    expect(ledgerInserts(db.executeQuery)).toEqual([]);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("reads the record's state and locks the link in the same query", async () => {
    await handler("detachFromQuote")(post({ AttachmentID: 7, QuoteID: 9 }), ctx);
    const sql = String(db.executeQuery.mock.calls.find((c: unknown[]) => /FROM dbo\.Quotes r WITH/.test(String(c[1])))[1]);
    expect(sql).toMatch(/AS LockedBecause/);
    expect(sql).toMatch(/LEFT JOIN dbo\.QuoteAttachments l WITH \(UPDLOCK, HOLDLOCK\)/);
    expect(sql).toMatch(/p\.Status = N'paid'/);
  });

  it("detaches from a quote still open, and ledgers it against the quote in the same transaction", async () => {
    const res = await handler("detachFromQuote")(post({ AttachmentID: 7, QuoteID: 9 }), ctx);
    expect(res.status).toBe(200);
    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    expect(order(/DELETE FROM QuoteAttachments/)).toBeGreaterThan(begun);
    expect(order(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(order(/DELETE FROM QuoteAttachments/));
    expect(order(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(committed);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "attachment.detach",
        before: { attachmentId: 7, fileName: "quote.pdf" },
        jobId: 42,
        subjectId: "9",
        subjectType: "quote",
      }),
    ]);
  });

  it("answers 404 when the record or the link isn't there", async () => {
    target = null;
    expect((await handler("detachFromQuote")(post({ AttachmentID: 7, QuoteID: 9 }), ctx)).status).toBe(404);
    target = { FileName: null, JobID: 42, Linked: 0, LockedBecause: null, Number: "QT-1" };
    expect((await handler("detachFromQuote")(post({ AttachmentID: 7, QuoteID: 9 }), ctx)).status).toBe(404);
    expect(ledgerInserts(db.executeQuery)).toEqual([]);
  });
});

describe("getAttachments", () => {
  it("says which money records each file is attached to, so the screen can explain a refused delete", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/FROM Attachments WHERE JobID=@JobID/.test(sql)) return [{ BlobName: "b", Id: 7 }, { BlobName: "c", Id: 8 }];
      if (/AS Kind/.test(sql)) return [{ AttachmentID: 7, Id: 9, Kind: "quote", Number: "QT-1" }];
      return [];
    });
    const req = { headers: { get: () => null }, query: new URLSearchParams("jobId=42") } as unknown as HttpRequest;
    const res = await handler("getAttachments")(req, ctx);
    expect(res.jsonBody.attachments.map((a: { Id: number; LinkedTo: string[] }) => [a.Id, a.LinkedTo])).toEqual([
      [7, ["quote QT-1"]],
      [8, []],
    ]);
  });
});
