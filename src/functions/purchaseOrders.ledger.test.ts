/// <reference types="jest" />
// Creating and sending a purchase order each write one decision-ledger row in
// the decision's own transaction (WP19b, PLAN §3.12). The DB layer is mocked and
// the real ledger runs, so what is asserted is the INSERT record() really sends.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  buildUpdateSet: jest.fn(),
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

jest.mock("../contractor-acronym-db", () => ({
  INTERNAL_ACRONYM: "INT",
  ensureContractorAcronym: jest.fn().mockResolvedValue("ACM"),
}));
jest.mock("../po-reference-db", () => ({
  resolvePoNumber: jest.fn().mockResolvedValue({ chargeCode: "e", poNumber: "66Se261013" }),
}));
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../graph", () => ({ graphSendMail: jest.fn() }));
jest.mock("../blob-storage", () => ({
  deleteBlob: jest.fn(),
  downloadBlob: jest.fn(),
  generateReadSasUrl: jest.fn(),
  uploadPurchaseOrderPdf: jest.fn(),
}));
jest.mock("../pdf/purchase-order-pdf", () => ({ renderPurchaseOrderPDF: jest.fn() }));
jest.mock("../pdf/default-po-email", () => ({ defaultPOEmail: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

const auth = require("../auth") as {
  requireRole: jest.Mock;
  rolesForRequest: jest.Mock;
  verifiedIdentityFromRequest: jest.Mock;
};
const db = require("../db") as {
  beginTransaction: jest.Mock;
  closeConnection: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const graph = require("../graph") as { graphSendMail: jest.Mock };
const blobs = require("../blob-storage") as { downloadBlob: jest.Mock };
const statusHelpers = require("../jobStatusHelpers") as { advanceJobStatus: jest.Mock };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
require("./purchaseOrders");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const registered = (name: string): Handler => {
  const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!hit) throw new Error(`handler ${name} not registered`);
  return (hit[1] as { handler: Handler }).handler;
};
const upsertPurchaseOrder = registered("upsertPurchaseOrder");
const sendPurchaseOrder = registered("sendPurchaseOrder");

type Route = { match: RegExp; reject?: Error; rows?: Record<string, unknown>[] };

/** Answers each statement by shape; the first matching route wins, anything else returns no rows. */
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    const hit = routes.find((r) => r.match.test(sql));
    if (hit?.reject) throw hit.reject;
    return hit?.rows ?? [];
  });
}

const orderOf = (re: RegExp): number => {
  const i = db.executeQuery.mock.calls.findIndex((c: unknown[]) => re.test(String(c[1])));
  return i < 0 ? -1 : db.executeQuery.mock.invocationCallOrder[i];
};
const ran = (re: RegExp): boolean => orderOf(re) >= 0;

function makeRequest(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const CALLER = { email: "fred@example.com", name: "Fred Facilities", oid: "fred-oid" };
const APP_USER: Route = { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 21 }] };
const JOB_BUILDING: Route = { match: /SELECT BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5 }] };
const LEDGER_FAILS: Route = { match: /INSERT INTO dbo\.DecisionLedger/, reject: new Error("ledger unavailable") };

describe("upsertPurchaseOrder: creating a PO", () => {
  const jobState = (over: Record<string, unknown> = {}): Route => ({
    match: /SELECT Status, AwaitingRole, ApprovedQuoteID FROM Jobs/,
    rows: [{ ApprovedQuoteID: 4, AwaitingRole: "facilities", Status: "Work", ...over }],
  });
  const create: Route[] = [
    jobState(),
    { match: /MAX\(Seq\)/, rows: [{ NextSeq: 7 }] },
    { match: /INSERT INTO PurchaseOrders/, rows: [{ PurchaseOrderID: 99 }] },
    { match: /FROM PurchaseOrders WHERE PurchaseOrderID/, rows: [{ PurchaseOrderID: 99 }] },
  ];
  const body = { ContractorID: 3, ContractorName: "Acme", CostNotToExceed: 900, EstimatedCost: 800, JobID: 42 };

  beforeEach(() => {
    jest.clearAllMocks();
    _resetRateLimitForTests();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    auth.requireRole.mockResolvedValue(null);
    auth.verifiedIdentityFromRequest.mockResolvedValue(CALLER);
    auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
    db.beginTransaction.mockResolvedValue(undefined);
    db.commitTransaction.mockResolvedValue(undefined);
    db.rollbackTransaction.mockResolvedValue(undefined);
    db.createRequestConnection.mockResolvedValue({ id: "connection" });
    statusHelpers.advanceJobStatus.mockResolvedValue(undefined);
    mockSql([APP_USER, JOB_BUILDING, ...create]);
  });

  afterEach(() => jest.restoreAllMocks());

  it("writes one po.create row naming who, what, where, and the cost limits", async () => {
    const res = await upsertPurchaseOrder(makeRequest(body), ctx);

    expect(res.status).toBe(200);
    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "po.create",
      actorKind: "user",
      actorName: "Fred Facilities",
      actorRole: "facilities_manager",
      actorUserId: 21,
      after: { contractorId: 3, contractorName: "Acme", costNotToExceed: 900, estimatedCost: 800, poNumber: "66Se261013" },
      before: null,
      buildingId: 5,
      isException: false,
      jobId: 42,
      reason: null,
      subjectId: "99",
      subjectType: "purchase_order",
    });
  });

  it("writes an internal PO (no contractor, no cost) with nulls rather than failing", async () => {
    const res = await upsertPurchaseOrder(makeRequest({ JobID: 42 }), ctx);

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)[0].after).toEqual({
      contractorId: null,
      contractorName: null,
      costNotToExceed: null,
      estimatedCost: null,
      poNumber: "66Se261013",
    });
  });

  it("inserts the PO, moves the job on and writes the ledger row inside one transaction that commits", async () => {
    await upsertPurchaseOrder(makeRequest(body), ctx);

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    expect(orderOf(/INSERT INTO PurchaseOrders/)).toBeGreaterThan(begun);
    expect(statusHelpers.advanceJobStatus.mock.invocationCallOrder[0]).toBeGreaterThan(orderOf(/INSERT INTO PurchaseOrders/));
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(statusHelpers.advanceJobStatus.mock.invocationCallOrder[0]);
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(committed);
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("rolls the PO back when the ledger write fails: no ledger row, no PO", async () => {
    mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, ...create]);

    const res = await upsertPurchaseOrder(makeRequest(body), ctx);

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(/INSERT INTO PurchaseOrders/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("answers 401 before starting when the ledger can't name who is creating the PO", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(CALLER).mockResolvedValueOnce(null);

    const res = await upsertPurchaseOrder(makeRequest(body), ctx);

    expect(res.status).toBe(401);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("404s an unknown job, writing nothing", async () => {
    mockSql([APP_USER, JOB_BUILDING]);

    const res = await upsertPurchaseOrder(makeRequest(body), ctx);

    expect(res.status).toBe(404);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });

  it("editing a PO is not a ledgered decision, and doesn't even look up who is editing", async () => {
    mockSql([
      { match: /SELECT PurchaseOrderID, JobID, PONumber, ContractorName/, rows: [{ JobID: 42, PONumber: "66Se261013", PurchaseOrderID: 99 }] },
      { match: /SELECT\s+PurchaseOrderID, JobID, PONumber, Seq/, rows: [{ PurchaseOrderID: 99 }] },
    ]);

    const res = await upsertPurchaseOrder(makeRequest({ EstimatedCost: 100, PurchaseOrderID: 99 }), ctx);

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(ran(/FROM dbo\.AppUsers/)).toBe(false);
  });

  describe("a PO that would act as the quote's approval is refused", () => {
    const leapfrog = jobState({ ApprovedQuoteID: null, Status: "Awaiting Approval" });
    const MESSAGE =
      "Cannot create a purchase order — the quote hasn't been approved yet. Approve the quote first (this enforces the approval limit) before raising a PO.";

    it("still 422s with the same words, and records `denied` against the job", async () => {
      mockSql([leapfrog, APP_USER, JOB_BUILDING, ...create]);

      const res = await upsertPurchaseOrder(makeRequest(body), ctx);

      expect(res).toEqual({ jsonBody: { error: MESSAGE }, status: 422 });
      const rows = ledgerInserts(db.executeQuery);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "denied",
        actorName: "Fred Facilities",
        actorRole: "facilities_manager",
        before: { attempted: "po.create", jobStatus: "Awaiting Approval" },
        buildingId: 5,
        isException: true,
        jobId: 42,
        reason: MESSAGE,
        ruleApplied: "quote_not_approved",
        subjectId: "42",
        subjectType: "job",
      });
      expect(ran(/INSERT INTO PurchaseOrders/)).toBe(false);
    });

    it("records it in a transaction of its own, once the decision's has rolled back", async () => {
      mockSql([leapfrog, APP_USER, JOB_BUILDING, ...create]);

      await upsertPurchaseOrder(makeRequest(body), ctx);

      expect(db.beginTransaction).toHaveBeenCalledTimes(2);
      expect(db.rollbackTransaction.mock.invocationCallOrder[0]).toBeLessThan(db.beginTransaction.mock.invocationCallOrder[1]);
      expect(db.commitTransaction).toHaveBeenCalledTimes(1);
      expect(db.commitTransaction.mock.invocationCallOrder[0]).toBeGreaterThan(orderOf(/INSERT INTO dbo\.DecisionLedger/));
    });

    it("answers the same 422 even when the refusal can't be recorded", async () => {
      mockSql([LEDGER_FAILS, leapfrog, APP_USER, JOB_BUILDING, ...create]);

      const res = await upsertPurchaseOrder(makeRequest(body), ctx);

      expect(res).toEqual({ jsonBody: { error: MESSAGE }, status: 422 });
    });
  });
});

describe("sendPurchaseOrder", () => {
  const po = (over: Record<string, unknown> = {}): Route => ({
    match: /SELECT c\.EmailAddress, po\.PDFBlobName/,
    rows: [
      {
        ContractorID: 3,
        ContractorName: "Acme",
        CostNotToExceed: 900,
        EmailAddress: "contractor@example.com",
        EmailBody: "Hi",
        EmailSubject: "PO",
        EstimatedCost: 800,
        JobID: 42,
        PDFBlobName: "po/99.pdf",
        PONumber: "66Se261013",
        SentAt: null,
        ...over,
      },
    ],
  });
  const stored: Route = { match: /SELECT\s+PurchaseOrderID, JobID, PONumber, Seq/, rows: [{ PurchaseOrderID: 99 }] };
  const send = () => sendPurchaseOrder(makeRequest({ PurchaseOrderID: 99 }), ctx);

  beforeEach(() => {
    jest.clearAllMocks();
    _resetRateLimitForTests();
    jest.spyOn(console, "error").mockImplementation(() => undefined);
    auth.requireRole.mockResolvedValue(null);
    auth.verifiedIdentityFromRequest.mockResolvedValue(CALLER);
    auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
    db.beginTransaction.mockResolvedValue(undefined);
    db.commitTransaction.mockResolvedValue(undefined);
    db.rollbackTransaction.mockResolvedValue(undefined);
    db.createRequestConnection.mockResolvedValue({ id: "connection" });
    graph.graphSendMail.mockResolvedValue(undefined);
    blobs.downloadBlob.mockResolvedValue(Buffer.from("pdf"));
    mockSql([APP_USER, JOB_BUILDING, po(), stored]);
  });

  afterEach(() => jest.restoreAllMocks());

  it("writes one po.send row naming who sent which PO to which contractor, and where", async () => {
    const res = await send();

    expect(res.status).toBe(200);
    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "po.send",
      actorKind: "user",
      actorName: "Fred Facilities",
      actorRole: "facilities_manager",
      actorUserId: 21,
      after: { contractorId: 3, contractorName: "Acme", costNotToExceed: 900, estimatedCost: 800, poNumber: "66Se261013", sent: true },
      before: { sentAt: null },
      buildingId: 5,
      isException: false,
      jobId: 42,
      subjectId: "99",
      subjectType: "purchase_order",
    });
  });

  it("keeps the contractor's email address out of the ledger", async () => {
    await send();

    expect(JSON.stringify(ledgerInserts(db.executeQuery))).not.toContain("contractor@example.com");
  });

  it("shows the earlier send when a PO is sent again", async () => {
    mockSql([APP_USER, JOB_BUILDING, po({ SentAt: new Date("2026-10-01T02:03:04Z") }), stored]);

    await send();

    expect(ledgerInserts(db.executeQuery)[0].before).toEqual({ sentAt: "2026-10-01T02:03:04.000Z" });
  });

  it("flips SentAt and writes the ledger row inside one transaction that commits", async () => {
    await send();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    expect(orderOf(/UPDATE PurchaseOrders\s+SET SentAt/)).toBeGreaterThan(begun);
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(orderOf(/UPDATE PurchaseOrders\s+SET SentAt/));
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(committed);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("finds who is sending and which job it is for before the mail goes out", async () => {
    await send();

    const mailed = graph.graphSendMail.mock.invocationCallOrder[0];
    expect(orderOf(/FROM dbo\.AppUsers WHERE EntraOid/)).toBeLessThan(mailed);
    expect(orderOf(/SELECT BuildingID FROM Jobs WHERE JobID/)).toBeLessThan(mailed);
    expect(db.beginTransaction.mock.invocationCallOrder[0]).toBeGreaterThan(mailed);
  });

  it("rolls the SentAt flip back when the ledger write fails: no ledger row, no recorded send", async () => {
    mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, po(), stored]);

    const res = await send();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(/UPDATE PurchaseOrders\s+SET SentAt/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
  });

  it("sends nothing when the ledger can't name who is sending", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(CALLER).mockResolvedValueOnce(null);

    const res = await send();

    expect(res.status).toBe(401);
    expect(graph.graphSendMail).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("sends nothing when the ledger actor can't be looked up", async () => {
    mockSql([{ match: /FROM dbo\.AppUsers WHERE EntraOid/, reject: new Error("connection reset") }, po(), stored]);

    const res = await send();

    expect(res.status).toBe(500);
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("a PO that can't be sent yet (no PDF) is a 400 with no mail, no transaction, no ledger row", async () => {
    mockSql([APP_USER, JOB_BUILDING, po({ PDFBlobName: null }), stored]);

    const res = await send();

    expect(res.status).toBe(400);
    expect(graph.graphSendMail).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });

  it("a mail that fails to send records nothing", async () => {
    graph.graphSendMail.mockRejectedValue(new Error("Graph 503"));

    const res = await send();

    expect(res.status).toBe(500);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });

  it("404s an unknown PO", async () => {
    mockSql([APP_USER, JOB_BUILDING]);

    const res = await send();

    expect(res.status).toBe(404);
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("records a refused role as `denied`, sends nothing, and answers with the gate's own 403", async () => {
    const gate = { jsonBody: { details: "Required role: accounts_manager | facilities_manager. Have: facilities", error: "Forbidden" }, status: 403 };
    auth.requireRole.mockResolvedValue(gate);
    auth.rolesForRequest.mockResolvedValue(["facilities"]);
    mockSql([APP_USER, { match: /FROM PurchaseOrders s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 42 }] }]);

    const res = await send();

    expect(res).toBe(gate);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "denied",
        actorRole: "facilities",
        before: { attempted: "po.send" },
        buildingId: 5,
        jobId: 42,
        ruleApplied: "role_not_permitted",
        subjectId: "99",
        subjectType: "purchase_order",
      }),
    ]);
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });
});
