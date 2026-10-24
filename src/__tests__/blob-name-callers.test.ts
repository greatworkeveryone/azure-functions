/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

// SEC-01 exploit paths B and C: callers that take a blob reference from the
// request body (quote/invoice PDF names, vacancy image URLs) or from a stored
// row (the director packet) must not reach storage with a foreign name.

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  buildUpdateSet: jest.requireActual("../db").buildUpdateSet,
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
  extractToken: jest.fn().mockReturnValue("mock-token"),
  requireRole: jest.fn().mockResolvedValue(null),
  rolesForRequest: jest.fn().mockResolvedValue(["accounts"]),
  unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "a@rp", name: "Ann", oid: "ann-oid" }),
}));
jest.mock("../blob-storage", () => ({
  ...jest.requireActual("../blob-storage"),
  deletePublicBlob: jest.fn().mockResolvedValue(undefined),
  downloadBlob: jest.fn().mockResolvedValue(Buffer.from("pdf")),
  uploadPublicBlob: jest.fn(),
  vacanciesReadSasUrl: jest.fn((u: string) => u),
}));
jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn().mockResolvedValue([]) }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../jobPlannerSync", () => ({ syncJobActionTriggersStandalone: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../mybuildings-client", () => ({ fetchInvoices: jest.fn() }));
jest.mock("../email/director-emails", () => ({ sendDirectorApprovalEmail: jest.fn() }));
jest.mock("../quote-decisions", () => ({ QUOTE_COLUMNS: "QuoteID", approveDirectorQuote: jest.fn(), rejectQuote: jest.fn() }));
jest.mock("../graph", () => ({ graphFetchEmails: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;

const db = require("../db") as { executeQuery: jest.Mock };
const blob = require("../blob-storage") as { deletePublicBlob: jest.Mock; downloadBlob: jest.Mock };
const { upsertJobInvoice } = require("../functions/invoices") as { upsertJobInvoice: Handler };
const { ingestEmail } = require("../functions/emails") as { ingestEmail: Handler };
require("../functions/quotes");
require("../functions/vacancies");
const { maybeLoadBlob } = require("../pdf/job-packet-loader") as { maybeLoadBlob: (n: string | null) => Promise<Buffer | null> };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };

const registered = (name: string): Handler => {
  const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!hit) throw new Error(`handler ${name} not registered`);
  return (hit[1] as { handler: Handler }).handler;
};
const upsertQuote = registered("upsertQuote");
const deleteVacancyImage = registered("deleteVacancyImage");

const UUID = "3f2c9a10-5b7e-4d21-9c8a-0e1f2a3b4c5d";
const ON_JOB = `email-attachments/AAMk/${UUID}.pdf`;
const OTHER_JOB = `attachments/jobs/99/${UUID}.pdf`;
const TRAVERSAL = "email-attachments/x/../../../key-photos/keys/a.jpg";
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

function post(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
const sqlCalls = () => db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1]));
const paramValue = (c: unknown[], name: string) =>
  ((c[2] as { name: string; value: unknown }[] | undefined) ?? []).find((p) => p.name === name)?.value;

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset().mockImplementation(async (_c: unknown, sql: string, params?: { name: string; value: unknown }[]) => {
    const p = Object.fromEntries((params ?? []).map((x) => [x.name, x.value]));
    if (/FROM Attachments\s+WHERE JobID = @JobID AND BlobName = @BlobName/.test(sql)) {
      return p.JobID === 12 && p.BlobName === ON_JOB ? [{ Found: 1 }] : [];
    }
    // ingestEmail's "does another email already own this blob" check: nobody does.
    if (/MessageID <> @MessageID/.test(sql)) return [];
    if (/MAX\(Seq\)/.test(sql)) return [{ NextSeq: 1 }];
    if (/INSERT INTO Quotes/.test(sql)) return [{ QuoteID: 7 }];
    if (/INSERT INTO JobInvoices/.test(sql)) return [{ JobInvoiceID: 5 }];
    if (/SELECT QuoteID, JobID, QuoteNumber/.test(sql)) return [{ QuoteID: 7, JobID: 12, Status: "pending" }];
    if (/SELECT JobInvoiceID, JobID, InvoiceNumber/.test(sql)) return [{ JobInvoiceID: 5, JobID: 12, Status: "pending" }];
    if (/SELECT Images FROM dbo.Vacancies/.test(sql)) {
      return [{ Images: JSON.stringify(["https://acct.blob.core.windows.net/vacancies/3/a.jpg"]) }];
    }
    return [{ QuoteID: 7, JobInvoiceID: 5 }];
  });
});

describe.each([
  ["upsertQuote", () => upsertQuote, "QuotePDFBlobName", "QuoteID", 7, /INSERT INTO Quotes/, /UPDATE Quotes SET/],
  ["upsertJobInvoice", () => upsertJobInvoice, "InvoicePDFBlobName", "JobInvoiceID", 5, /INSERT INTO JobInvoices/, /UPDATE JobInvoices SET/],
])("%s PDF blob name", (_label, handler, field, idField, id, insertRe, updateRe) => {
  it.each([
    ["a traversal name", TRAVERSAL],
    ["a well-formed name from another job", OTHER_JOB],
    ["an empty string", ""],
    ["a non-string", 42],
  ])("refuses %s on create with 400 and writes nothing", async (_l, name) => {
    const res = await handler()(post({ JobID: 12, Amount: 10, [field]: name }), ctx);
    expect(res.status).toBe(400);
    expect(sqlCalls().some((s: string) => insertRe.test(s))).toBe(false);
  });

  it("refuses a foreign name on update with 400 and writes nothing", async () => {
    const res = await handler()(post({ [idField]: id, [field]: TRAVERSAL }), ctx);
    expect(res.status).toBe(400);
    expect(sqlCalls().some((s: string) => updateRe.test(s))).toBe(false);
  });

  it("accepts a name that is one of the job's attachments", async () => {
    const res = await handler()(post({ JobID: 12, Amount: 10, [field]: ON_JOB }), ctx);
    expect(res.status).toBe(200);
    const insert = db.executeQuery.mock.calls.find((c: unknown[]) => insertRe.test(String(c[1])))!;
    expect(paramValue(insert, field)).toBe(ON_JOB);
  });

  it("still lets an update clear the PDF", async () => {
    const res = await handler()(post({ [idField]: id, [field]: null }), ctx);
    expect(res.status).toBe(200);
    expect(sqlCalls().some((s: string) => updateRe.test(s))).toBe(true);
  });
});

describe("deleteVacancyImage", () => {
  it("returns 404 for a URL that is not in the vacancy's list and deletes nothing", async () => {
    const res = await deleteVacancyImage(
      post({ id: 3, imageUrl: "https://acct.blob.core.windows.net/x/vacancies/../wr-attachments/attachments/jobs/12/a.pdf" }),
      ctx,
    );
    expect(res.status).toBe(404);
    expect(blob.deletePublicBlob).not.toHaveBeenCalled();
    expect(sqlCalls().some((s: string) => /UPDATE dbo.Vacancies/.test(s))).toBe(false);
  });
});

describe("director packet loader", () => {
  it.each([TRAVERSAL, `keys/${UUID}.jpg`, "../po/1.pdf"])("refuses %s without a storage call", async (name) => {
    expect(await maybeLoadBlob(name)).toBeNull();
    expect(blob.downloadBlob).not.toHaveBeenCalled();
  });

  it("loads a genuine attachment", async () => {
    expect(await maybeLoadBlob(ON_JOB)).toEqual(Buffer.from("pdf"));
    expect(blob.downloadBlob).toHaveBeenCalledWith(ON_JOB);
  });
});

describe("ingestEmail attachment names", () => {
  it.each([
    ["a traversal behind the mail-sync prefix", `email-attachments/x/../../key-photos/keys/${UUID}.jpg`],
    ["the old unanchored emails/ prefix", "emails/x/../../../key-photos/keys/a.jpg"],
  ])("refuses %s with 400 and stores nothing", async (_l, name) => {
    const res = await ingestEmail(post({ MessageID: "<m@x>", AttachmentBlobs: JSON.stringify([{ blobName: name, fileName: "a" }]) }), ctx);
    expect(res.status).toBe(400);
    expect(sqlCalls().some((s: string) => /INSERT INTO Emails/.test(s))).toBe(false);
  });

  it("stores a genuine mail-sync attachment name", async () => {
    const res = await ingestEmail(post({ MessageID: "<m@x>", AttachmentBlobs: JSON.stringify([{ blobName: ON_JOB, fileName: "q.pdf" }]) }), ctx);
    expect(res.status).toBe(200);
    expect(sqlCalls().some((s: string) => /INSERT INTO Emails/.test(s))).toBe(true);
  });
});
