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

// J3: the invoice lands on a job that takes money records, read under lock.
const LIVE_JOB = [{ BuildingID: 5, HasApprovedQuote: 1, IsArchived: false, IsContract: false, IsInternal: false, JobID: 42, Status: "Work" }];
const isJobRead = (sql: string): boolean => /SELECT j\.JobID, j\.Status, j\.IsInternal, j\.IsArchived/.test(sql);

function insertParams(): Record<string, unknown> {
  const call = db.executeQuery.mock.calls.find((c: unknown[]) => /INSERT INTO JobInvoices/.test(String(c[1])))!;
  return Object.fromEntries((call[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value]));
}

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
    /INSERT INTO JobInvoices/.test(sql) ? [{ JobInvoiceID: 11 }] : isJobRead(sql) ? LIVE_JOB : [],
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
      makeRequest({ Amount: 100, EmailID: 3, JobID: 42, InvoiceNumber: "OLD", SupplierInvoiceNumber: "INV-9" }),
      ctx,
    );
    expect(insertParams().SupplierInvoiceNumber).toBe("INV-9");
  });

  it("stores NULL when the email had no invoice number", async () => {
    await promoteEmailToInvoice(makeRequest({ Amount: 100, EmailID: 3, JobID: 42 }), ctx);
    expect(insertParams().SupplierInvoiceNumber).toBeNull();
    db.executeQuery.mockClear();
    await promoteEmailToInvoice(makeRequest({ Amount: 100, EmailID: 3, JobID: 42, InvoiceNumber: "A-1" }), ctx);
    expect(insertParams().SupplierInvoiceNumber).toBe("A-1");
    db.executeQuery.mockClear();
    await promoteEmailToInvoice(makeRequest({ Amount: 100, EmailID: 3, JobID: 42, InvoiceNumber: null }), ctx);
    expect(insertParams().SupplierInvoiceNumber).toBeNull();
  });

  it("returns 400 for an over-long number before writing anything", async () => {
    const res = await promoteEmailToInvoice(makeRequest({ Amount: 100, EmailID: 3, JobID: 42, InvoiceNumber: "x".repeat(256) }), ctx);
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("still requires EmailID and JobID", async () => {
    const res = await promoteEmailToInvoice(makeRequest({ InvoiceNumber: "A-1" }), ctx);
    expect(res.status).toBe(400);
  });
});

describe("promoteEmailToInvoice — the contractor", () => {
  const contractorLookups = () =>
    db.executeQuery.mock.calls.filter((c: unknown[]) => /FROM dbo\.Contractors/.test(String(c[1])));

  beforeEach(() => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/INSERT INTO JobInvoices/.test(sql)) return [{ JobInvoiceID: 11 }];
      if (/FROM dbo\.Contractors WHERE ContractorID/.test(sql)) return [{ ContractorName: "Acme Pty Ltd" }];
      if (isJobRead(sql)) return LIVE_JOB;
      return [];
    });
  });

  it("stores the contractor's id with the name when the request has both", async () => {
    const res = await promoteEmailToInvoice(
      makeRequest({ Amount: 100, ContractorID: 7, ContractorName: "Acme", EmailID: 3, JobID: 42 }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(insertParams()).toMatchObject({ ContractorID: 7, ContractorName: "Acme" });
    const insert = db.executeQuery.mock.calls.find((c: unknown[]) => /INSERT INTO JobInvoices/.test(String(c[1])))!;
    expect(String(insert[1])).toMatch(/\(JobID, Amount, ContractorID, ContractorName,/);
  });

  it("checks the id against the contractors we have, binding it", async () => {
    await promoteEmailToInvoice(makeRequest({ Amount: 100, ContractorID: 7, EmailID: 3, JobID: 42 }), ctx);

    expect(contractorLookups()).toHaveLength(1);
    expect(String(contractorLookups()[0][1])).toBe("SELECT ContractorName FROM dbo.Contractors WHERE ContractorID = @ContractorID");
    expect(contractorLookups()[0][2]).toEqual([expect.objectContaining({ name: "ContractorID", value: 7 })]);
  });

  it("takes the contractor's own name when only the id comes", async () => {
    await promoteEmailToInvoice(makeRequest({ Amount: 100, ContractorID: 7, EmailID: 3, JobID: 42 }), ctx);

    expect(insertParams()).toMatchObject({ ContractorID: 7, ContractorName: "Acme Pty Ltd" });
  });

  it("keeps a name that came with the id, even if it isn't the contractor's own", async () => {
    await promoteEmailToInvoice(makeRequest({ Amount: 100, ContractorID: 7, ContractorName: "Acme Plumbing", EmailID: 3, JobID: 42 }), ctx);

    expect(insertParams()).toMatchObject({ ContractorID: 7, ContractorName: "Acme Plumbing" });
  });

  it("leaves the id null when only a name comes, and never looks the name up", async () => {
    await promoteEmailToInvoice(makeRequest({ Amount: 100, ContractorName: "Acme Plumbing", EmailID: 3, JobID: 42 }), ctx);

    expect(insertParams()).toMatchObject({ ContractorID: null, ContractorName: "Acme Plumbing" });
    expect(contractorLookups()).toHaveLength(0);
  });

  it("stores neither when the request names no contractor", async () => {
    await promoteEmailToInvoice(makeRequest({ Amount: 100, EmailID: 3, JobID: 42 }), ctx);

    expect(insertParams()).toMatchObject({ ContractorID: null, ContractorName: null });
    expect(contractorLookups()).toHaveLength(0);
  });

  it("refuses an id that isn't a contractor, writing nothing", async () => {
    db.executeQuery.mockImplementation(async () => []);

    const res = await promoteEmailToInvoice(makeRequest({ Amount: 100, ContractorID: 999, EmailID: 3, JobID: 42 }), ctx);

    expect(res).toEqual({ jsonBody: { error: "ContractorID does not match a contractor" }, status: 400 });
    expect(db.executeQuery.mock.calls.some((c: unknown[]) => /INSERT INTO JobInvoices|UPDATE Emails/.test(String(c[1])))).toBe(false);
  });

  it.each([0, -3, 1.5, "7", 2147483648, true])("refuses %p as an id without looking anything up", async (bad) => {
    const res = await promoteEmailToInvoice(makeRequest({ Amount: 100, ContractorID: bad, EmailID: 3, JobID: 42 }), ctx);

    expect(res).toEqual({ jsonBody: { error: "ContractorID must be a whole number" }, status: 400 });
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});
