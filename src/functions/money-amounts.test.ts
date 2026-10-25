/// <reference types="jest" />
// DL-14: "1,500" must be stored as 1500 and an unreadable amount refused with a
// 400 before any database work — never parseFloat'd into $1.
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return {
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    buildUpdateSet: actual.buildUpdateSet,
    closeConnection: jest.fn(),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    createRequestConnection: jest.fn().mockResolvedValue({}),
    executeQuery: jest.fn(),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
  };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "ann@rp", name: "Ann Accounts", oid: "ann-oid" }),
  };
});

jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn().mockResolvedValue([]) }));
jest.mock("../mybuildings-client", () => ({ fetchInvoices: jest.fn() }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../jobPlannerSync", () => ({ syncJobActionTriggersStandalone: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../contractor-acronym-db", () => ({
  ensureContractorAcronym: jest.fn().mockResolvedValue("ACM"),
  INTERNAL_ACRONYM: "INT",
}));

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;
const db = require("../db") as { executeQuery: jest.Mock; createRequestConnection: jest.Mock };
const { upsertJobInvoice } = require("./invoices") as { upsertJobInvoice: Handler };
const { upsertQuote } = require("./quotes") as { upsertQuote: Handler };
const { upsertPurchaseOrder } = require("./purchaseOrders") as { upsertPurchaseOrder: Handler };

const makeRequest = (body: unknown) =>
  ({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() }) as unknown as HttpRequest;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const paramOf = (sqlPattern: RegExp, name: string) => {
  const call = db.executeQuery.mock.calls.find((c: unknown[]) => sqlPattern.test(String(c[1])));
  const params = (call?.[2] ?? []) as { name: string; value: unknown }[];
  return params.find((p) => p.name === name)?.value;
};

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/MAX\(Seq\)/.test(sql)) return [{ NextSeq: 1 }];
    if (/INSERT INTO JobInvoices/.test(sql)) return [{ JobInvoiceID: 5 }];
    if (/INSERT INTO Quotes/.test(sql)) return [{ QuoteID: 9 }];
    if (/SELECT JobInvoiceID, JobID, InvoiceNumber, Amount/.test(sql)) {
      return [{ JobInvoiceID: 5, JobID: 42, InvoiceNumber: "IV-1", Amount: 100, ContractorName: "Acme", Status: "pending", ApprovedAt: null }];
    }
    return [{}];
  });
});

describe("upsertJobInvoice amount", () => {
  it('stores "1,500" as 1500 on create', async () => {
    const res = await upsertJobInvoice(makeRequest({ JobID: 42, ContractorName: "Acme", Amount: "1,500" }), ctx);
    expect(res.status).toBe(200);
    expect(paramOf(/INSERT INTO JobInvoices/, "Amount")).toBe(1500);
  });

  it('stores "$1,500.50" as 1500.5 on update', async () => {
    await upsertJobInvoice(makeRequest({ JobInvoiceID: 5, Amount: "$1,500.50" }), ctx);
    expect(paramOf(/UPDATE JobInvoices SET/, "Amount")).toBe(1500.5);
  });

  it.each(["abc", "-5", "1.234", -5])("returns 400 for %p without touching the database", async (amount) => {
    const res = await upsertJobInvoice(makeRequest({ JobID: 42, Amount: amount }), ctx);
    expect(res.status).toBe(400);
    expect(res.jsonBody.error).toMatch(/Amount/);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("upsertQuote amount", () => {
  it('stores "1,500" as 1500 on create', async () => {
    const res = await upsertQuote(makeRequest({ JobID: 42, ContractorName: "Acme", Amount: "1,500" }), ctx);
    expect(res.status).toBe(200);
    expect(paramOf(/INSERT INTO Quotes/, "Amount")).toBe(1500);
  });

  it("returns 400 for a non-numeric amount", async () => {
    const res = await upsertQuote(makeRequest({ JobID: 42, Amount: "abc" }), ctx);
    expect(res.status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("upsertPurchaseOrder costs", () => {
  it.each([
    [{ EstimatedCost: "abc" }, /EstimatedCost/],
    [{ CostNotToExceed: "-5" }, /CostNotToExceed/],
  ])("returns 400 for %p", async (costs, message) => {
    const res = await upsertPurchaseOrder(makeRequest({ JobID: 42, ...costs }), ctx);
    expect(res.status).toBe(400);
    expect(res.jsonBody.error).toMatch(message);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("email promote amounts", () => {
  const { promoteEmailToInvoice, promoteEmailToQuote } = require("./emails") as {
    promoteEmailToInvoice: Handler;
    promoteEmailToQuote: Handler;
  };

  it.each([
    ["promoteEmailToInvoice", () => promoteEmailToInvoice],
    ["promoteEmailToQuote", () => promoteEmailToQuote],
  ])("%s returns 400 for an unreadable amount", async (_name, handler) => {
    const res = await handler()(makeRequest({ EmailID: 3, JobID: 42, Amount: "1,50" }), ctx);
    expect(res.status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});
