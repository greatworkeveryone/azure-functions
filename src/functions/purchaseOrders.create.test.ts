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
    rolesForRequest: jest.fn().mockResolvedValue(["facilities_manager"]),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({
      email: "fred@randazzo.properties",
      name: "Fred Facilities",
      oid: "fred-oid",
    }),
  };
});

jest.mock("../contractor-acronym-db", () => ({
  INTERNAL_ACRONYM: "INT",
  ensureContractorAcronym: jest.fn().mockResolvedValue("ACM"),
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

const db = require("../db") as { executeQuery: jest.Mock; rollbackTransaction: jest.Mock; commitTransaction: jest.Mock };
const { upsertPurchaseOrder } = require("./purchaseOrders") as {
  upsertPurchaseOrder: (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;
};

function makeRequest(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}

const warn = jest.fn();
const ctx = { error: jest.fn(), log: jest.fn(), warn } as unknown as InvocationContext;

interface Scenario {
  referenceCode: string | null;
  jobType?: string;
  existing?: string[];
}

function arrange({ referenceCode, jobType = "Electrical", existing = [] }: Scenario) {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/SELECT Status, AwaitingRole, ApprovedQuoteID FROM Jobs/.test(sql)) {
      return [{ Status: "Work", AwaitingRole: "facilities", ApprovedQuoteID: 5 }];
    }
    if (/MAX\(Seq\)/.test(sql)) return [{ NextSeq: 7 }];
    if (/FROM Jobs j/.test(sql)) return [{ Category: "Common Areas", JobType: jobType, SubType: null, ReferenceCode: referenceCode }];
    if (/UPDLOCK, HOLDLOCK\) WHERE PONumber LIKE/.test(sql)) return existing.map((PONumber) => ({ PONumber }));
    if (/INSERT INTO PurchaseOrders/.test(sql)) return [{ PurchaseOrderID: 99 }];
    if (/FROM PurchaseOrders WHERE PurchaseOrderID/.test(sql)) return [{ PurchaseOrderID: 99 }];
    return [];
  });
}

function insertParams(): Record<string, unknown> {
  const call = db.executeQuery.mock.calls.find(([, sql]: [unknown, string]) => /INSERT INTO PurchaseOrders/.test(sql));
  expect(call).toBeDefined();
  return Object.fromEntries((call![2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value]));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers().setSystemTime(new Date("2026-10-12T20:00:00Z")); // 13 Oct in Darwin
});
afterEach(() => jest.useRealTimers());

describe("upsertPurchaseOrder — PO number in Johanne's format", () => {
  it("numbers a PO as building + charge code + Darwin date and stores the charge code", async () => {
    arrange({ referenceCode: "66S" });

    const res = await upsertPurchaseOrder(makeRequest({ JobID: 42, ContractorID: 3 }), ctx);

    expect(res.status).toBe(200);
    const params = insertParams();
    expect(params.PONumber).toBe("66Se261013");
    expect(params.ChargeCode).toBe("e");
    expect(params.Seq).toBe(7);
    expect(warn).not.toHaveBeenCalled();
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("includes ChargeCode in the INSERT statement", async () => {
    arrange({ referenceCode: "66S" });
    await upsertPurchaseOrder(makeRequest({ JobID: 42, ContractorID: 3 }), ctx);
    const sql = db.executeQuery.mock.calls.map(([, s]: [unknown, string]) => s).find((s: string) => /INSERT INTO PurchaseOrders/.test(s));
    expect(sql).toMatch(/CreatedBy, ChargeCode\)/);
    expect(sql).toMatch(/@CreatedBy, @ChargeCode\)/);
  });

  it("honours a valid body ChargeCode over the job's category", async () => {
    arrange({ referenceCode: "McM" });
    await upsertPurchaseOrder(makeRequest({ JobID: 42, ContractorID: 3, ChargeCode: "gm" }), ctx);
    expect(insertParams()).toMatchObject({ PONumber: "McMgm261013", ChargeCode: "gm" });
  });

  it("ignores an unknown body ChargeCode and derives one", async () => {
    arrange({ referenceCode: "66S", jobType: "Lifts" });
    await upsertPurchaseOrder(makeRequest({ JobID: 42, ContractorID: 3, ChargeCode: "nope" }), ctx);
    expect(insertParams()).toMatchObject({ PONumber: "66Slm261013", ChargeCode: "lm" });
  });

  it("suffixes a same-day repeat for the same building and charge code", async () => {
    arrange({ referenceCode: "66S", existing: ["66Se261013"] });
    await upsertPurchaseOrder(makeRequest({ JobID: 42, ContractorID: 3 }), ctx);
    expect(insertParams().PONumber).toBe("66Se261013b");
  });

  it("falls back to the legacy number, with one warning, when the building has no ReferenceCode", async () => {
    arrange({ referenceCode: null });

    const res = await upsertPurchaseOrder(makeRequest({ JobID: 42, ContractorID: 3 }), ctx);

    expect(res.status).toBe(200);
    const params = insertParams();
    expect(params.PONumber).toBe("261012-PO-42-ACM-7");
    expect(params.ChargeCode).toBe("e");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/no ReferenceCode/);
  });

  it("uses the internal acronym for the fallback when there is no contractor", async () => {
    arrange({ referenceCode: null });
    await upsertPurchaseOrder(makeRequest({ JobID: 42 }), ctx);
    expect(insertParams().PONumber).toBe("261012-PO-42-INT-7");
  });

  it("still requires JobID to create", async () => {
    arrange({ referenceCode: "66S" });
    const res = await upsertPurchaseOrder(makeRequest({ ContractorID: 3 }), ctx);
    expect(res.status).toBe(400);
  });
});
