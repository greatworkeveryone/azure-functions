/// <reference types="jest" />
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
  };
});

jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn().mockResolvedValue([]) }));
jest.mock("../mybuildings-client", () => ({ fetchInvoices: jest.fn() }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../jobPlannerSync", () => ({ syncJobActionTriggersStandalone: jest.fn().mockResolvedValue(undefined) }));

const db = require("../db") as { executeQuery: jest.Mock; createRequestConnection: jest.Mock };
const { upsertJobInvoice } = require("./invoices") as {
  upsertJobInvoice: (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;
};

function makeRequest(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const STORED = {
  JobInvoiceID: 5,
  JobID: 42,
  InvoiceNumber: "261012-IV-42-ACM-1",
  SupplierInvoiceNumber: "INV-0041",
};

function calls() {
  return db.executeQuery.mock.calls.map((c: unknown[]) => ({
    sql: String(c[1]),
    params: Object.fromEntries(((c[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value])),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/MAX\(Seq\)/.test(sql)) return [{ NextSeq: 1 }];
    if (/INSERT INTO JobInvoices/.test(sql)) return [{ JobInvoiceID: 5 }];
    if (/SELECT JobInvoiceID, JobID, InvoiceNumber, Amount/.test(sql)) {
      return [{ JobInvoiceID: 5, JobID: 42, InvoiceNumber: "261012-IV-42-ACM-1", Amount: 100, ContractorName: "Acme", Status: "pending", ApprovedAt: null }];
    }
    if (/FROM JobInvoices WHERE JobInvoiceID/.test(sql)) return [STORED];
    return [];
  });
});

describe("upsertJobInvoice — SupplierInvoiceNumber", () => {
  it("stores the supplier's number verbatim on create and keeps the generated InvoiceNumber", async () => {
    const res = await upsertJobInvoice(
      makeRequest({ JobID: 42, ContractorName: "Acme Corp", Amount: 100, SupplierInvoiceNumber: "  INV-0041 " }),
      ctx,
    );

    expect(res.status).toBe(200);
    const insert = calls().find((c: { sql: string }) => /INSERT INTO JobInvoices/.test(c.sql))!;
    expect(insert.sql).toMatch(/SupplierInvoiceNumber\)/);
    expect(insert.params.SupplierInvoiceNumber).toBe("INV-0041");
    expect(insert.params.InvoiceNumber).toMatch(/^\d{6}-IV-42-AC-1$/);
    expect(res.jsonBody.invoice.SupplierInvoiceNumber).toBe("INV-0041");
  });

  it("stores NULL when it is absent or blank", async () => {
    await upsertJobInvoice(makeRequest({ JobID: 42 }), ctx);
    await upsertJobInvoice(makeRequest({ JobID: 42, SupplierInvoiceNumber: "   " }), ctx);
    const inserts = calls().filter((c: { sql: string }) => /INSERT INTO JobInvoices/.test(c.sql));
    expect(inserts).toHaveLength(2);
    for (const insert of inserts) expect(insert.params.SupplierInvoiceNumber).toBeNull();
  });

  it("does not truncate a long number to 16 characters", async () => {
    const number = "TAX/2026/10/0000123456";
    await upsertJobInvoice(makeRequest({ JobID: 42, SupplierInvoiceNumber: number }), ctx);
    expect(calls().find((c: { sql: string }) => /INSERT INTO JobInvoices/.test(c.sql))!.params.SupplierInvoiceNumber).toBe(number);
  });

  it("returns 400 over 255 characters without touching the database", async () => {
    const res = await upsertJobInvoice(makeRequest({ JobID: 42, SupplierInvoiceNumber: "x".repeat(256) }), ctx);
    expect(res.status).toBe(400);
    expect(res.jsonBody.error).toMatch(/255/);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-string", async () => {
    const res = await upsertJobInvoice(makeRequest({ JobID: 42, SupplierInvoiceNumber: 123 }), ctx);
    expect(res.status).toBe(400);
  });

  it("returns the field in the stored invoice payload", async () => {
    await upsertJobInvoice(makeRequest({ JobID: 42, SupplierInvoiceNumber: "INV-0041" }), ctx);
    const select = calls().find((c: { sql: string }) => /SELECT[\s\S]*FROM JobInvoices WHERE JobInvoiceID/.test(c.sql) && /SupplierInvoiceNumber/.test(c.sql));
    expect(select).toBeDefined();
  });

  it("can correct the number on update, and leaves it alone when not supplied", async () => {
    await upsertJobInvoice(makeRequest({ JobInvoiceID: 5, SupplierInvoiceNumber: "INV-0042" }), ctx);
    const update = calls().find((c: { sql: string }) => /UPDATE JobInvoices SET/.test(c.sql))!;
    expect(update.sql).toMatch(/SupplierInvoiceNumber = @SupplierInvoiceNumber/);
    expect(update.params.SupplierInvoiceNumber).toBe("INV-0042");

    db.executeQuery.mockClear();
    await upsertJobInvoice(makeRequest({ JobInvoiceID: 5, Notes: "x" }), ctx);
    const plain = calls().find((c: { sql: string }) => /UPDATE JobInvoices SET/.test(c.sql))!;
    expect(plain.sql).not.toMatch(/SupplierInvoiceNumber/);
  });

  it("clears the number on update with null", async () => {
    await upsertJobInvoice(makeRequest({ JobInvoiceID: 5, SupplierInvoiceNumber: null }), ctx);
    const update = calls().find((c: { sql: string }) => /UPDATE JobInvoices SET/.test(c.sql))!;
    expect(update.params.SupplierInvoiceNumber).toBeNull();
  });

  it("rejects an over-long number on update too", async () => {
    const res = await upsertJobInvoice(makeRequest({ JobInvoiceID: 5, SupplierInvoiceNumber: "x".repeat(300) }), ctx);
    expect(res.status).toBe(400);
  });
});
