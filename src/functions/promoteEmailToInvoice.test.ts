/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "ops@co.com", name: "Ops User", oid: "oid-1" }),
  };
});

jest.mock("../blob-storage", () => ({ generateReadSasUrl: jest.fn() }));
jest.mock("../graph", () => ({ graphFetchEmails: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }) }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn() }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn() }));
jest.mock("../quote-decisions", () => ({ approveDirectorQuote: jest.fn(), rejectQuote: jest.fn() }));

const db = require("../db") as { executeQuery: jest.Mock };
const { promoteEmailToInvoice } = require("./emails") as {
  promoteEmailToInvoice: (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;
};

const makeRequest = (body: unknown) =>
  ({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() }) as unknown as HttpRequest;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

function insertParams(): Record<string, unknown> {
  const call = db.executeQuery.mock.calls.find((c: unknown[]) => /INSERT INTO JobInvoices/.test(String(c[1])))!;
  return Object.fromEntries((call[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value]));
}

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
    /INSERT INTO JobInvoices/.test(sql) ? [{ JobInvoiceID: 11 }] : [],
  );
});

describe("promoteEmailToInvoice — SupplierInvoiceNumber", () => {
  it("stores the extracted invoice number as the supplier's number too", async () => {
    const res = await promoteEmailToInvoice(
      makeRequest({ EmailID: 3, JobID: 42, Amount: 100, ContractorName: "Acme", InvoiceNumber: " INV-0441 " }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ invoiceId: 11 });
    const params = insertParams();
    expect(params.SupplierInvoiceNumber).toBe("INV-0441");
    expect(params.InvoiceNumber).toBe(" INV-0441 ");
  });

  it("prefers an explicit SupplierInvoiceNumber", async () => {
    await promoteEmailToInvoice(
      makeRequest({ EmailID: 3, JobID: 42, InvoiceNumber: "OLD", SupplierInvoiceNumber: "INV-9" }),
      ctx,
    );
    expect(insertParams().SupplierInvoiceNumber).toBe("INV-9");
  });

  it("stores NULL when the email had no invoice number", async () => {
    await promoteEmailToInvoice(makeRequest({ EmailID: 3, JobID: 42 }), ctx);
    expect(insertParams().SupplierInvoiceNumber).toBeNull();
    db.executeQuery.mockClear();
    await promoteEmailToInvoice(makeRequest({ EmailID: 3, JobID: 42, InvoiceNumber: "A-1" }), ctx);
    expect(insertParams().SupplierInvoiceNumber).toBe("A-1");
    db.executeQuery.mockClear();
    await promoteEmailToInvoice(makeRequest({ EmailID: 3, JobID: 42, InvoiceNumber: null }), ctx);
    expect(insertParams().SupplierInvoiceNumber).toBeNull();
  });

  it("returns 400 for an over-long number before writing anything", async () => {
    const res = await promoteEmailToInvoice(makeRequest({ EmailID: 3, JobID: 42, InvoiceNumber: "x".repeat(256) }), ctx);
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("still requires EmailID and JobID", async () => {
    const res = await promoteEmailToInvoice(makeRequest({ InvoiceNumber: "A-1" }), ctx);
    expect(res.status).toBe(400);
  });
});
