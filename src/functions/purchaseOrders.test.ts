/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  buildUpdateSet: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    rolesForRequest: jest.fn().mockResolvedValue(["accounts_manager"]),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({
      email: "johanne@randazzo.properties",
      name: "Johanne CFO",
      oid: "cfo-oid",
    }),
  };
});

jest.mock("../graph", () => ({ graphSendMail: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../blob-storage", () => ({
  deleteBlob: jest.fn(),
  downloadBlob: jest.fn().mockResolvedValue(Buffer.from("pdf")),
  generateReadSasUrl: jest.fn(),
  uploadPurchaseOrderPdf: jest.fn(),
}));
jest.mock("../pdf/purchase-order-pdf", () => ({ renderPurchaseOrderPDF: jest.fn() }));
jest.mock("../pdf/default-po-email", () => ({ defaultPOEmail: jest.fn() }));
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn().mockResolvedValue(undefined) }));

const db = require("../db") as { executeQuery: jest.Mock };
const auth = require("../auth") as { verifiedIdentityFromRequest: jest.Mock };
const graph = require("../graph") as { graphSendMail: jest.Mock };
const statusHelpers = require("../jobStatusHelpers") as { advanceJobStatus: jest.Mock };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: unknown }>;

// purchaseOrders.ts registers its handlers without exporting them. Capture them
// now: beforeEach's clearAllMocks wipes app.http's recorded calls.
require("./purchaseOrders");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const registered = (name: string): Handler => {
  const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!hit) throw new Error(`handler ${name} not registered`);
  return (hit[1] as { handler: Handler }).handler;
};
const upsertPurchaseOrder = registered("upsertPurchaseOrder");
const sendPurchaseOrder = registered("sendPurchaseOrder");
const markPurchaseOrderMyobCreated = registered("markPurchaseOrderMyobCreated");
const markPurchaseOrderComplete = registered("markPurchaseOrderComplete");

type SqlRoute = [RegExp, Record<string, unknown>[]];

function routeSql(routes: SqlRoute[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    const hit = routes.find(([re]) => re.test(sql));
    return hit ? hit[1] : [];
  });
}

function sqlCalls(): { params: Record<string, unknown>; sql: string }[] {
  return db.executeQuery.mock.calls.map((c: unknown[]) => ({
    params: Object.fromEntries(
      ((c[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value]),
    ),
    sql: String(c[1]),
  }));
}

const callMatching = (re: RegExp) => sqlCalls().find((c) => re.test(c.sql));

function expectNoForgedName(): void {
  expect(sqlCalls().flatMap((c) => Object.values(c.params))).not.toContain("Someone Else");
}

function makeRequest(body: unknown): HttpRequest {
  return {
    headers: { get: () => null },
    json: jest.fn().mockResolvedValue(body),
    query: new URLSearchParams(),
  } as unknown as HttpRequest;
}

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const storedPo: SqlRoute = [/SELECT\s+PurchaseOrderID, JobID, PONumber, Seq/, [{ PurchaseOrderID: 3 }]];

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset().mockResolvedValue([]);
});

describe("upsertPurchaseOrder", () => {
  it("create: records the token's name as CreatedBy and job actor, ignoring CreatedBy in the body", async () => {
    routeSql([
      [/SELECT Status, AwaitingRole, ApprovedQuoteID FROM Jobs/, [{ ApprovedQuoteID: 4, AwaitingRole: "facilities", Status: "Quote" }]],
      [/MAX\(Seq\)/, [{ NextSeq: 1 }]],
      [/INSERT INTO PurchaseOrders/, [{ PurchaseOrderID: 3 }]],
      storedPo,
    ]);

    const res = await upsertPurchaseOrder(makeRequest({ CreatedBy: "Someone Else", JobID: 9 }), ctx);

    expect(res.status).toBe(200);
    expect(callMatching(/INSERT INTO PurchaseOrders/)?.params.CreatedBy).toBe("Johanne CFO");
    expect(statusHelpers.advanceJobStatus).toHaveBeenCalledWith(
      expect.anything(),
      9,
      expect.anything(),
      expect.objectContaining({ actor: "Johanne CFO" }),
    );
    expectNoForgedName();
  });

  it("edit: the po_edited event carries the token's name, ignoring CreatedBy in the body", async () => {
    routeSql([
      [
        /SELECT PurchaseOrderID, JobID, PONumber, ContractorName,\s+EstimatedCost/,
        [{ JobID: 9, PONumber: "PO-9-1", PurchaseOrderID: 3 }],
      ],
      storedPo,
    ]);

    const res = await upsertPurchaseOrder(
      makeRequest({ CreatedBy: "Someone Else", EstimatedCost: 100, PurchaseOrderID: 3 }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(callMatching(/INSERT INTO JobEvents/)?.params.CreatedBy).toBe("Johanne CFO");
    expectNoForgedName();
  });

  it("401s without touching the database when the token has no verified identity", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await upsertPurchaseOrder(makeRequest({ JobID: 9 }), ctx);

    expect(res.status).toBe(401);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("sendPurchaseOrder", () => {
  const poRow: SqlRoute = [
    /SELECT c\.EmailAddress, po\.PDFBlobName/,
    [{ EmailAddress: "contractor@example.com", EmailBody: "Hi", EmailSubject: "PO", PDFBlobName: "po/3.pdf", PONumber: "PO-9-1" }],
  ];

  it("records the token's name as SentBy and CCs the token's email, ignoring SentBy and SentByEmail", async () => {
    routeSql([poRow, storedPo]);

    const res = await sendPurchaseOrder(
      makeRequest({ PurchaseOrderID: 3, SentBy: "Someone Else", SentByEmail: "attacker@evil.example" }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(callMatching(/SET SentAt = SYSUTCDATETIME\(\), SentBy = @SentBy/)?.params.SentBy).toBe("Johanne CFO");
    expect(graph.graphSendMail.mock.calls[0][4]).toEqual(["johanne@randazzo.properties"]);
    expectNoForgedName();
  });

  it("401s without sending when the token has no verified identity", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await sendPurchaseOrder(makeRequest({ PurchaseOrderID: 3 }), ctx);

    expect(res.status).toBe(401);
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });
});

describe("markPurchaseOrderMyobCreated", () => {
  it("records the token's name, ignoring createdBy in the body", async () => {
    routeSql([
      [/FROM PurchaseOrders WITH \(UPDLOCK, HOLDLOCK\) WHERE PurchaseOrderID = @Id AND JobID/, [{ PONumber: "PO-9-1", PurchaseOrderID: 3 }]],
      storedPo,
    ]);

    const res = await markPurchaseOrderMyobCreated(makeRequest({ createdBy: "Someone Else", id: 3, jobId: 9 }), ctx);

    expect(res.status).toBe(200);
    expect(callMatching(/MyobCreatedBy = @CreatedBy/)?.params.CreatedBy).toBe("Johanne CFO");
    expect(callMatching(/INSERT INTO JobEvents/)?.params.CreatedBy).toBe("Johanne CFO");
    expectNoForgedName();
  });

  it("401s when the token has no verified identity", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await markPurchaseOrderMyobCreated(makeRequest({ id: 3, jobId: 9 }), ctx);

    expect(res.status).toBe(401);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("markPurchaseOrderComplete", () => {
  it("records the token's name as CompletedBy, event actor and status actor, ignoring completedBy", async () => {
    routeSql([
      [/FROM PurchaseOrders WITH \(UPDLOCK, HOLDLOCK\) WHERE PurchaseOrderID = @Id AND JobID/, [{ MyobCreatedAt: new Date(), PONumber: "PO-9-1" }]],
      storedPo,
    ]);

    const res = await markPurchaseOrderComplete(makeRequest({ completedBy: "Someone Else", id: 3, jobId: 9 }), ctx);

    expect(res.status).toBe(200);
    expect(callMatching(/CompletedBy = @CompletedBy/)?.params.CompletedBy).toBe("Johanne CFO");
    expect(callMatching(/INSERT INTO JobEvents/)?.params.CreatedBy).toBe("Johanne CFO");
    expect(statusHelpers.advanceJobStatus).toHaveBeenCalledWith(
      expect.anything(),
      9,
      expect.anything(),
      expect.objectContaining({ actor: "Johanne CFO" }),
    );
    expectNoForgedName();
  });

  it("401s when the token has no verified identity", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await markPurchaseOrderComplete(makeRequest({ id: 3, jobId: 9 }), ctx);

    expect(res.status).toBe(401);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});
