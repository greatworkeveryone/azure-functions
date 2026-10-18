/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));

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

const db = require("../db") as { executeQuery: jest.Mock; createRequestConnection: jest.Mock; closeConnection: jest.Mock };
const auth = require("../auth") as { requireRole: jest.Mock; extractToken: jest.Mock; AppRole: Record<string, string> };
const { resolveReference } = require("./resolveReference") as typeof import("./resolveReference");

type Row = Record<string, unknown>;
interface Data {
  pos?: Row[];
  invoices?: Row[];
  quotes?: Row[];
  dbCodes?: Row[];
  buildings?: Row[];
  decodedPos?: Row[];
  decodedJobs?: Row[];
}

function arrange(data: Data = {}) {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (/FROM PurchaseOrders WHERE PONumber = @Ref/.test(sql)) return data.pos ?? [];
    if (/FROM JobInvoices/.test(sql)) return data.invoices ?? [];
    if (/FROM Quotes WHERE QuoteNumber/.test(sql)) return data.quotes ?? [];
    if (/SELECT ReferenceCode, BuildingName FROM Buildings/.test(sql)) return data.dbCodes ?? [];
    if (/SELECT BuildingID FROM Buildings WHERE ReferenceCode/.test(sql)) return data.buildings ?? [];
    if (/FROM PurchaseOrders po/.test(sql)) return data.decodedPos ?? [];
    if (/FROM Jobs\s+WHERE BuildingID/.test(sql)) return data.decodedJobs ?? [];
    throw new Error(`unexpected query: ${sql}`);
  });
}

const makeRequest = (ref?: string) =>
  ({ headers: { get: () => null }, query: new URLSearchParams(ref === undefined ? "" : { ref }) }) as unknown as HttpRequest;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

function queries() {
  return db.executeQuery.mock.calls.map((c: unknown[]) => ({
    sql: String(c[1]),
    params: Object.fromEntries(((c[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value])),
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  db.createRequestConnection.mockResolvedValue({});
  auth.requireRole.mockResolvedValue(null);
  auth.extractToken.mockReturnValue("mock-token");
  arrange();
});

describe("resolveReference — access and input", () => {
  it("returns 401 without a token", async () => {
    auth.extractToken.mockReturnValue(null);
    const res = await resolveReference(makeRequest("66Sm261013"), ctx);
    expect(res.status).toBe(401);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("returns the role check's response when the caller may not read jobs", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await resolveReference(makeRequest("66Sm261013"), ctx);
    expect(res.status).toBe(403);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("allows the same roles that can read jobs", async () => {
    await resolveReference(makeRequest("66Sm261013"), ctx);
    const allowed = [...auth.requireRole.mock.calls[0][1]].sort();

    // getJobs reads its gate from the who-can-do-what table (viewJobs).
    const { ACTION_ROLES } = require("../action-roles") as typeof import("../action-roles");
    const jobRoles = [...ACTION_ROLES.viewJobs.gate].sort();

    expect(jobRoles.length).toBeGreaterThan(0);
    expect(allowed).toEqual(jobRoles);
  });

  it.each([[undefined], [""], ["   "]])("returns 400 when ref is %j", async (ref) => {
    const res = await resolveReference(makeRequest(ref), ctx);
    expect(res.status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("returns 400 over 100 characters", async () => {
    const res = await resolveReference(makeRequest("x".repeat(101)), ctx);
    expect(res.status).toBe(400);
  });

  it("trims the reference", async () => {
    await resolveReference(makeRequest("  66Sm261013 "), ctx);
    expect(queries()[0].params.Ref).toBe("66Sm261013");
  });
});

describe("resolveReference — exact matches", () => {
  it("finds a PO by number and skips decoding", async () => {
    arrange({ pos: [{ PurchaseOrderID: 9, JobID: 42, PONumber: "66Sm261013" }] });

    const res = await resolveReference(makeRequest("66Sm261013"), ctx);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({
      exact: [
        { type: "purchaseOrder", id: 9, jobId: 42, number: "66Sm261013", matchedOn: "PONumber", href: "/jobs?jobId=42&step=po&poId=9" },
      ],
      decoded: [],
      truncated: false,
    });
    expect(queries().some((q: { sql: string }) => /FROM Buildings/.test(q.sql))).toBe(false);
  });

  it("finds an invoice by its generated number", async () => {
    arrange({ invoices: [{ JobInvoiceID: 5, JobID: 7, InvoiceNumber: "261012-IV-7-AC-1", SupplierInvoiceNumber: "INV-9" }] });
    const res = await resolveReference(makeRequest("261012-IV-7-AC-1"), ctx);
    expect(res.jsonBody.exact).toEqual([
      { type: "invoice", id: 5, jobId: 7, number: "261012-IV-7-AC-1", matchedOn: "InvoiceNumber", href: "/jobs?jobId=7&step=invoices&invoiceId=5" },
    ]);
  });

  it("finds an invoice by the supplier's number", async () => {
    arrange({ invoices: [{ JobInvoiceID: 5, JobID: 7, InvoiceNumber: "261012-IV-7-AC-1", SupplierInvoiceNumber: "INV-0041/A" }] });
    const res = await resolveReference(makeRequest("INV-0041/A"), ctx);
    expect(res.jsonBody.exact).toEqual([
      { type: "invoice", id: 5, jobId: 7, number: "INV-0041/A", matchedOn: "SupplierInvoiceNumber", href: "/jobs?jobId=7&step=invoices&invoiceId=5" },
    ]);
  });

  it("finds a quote by number", async () => {
    arrange({ quotes: [{ QuoteID: 3, JobID: 8, QuoteNumber: "260419-QT-8-CR-1" }] });
    const res = await resolveReference(makeRequest("260419-QT-8-CR-1"), ctx);
    expect(res.jsonBody.exact).toEqual([
      { type: "quote", id: 3, jobId: 8, number: "260419-QT-8-CR-1", matchedOn: "QuoteNumber", href: "/jobs?jobId=8&step=quotes&quoteId=3" },
    ]);
  });

  it("returns every kind of exact match together", async () => {
    arrange({
      pos: [{ PurchaseOrderID: 1, JobID: 1, PONumber: "X" }],
      invoices: [{ JobInvoiceID: 2, JobID: 1, InvoiceNumber: "X", SupplierInvoiceNumber: null }],
      quotes: [{ QuoteID: 3, JobID: 1, QuoteNumber: "X" }],
    });
    const res = await resolveReference(makeRequest("X"), ctx);
    expect(res.jsonBody.exact.map((m: { type: string }) => m.type)).toEqual(["purchaseOrder", "invoice", "quote"]);
  });

  it("uses an exact (equality) comparison on all four columns", async () => {
    await resolveReference(makeRequest("100%_"), ctx);
    const sql = queries().map((q: { sql: string }) => q.sql).join("\n");
    expect(sql).toMatch(/PONumber = @Ref/);
    expect(sql).toMatch(/InvoiceNumber = @Ref OR SupplierInvoiceNumber = @Ref/);
    expect(sql).toMatch(/QuoteNumber = @Ref/);
    expect(sql).not.toMatch(/LIKE/);
  });

  it("caps exact matches at 50 and says so", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ PurchaseOrderID: i, JobID: 1, PONumber: "X" }));
    arrange({ pos: many, quotes: [{ QuoteID: 99, JobID: 1, QuoteNumber: "X" }] });
    const res = await resolveReference(makeRequest("X"), ctx);
    expect(res.jsonBody.exact).toHaveLength(50);
    expect(res.jsonBody.truncated).toBe(true);
    expect(queries()[0].params.Cap).toBe(50);
  });
});

describe("resolveReference — decoding legacy references", () => {
  const building = [{ BuildingID: 100 }];

  it("decodes a day reference to the building's POs and jobs in that Darwin day", async () => {
    arrange({
      buildings: building,
      decodedPos: [{ PurchaseOrderID: 9, JobID: 42, PONumber: "260419-PO-42-ACM-7", CreatedAt: new Date("2026-10-13T01:00:00Z") }],
      decodedJobs: [{ JobID: 43, Title: "Leaking tap", CreatedAt: new Date("2026-10-13T02:00:00Z") }],
    });

    const res = await resolveReference(makeRequest("66Sm261013"), ctx);

    expect(res.status).toBe(200);
    expect(res.jsonBody.exact).toEqual([]);
    expect(res.jsonBody.decoded).toHaveLength(1);
    const [entry] = res.jsonBody.decoded;
    expect(entry.decomposition).toMatchObject({
      buildingCode: "66S",
      buildingLabel: "66 Smith St",
      chargeCode: "m",
      period: { kind: "day", from: "2026-10-13", to: "2026-10-13" },
    });
    expect(entry.matches).toEqual([
      { type: "purchaseOrder", id: 9, jobId: 42, buildingId: 100, label: "260419-PO-42-ACM-7", createdAt: "2026-10-13T01:00:00.000Z", href: "/jobs?jobId=42&step=po&poId=9" },
      { type: "job", id: 43, jobId: 43, buildingId: 100, label: "Leaking tap", createdAt: "2026-10-13T02:00:00.000Z", href: "/jobs?jobId=43" },
    ]);

    const q = queries();
    const buildingQuery = q.find((x: { sql: string }) => /SELECT BuildingID FROM Buildings WHERE ReferenceCode/.test(x.sql))!;
    expect(buildingQuery.params.Code).toBe("66S");
    const poQuery = q.find((x: { sql: string }) => /FROM PurchaseOrders po/.test(x.sql))!;
    expect(poQuery.params).toMatchObject({ BuildingID: 100, ChargeCode: "m" });
    expect((poQuery.params.From as Date).toISOString()).toBe("2026-10-12T14:30:00.000Z");
    expect((poQuery.params.To as Date).toISOString()).toBe("2026-10-13T14:30:00.000Z");
    const jobQuery = q.find((x: { sql: string }) => /FROM Jobs\s+WHERE BuildingID/.test(x.sql))!;
    expect((jobQuery.params.From as Date).toISOString()).toBe("2026-10-12T14:30:00.000Z");
  });

  it("decodes a quarter with the mixed-case McM code", async () => {
    arrange({ buildings: building });
    const res = await resolveReference(makeRequest("McMgm26q3"), ctx);
    const [entry] = res.jsonBody.decoded;
    expect(entry.decomposition).toMatchObject({ buildingCode: "McM", chargeCode: "gm", period: { kind: "quarter" } });
    const poQuery = queries().find((x: { sql: string }) => /FROM PurchaseOrders po/.test(x.sql))!;
    expect((poQuery.params.From as Date).toISOString()).toBe("2026-06-30T14:30:00.000Z");
    expect((poQuery.params.To as Date).toISOString()).toBe("2026-09-30T14:30:00.000Z");
  });

  it("filters purchase orders by charge code but jobs only by building and period", async () => {
    arrange({ buildings: building });
    await resolveReference(makeRequest("9Ce2610"), ctx);
    const q = queries();
    expect(q.find((x: { sql: string }) => /FROM PurchaseOrders po/.test(x.sql))!.sql).toMatch(/po\.ChargeCode = @ChargeCode/);
    expect(q.find((x: { sql: string }) => /FROM Jobs\s+WHERE BuildingID/.test(x.sql))!.sql).not.toMatch(/ChargeCode/);
  });

  it("returns the decomposition with no matches when no building carries the code", async () => {
    const res = await resolveReference(makeRequest("66Sm261013"), ctx);
    expect(res.jsonBody.decoded).toEqual([
      { decomposition: expect.objectContaining({ buildingCode: "66S" }), matches: [] },
    ]);
  });

  it("decodes non-building codes without finding anything", async () => {
    const res = await resolveReference(makeRequest("ALLins26a"), ctx);
    const [entry] = res.jsonBody.decoded;
    expect(entry.decomposition).toMatchObject({ buildingCode: "ALL", buildingLabel: "Many buildings", period: { kind: "year" } });
    expect(entry.matches).toEqual([]);
  });

  it("reads a collision suffix", async () => {
    const res = await resolveReference(makeRequest("66Sm261013b"), ctx);
    expect(res.jsonBody.decoded[0].decomposition.suffix).toBe("b");
  });

  it("decodes building codes that exist only in the database", async () => {
    arrange({ dbCodes: [{ ReferenceCode: "13Z", BuildingName: "13 Zebra Street" }], buildings: building });
    const res = await resolveReference(makeRequest("13Zm261013"), ctx);
    expect(res.jsonBody.decoded[0].decomposition).toMatchObject({ buildingCode: "13Z", buildingLabel: "13 Zebra Street" });
  });

  it.each([["hello"], ["66SM261013"], ["mcmgm26q3"], ["66Sm261332"], ["260419-PO-42-ACM-7"]])(
    "returns empty results for %j",
    async (ref) => {
      const res = await resolveReference(makeRequest(ref), ctx);
      expect(res.status).toBe(200);
      expect(res.jsonBody).toEqual({ exact: [], decoded: [], truncated: false });
    },
  );

  it("caps the decoded matches at 50 across decompositions", async () => {
    const pos = Array.from({ length: 40 }, (_, i) => ({ PurchaseOrderID: i, JobID: 1, PONumber: `P${i}`, CreatedAt: null }));
    const jobs = Array.from({ length: 40 }, (_, i) => ({ JobID: 100 + i, Title: `J${i}`, CreatedAt: null }));
    arrange({ buildings: building, decodedPos: pos, decodedJobs: jobs });

    const res = await resolveReference(makeRequest("66Sm261013"), ctx);

    expect(res.jsonBody.decoded[0].matches).toHaveLength(50);
    expect(res.jsonBody.truncated).toBe(true);
  });
});

describe("resolveReference — failures", () => {
  it("returns a 500 and closes the connection when a query fails", async () => {
    db.executeQuery.mockRejectedValue(new Error("boom"));
    const res = await resolveReference(makeRequest("66Sm261013"), ctx);
    expect(res.status).toBe(500);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });

  it("closes the connection after a successful run", async () => {
    await resolveReference(makeRequest("66Sm261013"), ctx);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});
