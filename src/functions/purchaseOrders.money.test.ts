/// <reference types="jest" />
// J3 for purchase orders: a PO needs a cost above $0 and an approved quote in
// every job state (contract jobs excepted; internal jobs have none), checked
// against the quote's own status rather than trusting Jobs.ApprovedQuoteID;
// PO_CREATED only moves the job on that verified approval; no POs on internal,
// done or archived jobs; a cost or payee change clears the sent and MYOB
// markers (po.markers_reset); sending follows the same rules and writes the
// job's history; admin marks in MYOB on test records only. DB mocked.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  buildUpdateSet: jest.requireActual("../db").buildUpdateSet,
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn(),
    rolesForRequest: jest.fn(),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn(),
  };
});
jest.mock("../contractor-acronym-db", () => ({ INTERNAL_ACRONYM: "INT", ensureContractorAcronym: jest.fn().mockResolvedValue("ACM") }));
jest.mock("../po-reference-db", () => ({ resolvePoNumber: jest.fn().mockResolvedValue({ chargeCode: "e", poNumber: "66Se261013" }) }));
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn().mockResolvedValue({ advanced: true }) }));
jest.mock("../graph", () => ({ graphSendMail: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../blob-storage", () => ({
  deleteBlob: jest.fn(),
  downloadBlob: jest.fn().mockResolvedValue(Buffer.from("pdf")),
  generateReadSasUrl: jest.fn(),
  uploadPurchaseOrderPdf: jest.fn(),
}));
jest.mock("../pdf/purchase-order-pdf", () => ({ renderPurchaseOrderPDF: jest.fn() }));
jest.mock("../pdf/default-po-email", () => ({ defaultPOEmail: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

const auth = require("../auth") as { requireRole: jest.Mock; rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const graph = require("../graph") as { graphSendMail: jest.Mock };
const statusHelpers = require("../jobStatusHelpers") as { advanceJobStatus: jest.Mock };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
require("./purchaseOrders");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const REGISTERED = new Map<string, Handler>(app.http.mock.calls.map((c: unknown[]) => [c[0] as string, (c[1] as { handler: Handler }).handler]));
const call = (name: string, body: Record<string, unknown>) => {
  const hit = REGISTERED.get(name);
  if (!hit) throw new Error(`handler ${name} not registered`);
  return hit(makeRequest(body), ctx);
};

type Route = { match: RegExp; rows?: Record<string, unknown>[] };
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => routes.find((r) => r.match.test(sql))?.rows ?? []);
}
const sqls = (): string[] => db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1]));
const wrote = (re: RegExp) => sqls().some((sql) => re.test(sql));
const paramsOf = (re: RegExp) => {
  const hit = db.executeQuery.mock.calls.find((c: unknown[]) => re.test(String(c[1])));
  return Object.fromEntries(((hit?.[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value]));
};
function makeRequest(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const CALLER = { email: "fran@example.com", name: "Fran Manager", oid: "fran-oid" };
const APP_USER: Route = { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 21 }] };
const JOB_BUILDING: Route = { match: /SELECT BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5 }] };
const PO_SCOPE: Route = { match: /FROM PurchaseOrders s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] };
const STORED: Route = { match: /PurchaseOrderID, JobID, PONumber, Seq/, rows: [{ PurchaseOrderID: 99 }] };
const CREATED: Route = { match: /INSERT INTO PurchaseOrders/, rows: [{ PurchaseOrderID: 99 }] };
const NO_TEST_FLAG: Route = { match: /COL_LENGTH\('dbo\.Jobs', 'IsTest'\)/, rows: [{ Len: null }] };
const job = (over: Record<string, unknown> = {}): Route => ({
  match: /SELECT j\.JobID, j\.Status, j\.IsInternal, j\.IsArchived/,
  rows: [{ BuildingID: 5, HasApprovedQuote: 1, IsArchived: false, IsContract: false, IsInternal: false, JobID: 9, Status: "Awaiting Approval", ...over }],
});
const LOCKED_PO = /FROM PurchaseOrders WITH \(UPDLOCK, HOLDLOCK\) WHERE PurchaseOrderID = @Id/;
const po = (over: Record<string, unknown> = {}): Route => ({
  match: LOCKED_PO,
  rows: [{
    CompletedAt: null, CompletedBy: null, ContractorID: 3, ContractorName: "Acme", CostNotToExceed: 4500, EstimatedCost: 4000,
    JobID: 9, MyobCreatedAt: null, MyobCreatedBy: null, PDFBlobName: "po/99.pdf", PONumber: "66Se261013", SentAt: null, SentBy: null, ...over,
  }],
});

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  auth.requireRole.mockResolvedValue(null);
  auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
  auth.verifiedIdentityFromRequest.mockResolvedValue(CALLER);
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  db.createRequestConnection.mockResolvedValue({ id: "connection" });
});

afterEach(() => jest.restoreAllMocks());

describe("upsertPurchaseOrder: creating", () => {
  const create = (body: Record<string, unknown>) => call("upsertPurchaseOrder", { JobID: 9, ...body });

  it("raises a PO with a cost on a job whose quote is approved, and moves the job on that approval", async () => {
    mockSql([APP_USER, JOB_BUILDING, job(), CREATED, STORED]);
    expect((await create({ CostNotToExceed: 4500 })).status).toBe(200);
    expect(statusHelpers.advanceJobStatus).toHaveBeenCalled();
  });

  it.each(["New", "Quote", "Awaiting Approval", "Work"])("refuses a PO without an approved quote in %s, ledgered", async (Status) => {
    mockSql([APP_USER, JOB_BUILDING, job({ HasApprovedQuote: 0, Status }), CREATED, { match: /FROM Jobs WHERE JobID = @Id/, rows: [{ BuildingID: 5, JobID: 9 }] }]);
    expect(await create({ CostNotToExceed: 4500 })).toMatchObject({ jsonBody: { code: "quote_not_approved" }, status: 422 });
    expect(wrote(/INSERT INTO PurchaseOrders/)).toBe(false);
    expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ action: "denied", ruleApplied: "quote_not_approved" })]);
  });

  it("raises a PO on a contract job without a quote, without moving the job", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ HasApprovedQuote: 0, IsContract: true, Status: "Work" }), CREATED, STORED]);
    expect((await create({ EstimatedCost: 800 })).status).toBe(200);
    expect(statusHelpers.advanceJobStatus).not.toHaveBeenCalled();
  });

  it("refuses a PO with no cost, or a cost of $0 or less", async () => {
    mockSql([APP_USER, JOB_BUILDING, job(), CREATED]);
    for (const body of [{}, { CostNotToExceed: 0 }, { CostNotToExceed: 4500, EstimatedCost: 0 }]) {
      expect(await create(body)).toMatchObject({ jsonBody: { code: "amount_invalid" }, status: 422 });
    }
    // A negative cost is the money parser's 400 (D1), before anything is read.
    expect((await create({ EstimatedCost: -5 })).status).toBe(400);
    expect(wrote(/INSERT INTO PurchaseOrders/)).toBe(false);
  });

  it.each([
    [{ IsInternal: true }, 422, "internal_job"],
    [{ Status: "Done" }, 409, "job_done"],
    [{ IsArchived: true }, 409, "job_archived"],
  ])("refuses a PO on a job like %p", async (over, status, code) => {
    mockSql([APP_USER, JOB_BUILDING, job(over), CREATED]);
    expect(await create({ CostNotToExceed: 4500 })).toMatchObject({ jsonBody: { code }, status });
    expect(wrote(/INSERT INTO PurchaseOrders/)).toBe(false);
  });
});

describe("upsertPurchaseOrder: editing", () => {
  const sentAndInMyob = { MyobCreatedAt: new Date(), MyobCreatedBy: "Abby", SentAt: new Date(), SentBy: "Fran" };

  it("a payee change on a sent, MYOB-marked PO clears both markers, ledgered as po.markers_reset", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Work" }), po(sentAndInMyob), STORED]);

    const res = await call("upsertPurchaseOrder", { ContractorID: 4, ContractorName: "Other Co", PurchaseOrderID: 99 });

    expect(res.status).toBe(200);
    const reset = sqls().find((sql) => /UPDATE PurchaseOrders SET SentAt = NULL/.test(sql)) ?? "";
    expect(reset).toMatch(/MyobCreatedAt = NULL, MyobCreatedBy = NULL/);
    expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ action: "po.markers_reset", ruleApplied: "payee_changed", subjectId: "99" })]);
  });

  it.each([
    ["done", { Status: "Done" }, 409, "job_done"],
    ["archived", { IsArchived: true }, 409, "job_archived"],
    ["internal", { IsInternal: true }, 422, "internal_job"],
  ])("an edit on a %s job is refused and ledgered against the PO (J3 review)", async (_label, over, status, code) => {
    mockSql([APP_USER, JOB_BUILDING, job(over), po(), { match: /FROM PurchaseOrders s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] }]);
    expect(await call("upsertPurchaseOrder", { PurchaseOrderID: 99, Scope: "x" })).toMatchObject({ jsonBody: { code }, status });
    expect(wrote(/UPDATE PurchaseOrders/)).toBe(false);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: expect.objectContaining({ attempted: "po.edit" }), ruleApplied: code, subjectId: "99", subjectType: "purchase_order" }),
    ]);
  });

  it("refuses a cost of $0 or a cleared cost, and edits on a done job", async () => {
    mockSql([APP_USER, job({ Status: "Work" }), po()]);
    expect((await call("upsertPurchaseOrder", { CostNotToExceed: null, PurchaseOrderID: 99 })).status).toBe(422);
    expect((await call("upsertPurchaseOrder", { EstimatedCost: 0, PurchaseOrderID: 99 })).status).toBe(422);
    mockSql([APP_USER, job({ Status: "Done" }), po()]);
    expect(await call("upsertPurchaseOrder", { PurchaseOrderID: 99, Scope: "x" })).toMatchObject({ jsonBody: { code: "job_done" }, status: 409 });
    expect(wrote(/UPDATE PurchaseOrders/)).toBe(false);
  });
});

describe("sendPurchaseOrder", () => {
  const SEND_READ: Route = {
    match: /SELECT c\.EmailAddress, po\.PDFBlobName/,
    rows: [{ ContractorID: 3, ContractorName: "Acme", CostNotToExceed: 4500, EmailAddress: "acme@example.com", EmailBody: "b", EmailSubject: "s", EstimatedCost: 4000, JobID: 9, PDFBlobName: "po/99.pdf", PONumber: "66Se261013", SentAt: null }],
  };

  it("sends a PO on a job whose quote is approved and writes it to the job's history", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Work" }), SEND_READ, STORED]);
    expect((await call("sendPurchaseOrder", { PurchaseOrderID: 99 })).status).toBe(200);
    expect(paramsOf(/INSERT INTO JobEvents[\s\S]*'po_sent'/)).toMatchObject({ CreatedBy: "Fran Manager", POID: 99 });
  });

  it("refuses to send without an approved quote, or on a done job, before any email goes", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ HasApprovedQuote: 0, Status: "Work" }), SEND_READ, PO_SCOPE]);
    expect(await call("sendPurchaseOrder", { PurchaseOrderID: 99 })).toMatchObject({ jsonBody: { code: "quote_not_approved" }, status: 422 });
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Done" }), SEND_READ, PO_SCOPE]);
    expect(await call("sendPurchaseOrder", { PurchaseOrderID: 99 })).toMatchObject({ jsonBody: { code: "job_done" }, status: 409 });
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });
});

describe("markPurchaseOrderMyobCreated (decision 4)", () => {
  it("refuses admin on a real record", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, po(), PO_SCOPE]);
    expect(await call("markPurchaseOrderMyobCreated", { id: 99, jobId: 9 })).toMatchObject({ jsonBody: { code: "admin_test_records_only" }, status: 403 });
    expect(wrote(/SET MyobCreatedAt = SYSUTCDATETIME\(\)/)).toBe(false);
  });

  it("lets a manager mark it", async () => {
    mockSql([APP_USER, JOB_BUILDING, po(), STORED]);
    expect((await call("markPurchaseOrderMyobCreated", { id: 99, jobId: 9 })).status).toBe(200);
  });
  it("refuses admin un-marking a real record too, ledgered", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, po({ MyobCreatedAt: new Date(), MyobCreatedBy: "Abby" }), PO_SCOPE]);
    expect(await call("unmarkPurchaseOrderMyobCreated", { id: 99, jobId: 9 })).toMatchObject({ jsonBody: { code: "admin_test_records_only" }, status: 403 });
    expect(wrote(/SET MyobCreatedAt = NULL/)).toBe(false);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: expect.objectContaining({ attempted: "po.unmark_myob_created" }), ruleApplied: "admin_test_records_only" }),
    ]);
  });
});
