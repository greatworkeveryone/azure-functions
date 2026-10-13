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
const blobs = require("../blob-storage") as { deleteBlob: jest.Mock; downloadBlob: jest.Mock };
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
const deletePurchaseOrder = registered("deletePurchaseOrder");
const markPurchaseOrderMyobCreated = registered("markPurchaseOrderMyobCreated");
const unmarkPurchaseOrderMyobCreated = registered("unmarkPurchaseOrderMyobCreated");
const markPurchaseOrderComplete = registered("markPurchaseOrderComplete");
const unmarkPurchaseOrderComplete = registered("unmarkPurchaseOrderComplete");

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

  describe("when the role gate says no", () => {
    const gate = { jsonBody: { details: "Required role: accounts | facilities_manager. Have: user", error: "Forbidden" }, status: 403 };

    beforeEach(() => {
      auth.requireRole.mockResolvedValue(gate);
      auth.rolesForRequest.mockResolvedValue(["user"]);
      mockSql([APP_USER, { match: /SELECT JobID, BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5, JobID: 42 }] }]);
    });

    it("an attempt to create a PO is recorded against the job, and answered with the gate's own 403", async () => {
      const res = await upsertPurchaseOrder(makeRequest(body), ctx);

      expect(res).toBe(gate);
      expect(ledgerInserts(db.executeQuery)).toEqual([
        expect.objectContaining({
          action: "denied",
          actorRole: "user",
          before: { attempted: "po.create" },
          buildingId: 5,
          jobId: 42,
          ruleApplied: "role_not_permitted",
          subjectId: "42",
          subjectType: "job",
        }),
      ]);
      expect(ran(/INSERT INTO PurchaseOrders/)).toBe(false);
    });

    it("an attempt to edit one is not a ledgered decision: nothing is recorded", async () => {
      const res = await upsertPurchaseOrder(makeRequest({ EstimatedCost: 100, JobID: 42, PurchaseOrderID: 99 }), ctx);

      expect(res).toBe(gate);
      expect(db.createRequestConnection).not.toHaveBeenCalled();
      expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    });
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

// ── Marking, completing and deleting ────────────────────────────────────────

describe("purchase order transitions", () => {
  const FIRST_SELECT = /FROM PurchaseOrders WITH \(UPDLOCK, HOLDLOCK\) WHERE PurchaseOrderID = @Id/;
  const stored: Route = { match: /SELECT\s+PurchaseOrderID, JobID, PONumber, Seq/, rows: [{ PurchaseOrderID: 99 }] };
  const poScope: Route = { match: /FROM PurchaseOrders s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 42 }] };
  const po = (over: Record<string, unknown> = {}): Route => ({
    match: FIRST_SELECT,
    rows: [
      {
        CompletedAt: null,
        CompletedBy: null,
        ContractorID: 3,
        ContractorName: "Acme",
        CostNotToExceed: 900,
        EstimatedCost: 800,
        JobID: 42,
        MyobCreatedAt: null,
        MyobCreatedBy: null,
        PDFBlobName: "po/99.pdf",
        PONumber: "66Se261013",
        SentAt: null,
        SentBy: null,
        ...over,
      },
    ],
  });
  const FACTS = { contractorId: 3, contractorName: "Acme", costNotToExceed: 900, estimatedCost: 800, poNumber: "66Se261013" };
  const SNAPSHOT = {
    ...FACTS,
    completedAt: null,
    completedBy: null,
    myobCreatedAt: null,
    myobCreatedBy: null,
    pdfBlobName: "po/99.pdf",
    sentAt: null,
    sentBy: null,
  };
  const gate = { jsonBody: { details: "Required role: accounts_manager | facilities_manager. Have: facilities", error: "Forbidden" }, status: 403 };
  const refuseRole = () => {
    auth.requireRole.mockResolvedValue(gate);
    auth.rolesForRequest.mockResolvedValue(["facilities"]);
    mockSql([APP_USER, poScope]);
  };
  const rows = () => ledgerInserts(db.executeQuery);
  const withIds = { id: 99, jobId: 42 };

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
    blobs.deleteBlob.mockResolvedValue(undefined);
    mockSql([APP_USER, JOB_BUILDING, po(), stored]);
  });

  afterEach(() => jest.restoreAllMocks());

  describe("deletePurchaseOrder", () => {
    const remove = () => deletePurchaseOrder(makeRequest({ PurchaseOrderID: 99 }), ctx);

    it("writes one po.delete exception row whose `before` is a snapshot of what was deleted", async () => {
      const res = await remove();

      expect(res).toEqual({ jsonBody: { deleted: true, purchaseOrderId: 99 }, status: 200 });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        action: "po.delete",
        actorKind: "user",
        actorName: "Fred Facilities",
        actorRole: "facilities_manager",
        actorUserId: 21,
        after: null,
        before: SNAPSHOT,
        buildingId: 5,
        isException: true,
        jobId: 42,
        subjectId: "99",
        subjectType: "purchase_order",
      });
    });

    it("deletes the PO and writes the ledger row inside one transaction that commits", async () => {
      await remove();

      const begun = db.beginTransaction.mock.invocationCallOrder[0];
      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      expect(orderOf(FIRST_SELECT)).toBeGreaterThan(begun);
      expect(orderOf(/DELETE FROM PurchaseOrders WHERE PurchaseOrderID = @Id/)).toBeGreaterThan(orderOf(FIRST_SELECT));
      expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(orderOf(/DELETE FROM PurchaseOrders/));
      expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(committed);
      expect(db.rollbackTransaction).not.toHaveBeenCalled();
    });

    it("removes the PDF only once the deletion and its record have committed", async () => {
      await remove();

      expect(blobs.deleteBlob).toHaveBeenCalledWith("po/99.pdf");
      expect(blobs.deleteBlob.mock.invocationCallOrder[0]).toBeGreaterThan(db.commitTransaction.mock.invocationCallOrder[0]);
    });

    it("is rolled back when the ledger write fails: the PO is not deleted without its record, and keeps its PDF", async () => {
      mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, po(), stored]);

      const res = await remove();

      expect(res.status).toBe(500);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      // The DELETE ran inside the transaction that was rolled back.
      expect(orderOf(/DELETE FROM PurchaseOrders/)).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
      expect(orderOf(/DELETE FROM PurchaseOrders/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
      expect(blobs.deleteBlob).not.toHaveBeenCalled();
    });

    it("keeps the PDF too when the delete itself fails", async () => {
      mockSql([{ match: /DELETE FROM PurchaseOrders/, reject: new Error("deadlock") }, APP_USER, JOB_BUILDING, po()]);

      const res = await remove();

      expect(res.status).toBe(500);
      expect(rows()).toHaveLength(0);
      expect(blobs.deleteBlob).not.toHaveBeenCalled();
    });

    it("a PO with no PDF has nothing to remove", async () => {
      mockSql([APP_USER, JOB_BUILDING, po({ PDFBlobName: null })]);

      const res = await remove();

      expect(res.status).toBe(200);
      expect(blobs.deleteBlob).not.toHaveBeenCalled();
      expect(rows()[0].before).toMatchObject({ pdfBlobName: null });
    });

    it("a sent PO is protected: the same 400, recorded as a refused attempt", async () => {
      mockSql([APP_USER, JOB_BUILDING, po({ SentAt: new Date("2026-10-05T00:00:00Z") })]);

      const res = await remove();

      expect(res).toEqual({ jsonBody: { error: "Cannot delete a purchase order that has been sent." }, status: 400 });
      expect(rows()).toEqual([
        expect.objectContaining({ action: "denied", before: { attempted: "po.delete" }, jobId: 42, ruleApplied: "po_sent", subjectId: "99" }),
      ]);
      expect(ran(/DELETE FROM PurchaseOrders/)).toBe(false);
      expect(blobs.deleteBlob).not.toHaveBeenCalled();
    });

    it("a completed PO is protected: the same 400, recorded as a refused attempt", async () => {
      mockSql([APP_USER, JOB_BUILDING, po({ CompletedAt: new Date("2026-10-05T00:00:00Z") })]);

      const res = await remove();

      expect(res).toEqual({ jsonBody: { error: "Cannot delete a purchase order that has been marked complete." }, status: 400 });
      expect(rows()).toEqual([expect.objectContaining({ action: "denied", ruleApplied: "po_completed" })]);
      expect(ran(/DELETE FROM PurchaseOrders/)).toBe(false);
    });

    it("404s an unknown PO, writing nothing", async () => {
      mockSql([APP_USER, JOB_BUILDING]);

      const res = await remove();

      expect(res.status).toBe(404);
      expect(rows()).toHaveLength(0);
    });

    it("answers 401 and deletes nothing when the ledger can't name who is deleting", async () => {
      auth.verifiedIdentityFromRequest.mockResolvedValue(null);

      const res = await remove();

      expect(res.status).toBe(401);
      expect(ran(/DELETE FROM PurchaseOrders/)).toBe(false);
      expect(blobs.deleteBlob).not.toHaveBeenCalled();
    });

    it("records a refused role as `denied`, deleting nothing", async () => {
      refuseRole();

      const res = await remove();

      expect(res).toBe(gate);
      expect(rows()).toEqual([expect.objectContaining({ before: { attempted: "po.delete" }, ruleApplied: "role_not_permitted", subjectId: "99" })]);
      expect(ran(/DELETE FROM PurchaseOrders/)).toBe(false);
    });
  });

  describe("markPurchaseOrderMyobCreated", () => {
    const mark = () => markPurchaseOrderMyobCreated(makeRequest(withIds), ctx);

    it("writes one po.myob_created row", async () => {
      const res = await mark();

      expect(res.status).toBe(200);
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        action: "po.myob_created",
        actorName: "Fred Facilities",
        actorRole: "facilities_manager",
        actorUserId: 21,
        after: { ...FACTS, myobCreated: true },
        before: { myobCreated: false },
        buildingId: 5,
        isException: false,
        jobId: 42,
        subjectId: "99",
        subjectType: "purchase_order",
      });
    });

    it("shows that it was already marked when it is marked again", async () => {
      mockSql([APP_USER, JOB_BUILDING, po({ MyobCreatedAt: new Date("2026-10-03T00:00:00Z") }), stored]);

      await mark();

      expect(rows()[0]).toMatchObject({ after: { myobCreated: true }, before: { myobCreated: true } });
    });

    it("stamps the PO and writes the ledger row inside one transaction that commits", async () => {
      await mark();

      const begun = db.beginTransaction.mock.invocationCallOrder[0];
      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      for (const write of [FIRST_SELECT, /SET MyobCreatedAt = SYSUTCDATETIME\(\)/, /INSERT INTO JobEvents/, /INSERT INTO dbo\.DecisionLedger/]) {
        expect(orderOf(write)).toBeGreaterThan(begun);
        expect(orderOf(write)).toBeLessThan(committed);
      }
    });

    it("is rolled back when the ledger write fails", async () => {
      mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, po(), stored]);

      const res = await mark();

      expect(res.status).toBe(500);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(orderOf(/SET MyobCreatedAt = SYSUTCDATETIME\(\)/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    });

    it("404s a PO that isn't on that job, writing nothing", async () => {
      mockSql([APP_USER, JOB_BUILDING]);

      const res = await mark();

      expect(res.status).toBe(404);
      expect(rows()).toHaveLength(0);
    });

    it("records a refused role as `denied`", async () => {
      refuseRole();

      const res = await mark();

      expect(res).toBe(gate);
      expect(rows()).toEqual([expect.objectContaining({ before: { attempted: "po.myob_created" }, ruleApplied: "role_not_permitted", subjectId: "99" })]);
    });
  });

  describe("unmarkPurchaseOrderMyobCreated", () => {
    const unmark = () => unmarkPurchaseOrderMyobCreated(makeRequest(withIds), ctx);
    const marked = po({ MyobCreatedAt: new Date("2026-10-03T04:05:06Z"), MyobCreatedBy: "Fred Facilities" });

    it("writes one po.unmark_myob_created exception row, keeping who marked it and when", async () => {
      mockSql([APP_USER, JOB_BUILDING, marked, stored]);

      const res = await unmark();

      expect(res.status).toBe(200);
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        action: "po.unmark_myob_created",
        actorName: "Fred Facilities",
        after: { ...FACTS, myobCreated: false },
        before: { ...SNAPSHOT, myobCreatedAt: "2026-10-03T04:05:06.000Z", myobCreatedBy: "Fred Facilities" },
        buildingId: 5,
        isException: true,
        jobId: 42,
        subjectId: "99",
        subjectType: "purchase_order",
      });
    });

    it("clears the marking and writes the ledger row inside one transaction that commits", async () => {
      mockSql([APP_USER, JOB_BUILDING, marked, stored]);

      await unmark();

      const begun = db.beginTransaction.mock.invocationCallOrder[0];
      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      for (const write of [/SET MyobCreatedAt = NULL/, /INSERT INTO JobEvents/, /INSERT INTO dbo\.DecisionLedger/]) {
        expect(orderOf(write)).toBeGreaterThan(begun);
        expect(orderOf(write)).toBeLessThan(committed);
      }
    });

    it("is rolled back when the ledger write fails", async () => {
      mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, marked, stored]);

      const res = await unmark();

      expect(res.status).toBe(500);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(orderOf(/SET MyobCreatedAt = NULL/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    });

    it("a completed PO can't be unmarked: the same 400, recorded as a refused attempt", async () => {
      mockSql([APP_USER, JOB_BUILDING, po({ CompletedAt: new Date("2026-10-05T00:00:00Z"), MyobCreatedAt: new Date("2026-10-03T00:00:00Z") })]);

      const res = await unmark();

      expect(res).toEqual({
        jsonBody: { error: "Cannot undo MYOB entry — this purchase order has already been marked complete." },
        status: 400,
      });
      expect(rows()).toEqual([expect.objectContaining({ action: "denied", before: { attempted: "po.unmark_myob_created" }, ruleApplied: "po_completed" })]);
      expect(ran(/SET MyobCreatedAt = NULL/)).toBe(false);
    });

    it("records a refused role as `denied`", async () => {
      refuseRole();

      const res = await unmark();

      expect(res).toBe(gate);
      expect(rows()).toEqual([expect.objectContaining({ before: { attempted: "po.unmark_myob_created" }, ruleApplied: "role_not_permitted" })]);
    });
  });

  describe("markPurchaseOrderComplete", () => {
    const complete = () => markPurchaseOrderComplete(makeRequest(withIds), ctx);
    const inMyob = po({ MyobCreatedAt: new Date("2026-10-03T00:00:00Z") });

    it("writes one po.complete row", async () => {
      mockSql([APP_USER, JOB_BUILDING, inMyob, stored]);

      const res = await complete();

      expect(res.status).toBe(200);
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        action: "po.complete",
        actorName: "Fred Facilities",
        actorUserId: 21,
        after: { ...FACTS, completed: true },
        before: { completed: false },
        buildingId: 5,
        isException: false,
        jobId: 42,
        subjectId: "99",
        subjectType: "purchase_order",
      });
    });

    it("completes the PO, moves the job on and writes the ledger row inside one transaction that commits", async () => {
      mockSql([APP_USER, JOB_BUILDING, inMyob, stored]);

      await complete();

      const begun = db.beginTransaction.mock.invocationCallOrder[0];
      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      expect(orderOf(/SET CompletedAt = SYSUTCDATETIME\(\)/)).toBeGreaterThan(begun);
      expect(statusHelpers.advanceJobStatus.mock.invocationCallOrder[0]).toBeGreaterThan(begun);
      expect(statusHelpers.advanceJobStatus.mock.invocationCallOrder[0]).toBeLessThan(orderOf(/INSERT INTO dbo\.DecisionLedger/));
      expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(committed);
    });

    it("is rolled back when the ledger write fails", async () => {
      mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, inMyob, stored]);

      const res = await complete();

      expect(res.status).toBe(500);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(orderOf(/SET CompletedAt = SYSUTCDATETIME\(\)/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    });

    it("a PO the books don't have yet can't be completed: the same 400, recorded as a refused attempt", async () => {
      mockSql([APP_USER, JOB_BUILDING, po(), stored]);

      const res = await complete();

      expect(res).toEqual({
        jsonBody: { error: "Cannot mark complete — this purchase order has not been marked as created in MYOB yet." },
        status: 400,
      });
      expect(rows()).toEqual([expect.objectContaining({ action: "denied", before: { attempted: "po.complete" }, jobId: 42, ruleApplied: "not_created_in_myob" })]);
      expect(ran(/SET CompletedAt = SYSUTCDATETIME\(\)/)).toBe(false);
      expect(statusHelpers.advanceJobStatus).not.toHaveBeenCalled();
    });

    it("records a refused role as `denied`", async () => {
      refuseRole();

      const res = await complete();

      expect(res).toBe(gate);
      expect(rows()).toEqual([expect.objectContaining({ before: { attempted: "po.complete" }, ruleApplied: "role_not_permitted" })]);
    });
  });

  describe("unmarkPurchaseOrderComplete", () => {
    const uncomplete = () => unmarkPurchaseOrderComplete(makeRequest(withIds), ctx);
    const completed = po({
      CompletedAt: new Date("2026-10-05T06:07:08Z"),
      CompletedBy: "Fred Facilities",
      MyobCreatedAt: new Date("2026-10-03T04:05:06Z"),
      MyobCreatedBy: "Fred Facilities",
    });

    it("writes one po.uncomplete exception row, keeping who completed it and when", async () => {
      mockSql([APP_USER, JOB_BUILDING, completed, stored]);

      const res = await uncomplete();

      expect(res.status).toBe(200);
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        action: "po.uncomplete",
        actorName: "Fred Facilities",
        after: { ...FACTS, completed: false },
        before: {
          ...SNAPSHOT,
          completedAt: "2026-10-05T06:07:08.000Z",
          completedBy: "Fred Facilities",
          myobCreatedAt: "2026-10-03T04:05:06.000Z",
          myobCreatedBy: "Fred Facilities",
        },
        buildingId: 5,
        isException: true,
        jobId: 42,
        subjectId: "99",
        subjectType: "purchase_order",
      });
    });

    it("clears the completion, rolls the job back and writes the ledger row inside one transaction that commits", async () => {
      mockSql([APP_USER, JOB_BUILDING, completed, stored]);

      await uncomplete();

      const begun = db.beginTransaction.mock.invocationCallOrder[0];
      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      for (const write of [/SET CompletedAt = NULL/, /UPDATE Jobs SET Status = 'Work'/, /INSERT INTO dbo\.DecisionLedger/]) {
        expect(orderOf(write)).toBeGreaterThan(begun);
        expect(orderOf(write)).toBeLessThan(committed);
      }
    });

    it("is rolled back when the ledger write fails: the job is not rolled back without a record of it", async () => {
      mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, completed, stored]);

      const res = await uncomplete();

      expect(res.status).toBe(500);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(orderOf(/UPDATE Jobs SET Status = 'Work'/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    });

    it("404s a PO that isn't on that job, writing nothing", async () => {
      mockSql([APP_USER, JOB_BUILDING]);

      const res = await uncomplete();

      expect(res.status).toBe(404);
      expect(rows()).toHaveLength(0);
    });

    it("records a refused role as `denied`", async () => {
      refuseRole();

      const res = await uncomplete();

      expect(res).toBe(gate);
      expect(rows()).toEqual([expect.objectContaining({ before: { attempted: "po.uncomplete" }, ruleApplied: "role_not_permitted" })]);
    });
  });
});
