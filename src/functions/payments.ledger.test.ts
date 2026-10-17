/// <reference types="jest" />
// Recording a payment and marking one paid each write one decision-ledger row
// in the decision's own transaction (WP19b, PLAN §3.12). Since J3 neither
// calls MYOB: a payment lives in Floorplan only, and a MYOB bill is its own
// explicit action through lane M's proposals (decision 12). The DB layer is
// mocked and the real ledger runs.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";
import { moneyShape } from "../__tests__/fixtures/moneyRowShape";

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
  createServiceRequestConnection: jest.fn(),
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

jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn().mockResolvedValue([]) }));
jest.mock("../myob-client", () => ({ applyMyobPayment: jest.fn(), createMyobBill: jest.fn() }));
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
const myob = require("../myob-client") as { applyMyobPayment: jest.Mock; createMyobBill: jest.Mock };
const limitsDb = require("../approval-limits-db") as { getCachedApprovalLimits: jest.Mock };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
require("./payments");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const registered = (name: string): Handler => (app.http.mock.calls.find((c: unknown[]) => c[0] === name)?.[1] as { handler: Handler }).handler;
const markPaymentPaid = registered("markPaymentPaid");
const upsertPayment = registered("upsertPayment");

type Route = { match: RegExp; reject?: Error; rows?: Record<string, unknown>[] };

// An invoice keeps the contractor's name and no id; the ledger looks the id up.
const CONTRACTOR: Route = { match: /FROM dbo\.Contractors WHERE ContractorName/, rows: [{ ContractorID: 3 }] };

/** Answers each statement by shape; the first matching route wins, anything else returns no rows. */
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    const hit = [...routes, CONTRACTOR].find((r) => r.match.test(sql));
    if (hit?.reject) throw hit.reject;
    return hit?.rows ?? [];
  });
}

const orderOf = (re: RegExp): number => {
  const i = db.executeQuery.mock.calls.findIndex((c: unknown[]) => re.test(String(c[1])));
  return i < 0 ? -1 : db.executeQuery.mock.invocationCallOrder[i];
};

function makeRequest(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const CALLER = { email: "casey@example.com", name: "Casey Controller", oid: "controller-oid" };
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const APP_USER: Route = { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 21 }] };
const JOB_BUILDING: Route = { match: /SELECT BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5 }] };
const LEDGER_FAILS: Route = { match: /INSERT INTO dbo\.DecisionLedger/, reject: new Error("ledger unavailable") };

const payment = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  Amount: 100,
  JobID: 9,
  JobInvoiceID: 5,
  MyobID: "bill-uid",
  PaymentID: 11,
  PurchaseOrderID: null,
  QuoteID: 7,
  Status: "pending",
  ...over,
});
const FIRST_SELECT = /FROM Payments WITH \(UPDLOCK, HOLDLOCK\) WHERE PaymentID = @Id/;
const INVOICE_LOCK = /FROM JobInvoices i WITH \(UPDLOCK, HOLDLOCK\)/;
const invoiceLock = (over: Record<string, unknown> = {}): Route => ({
  match: INVOICE_LOCK,
  rows: [{ Amount: 1000, DirectorApprovedAt: null, Direction: "incoming", JobID: 9, PaidSoFar: 0, Status: "approved", ...over }],
});
const paymentRoutes = (over: Record<string, unknown> = {}, invoice: Record<string, unknown> = {}): Route[] => [
  APP_USER,
  JOB_BUILDING,
  {
    match: /SELECT InvoiceNumber, ContractorName, SupplierInvoiceNumber, Amount, ContractorID FROM JobInvoices/,
    rows: [{ Amount: 1000, ContractorName: "Acme", InvoiceNumber: "IV-9-1", SupplierInvoiceNumber: "INV-0042" }],
  },
  invoiceLock(invoice),
  { match: FIRST_SELECT, rows: [payment(over)] },
  { match: /SELECT\s+PaymentID, JobID/, rows: [payment({ Status: "paid" })] },
];

const markPaid = () => markPaymentPaid(makeRequest({ PaymentID: 11 }), ctx);

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  auth.requireRole.mockResolvedValue(null);
  auth.verifiedIdentityFromRequest.mockResolvedValue(CALLER);
  auth.rolesForRequest.mockResolvedValue(["accounts_manager"]);
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  db.createRequestConnection.mockResolvedValue({ id: "connection" });
  myob.applyMyobPayment.mockResolvedValue(undefined);
  myob.createMyobBill.mockResolvedValue({ uid: "bill-uid", url: "https://myob.example/bill-uid" });
  limitsDb.getCachedApprovalLimits.mockResolvedValue([]);
  mockSql(paymentRoutes());
});

// Every money row any test here writes has the shape trend reports read (see the fixture).
afterEach(() => moneyShape.check(ledgerInserts(db.executeQuery)));
afterEach(() => moneyShape.checkInvoiceReads(db.executeQuery.mock.calls));
afterEach(() => jest.restoreAllMocks());

describe("markPaymentPaid", () => {
  it("writes one payment.mark_paid row naming who, what, where and from what", async () => {
    const res = await markPaid();

    expect(res.status).toBe(200);
    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "payment.mark_paid",
      actorKind: "user",
      actorName: "Casey Controller",
      actorRole: "accounts_manager",
      actorUserId: 21,
      after: {
        amount: 100,
        contractorId: 3,
        contractorName: "Acme",
        invoiceNumber: "IV-9-1",
        jobInvoiceId: 5,
        myobBillUid: "bill-uid",
        purchaseOrderId: null,
        quoteId: 7,
        status: "paid",
        supplierInvoiceNumber: "INV-0042",
      },
      before: { contractorId: 3, contractorName: "Acme", status: "pending" },
      buildingId: 5,
      isException: false,
      jobId: 9,
      reason: null,
      subjectId: "11",
      subjectType: "payment",
    });
  });

  describe("in Floorplan only (J3)", () => {
    it("never calls MYOB, even for a payment that carries a MYOB bill, and warns about nothing", async () => {
      const res = await markPaid();

      expect(res.status).toBe(200);
      expect(myob.applyMyobPayment).not.toHaveBeenCalled();
      expect(res.jsonBody).not.toHaveProperty("myobWarning");
    });

    it("re-checks the invoice under the payment's lock, then writes the status and its ledger row in one commit", async () => {
      await markPaid();

      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      expect(orderOf(INVOICE_LOCK)).toBeGreaterThan(orderOf(FIRST_SELECT));
      expect(orderOf(/UPDATE Payments\s+SET Status = 'paid'/)).toBeGreaterThan(orderOf(INVOICE_LOCK));
      expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(orderOf(/UPDATE Payments\s+SET Status = 'paid'/));
      expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(committed);
      expect(db.rollbackTransaction).not.toHaveBeenCalled();
    });

    it("counts only the invoice's other payments against its balance", async () => {
      await markPaid();

      const call = db.executeQuery.mock.calls.find((c: unknown[]) => INVOICE_LOCK.test(String(c[1])));
      const params = Object.fromEntries((call?.[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value]));
      expect(params).toMatchObject({ ExcludePaymentID: 11, JobInvoiceID: 5 });
    });
  });

  it("a payment recorded before invoices were linked is refused: there is no invoice to check it against", async () => {
    mockSql(paymentRoutes({ JobInvoiceID: null }));

    const res = await markPaid();

    expect(res).toMatchObject({ jsonBody: { code: "no_invoice" }, status: 422 });
    expect(orderOf(/UPDATE Payments/)).toBe(-1);
    expect(orderOf(INVOICE_LOCK)).toBe(-1);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "denied",
        before: { attempted: "payment.mark_paid", status: "pending" },
        ruleApplied: "no_invoice",
        subjectId: "11",
        subjectType: "payment",
      }),
    ]);
  });

  it("an invoice that has since been rejected stops the payment being marked paid", async () => {
    mockSql(paymentRoutes({}, { Status: "rejected" }));

    const res = await markPaid();

    expect(res).toMatchObject({ jsonBody: { code: "invoice_not_approved" }, status: 422 });
    expect(orderOf(/UPDATE Payments/)).toBe(-1);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ action: "denied", ruleApplied: "invoice_not_approved" })]);
  });

  it("locks the payment row for the transaction, so two clicks can't both mark it paid", async () => {
    await markPaid();

    expect(orderOf(FIRST_SELECT)).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
  });

  it("rolls the payment back when the ledger write fails", async () => {
    mockSql([LEDGER_FAILS, ...paymentRoutes()]);

    const res = await markPaid();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(/UPDATE Payments\s+SET Status = 'paid'/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("rolls back, with no ledger row, when the status write fails", async () => {
    mockSql([{ match: /UPDATE Payments\s+SET Status = 'paid'/, reject: new Error("deadlock") }, ...paymentRoutes()]);

    const res = await markPaid();

    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });

  it("an already paid payment is not decided again: no row, nothing changed", async () => {
    mockSql(paymentRoutes({ Status: "paid" }));

    const res = await markPaid();

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(orderOf(/UPDATE Payments/)).toBe(-1);
  });

  it("404s an unknown payment, writing nothing", async () => {
    mockSql([APP_USER, JOB_BUILDING]);

    const res = await markPaid();

    expect(res.status).toBe(404);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("answers 401 before starting when the ledger can't name who is marking it paid", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(CALLER).mockResolvedValueOnce(null);

    const res = await markPaid();

    expect(res.status).toBe(401);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  describe("when the role gate says no", () => {
    const gate = { jsonBody: { details: "Required role: accounts_manager. Have: accounts", error: "Forbidden" }, status: 403 };

    beforeEach(() => {
      auth.requireRole.mockResolvedValue(gate);
      auth.rolesForRequest.mockResolvedValue(["accounts"]);
      mockSql([APP_USER, { match: /FROM Payments s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] }]);
    });

    it("still answers with the gate's own 403 and records `denied` against payment.mark_paid", async () => {
      const res = await markPaid();

      expect(res).toBe(gate);
      expect(ledgerInserts(db.executeQuery)).toEqual([
        expect.objectContaining({
          action: "denied",
          actorRole: "accounts",
          before: { attempted: "payment.mark_paid" },
          buildingId: 5,
          jobId: 9,
          reason: "Required role: accounts_manager. Have: accounts",
          ruleApplied: "role_not_permitted",
          subjectId: "11",
          subjectType: "payment",
        }),
      ]);
      expect(orderOf(/UPDATE Payments/)).toBe(-1);
    });
  });
});

// ── Recording a payment ─────────────────────────────────────────────────────

describe("upsertPayment: recording a payment", () => {
  const invoiceRefs: Route = {
    match: /SELECT InvoiceNumber, ContractorName, SupplierInvoiceNumber, Amount, ContractorID FROM JobInvoices/,
    rows: [{ Amount: 1000, ContractorName: "Acme", InvoiceNumber: "IV-9-1", SupplierInvoiceNumber: "INV-0042" }],
  };
  const insertPayment: Route = { match: /INSERT INTO Payments/, rows: [{ PaymentID: 11 }] };
  const storedPayment: Route = { match: /SELECT\s+PaymentID, JobID/, rows: [{ PaymentID: 11 }] };
  const invoiceScope: Route = { match: /FROM JobInvoices s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] };
  const createRoutes = (over: Record<string, unknown> = {}): Route[] => [
    APP_USER,
    JOB_BUILDING,
    invoiceRefs,
    invoiceLock(over),
    insertPayment,
    storedPayment,
  ];
  const valid = { Amount: 100, JobID: 9, JobInvoiceID: 5, Notes: "first instalment", QuoteID: 7 };
  const create = (body: Record<string, unknown> = valid) => upsertPayment(makeRequest(body), ctx);
  const rows = () => ledgerInserts(db.executeQuery);
  const gate = { jsonBody: { details: "Required role: accounts_manager. Have: accounts", error: "Forbidden" }, status: 403 };

  beforeEach(() => mockSql(createRoutes()));

  it("writes one payment.create row naming who, what, where, and who the money is for", async () => {
    const res = await create();

    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      action: "payment.create",
      actorKind: "user",
      actorName: "Casey Controller",
      actorRole: "accounts_manager",
      actorUserId: 21,
      after: {
        amount: 100,
        contractorName: "Acme",
        invoiceNumber: "IV-9-1",
        jobInvoiceId: 5,
        myobBillUid: null,
        purchaseOrderId: null,
        quoteId: 7,
        status: "pending",
        supplierInvoiceNumber: "INV-0042",
      },
      before: null,
      buildingId: 5,
      isException: false,
      jobId: 9,
      subjectId: "11",
      subjectType: "payment",
    });
  });

  it("carries the contractor of the invoice it pays: the id looked up from the invoice's name, and the name", async () => {
    await create();

    expect(rows()[0].after).toMatchObject({ contractorId: 3, contractorName: "Acme" });
    const lookup = db.executeQuery.mock.calls.find((c: unknown[]) => /FROM dbo\.Contractors/.test(String(c[1])));
    expect(lookup?.[2]).toEqual([expect.objectContaining({ name: "Name", value: "Acme" })]);
  });

  it("follows the invoice it pays: the id the invoice recorded wins, and the name isn't looked up", async () => {
    mockSql(createRoutes().map((r) => (r === invoiceRefs ? { ...invoiceRefs, rows: [{ ...invoiceRefs.rows![0], ContractorID: 8 }] } : r)));

    await create();

    expect(rows()[0].after).toMatchObject({ contractorId: 8, contractorName: "Acme" });
    expect(db.executeQuery.mock.calls.some((c: unknown[]) => /FROM dbo\.Contractors/.test(String(c[1])))).toBe(false);
  });

  describe("in Floorplan only (J3)", () => {
    it("never asks MYOB for a bill, and gives the ledger row a correlation id of its own", async () => {
      const res = await create();

      expect(res.status).toBe(200);
      expect(String(rows()[0].correlationId)).toMatch(GUID);
      expect(myob.createMyobBill).not.toHaveBeenCalled();
      expect(res.jsonBody).not.toHaveProperty("myobWarning");
    });

    it("the payment, its history line and its ledger row commit together", async () => {
      await create();

      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      expect(orderOf(/INSERT INTO Payments/)).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
      expect(orderOf(/INSERT INTO JobEvents/)).toBeGreaterThan(orderOf(/INSERT INTO Payments/));
      expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(orderOf(/INSERT INTO JobEvents/));
      expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(committed);
      expect(db.beginTransaction).toHaveBeenCalledTimes(1);
      expect(db.rollbackTransaction).not.toHaveBeenCalled();
    });
  });

  it("is rolled back when the ledger write fails: no payment, no history line", async () => {
    mockSql([LEDGER_FAILS, ...createRoutes()]);

    const res = await create();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(/INSERT INTO Payments/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
  });

  it("writes no ledger row when the payment itself can't be inserted", async () => {
    mockSql([{ match: /INSERT INTO Payments/, reject: new Error("deadlock") }, ...createRoutes()]);

    const res = await create();

    expect(res.status).toBe(500);
    expect(rows()).toHaveLength(0);
    expect(myob.createMyobBill).not.toHaveBeenCalled();
  });

  it("404s an unknown invoice, writing nothing", async () => {
    mockSql([APP_USER, JOB_BUILDING]);

    const res = await create();

    expect(res.status).toBe(404);
    expect(rows()).toHaveLength(0);
    expect(myob.createMyobBill).not.toHaveBeenCalled();
  });

  it("answers 401 before starting when the ledger can't name who is paying", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(CALLER).mockResolvedValueOnce(null);

    const res = await create();

    expect(res.status).toBe(401);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(myob.createMyobBill).not.toHaveBeenCalled();
  });

  it("editing a payment's notes is not a ledgered decision, and doesn't look up who is editing", async () => {
    mockSql([
      { match: /SELECT PaymentID, JobID, JobInvoiceID, Amount, Status, MyobID FROM Payments/, rows: [payment({ MyobID: null })] },
      storedPayment,
    ]);

    const res = await create({ Notes: "typo fixed", PaymentID: 11 });

    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(0);
    expect(orderOf(/FROM dbo\.AppUsers/)).toBe(-1);
  });

  describe("refused attempts", () => {
    beforeEach(() => {
      limitsDb.getCachedApprovalLimits.mockResolvedValue([
        { MaxApprovalAmount: 5000, RoleName: "accounts_manager" },
        { MaxApprovalAmount: null, RoleName: "director" },
      ]);
    });

    it("an invoice that isn't approved: the same 422, recorded against the invoice", async () => {
      mockSql(createRoutes({ Status: "pending" }));

      const res = await create();

      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: string }).error).toMatch(/approved before it can be paid/);
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        action: "denied",
        actorName: "Casey Controller",
        actorRole: "accounts_manager",
        before: { attempted: "payment.create", status: "pending" },
        buildingId: 5,
        isException: true,
        jobId: 9,
        ruleApplied: "invoice_not_approved",
        subjectId: "5",
        subjectType: "invoice",
      });
      expect(orderOf(/INSERT INTO Payments/)).toBe(-1);
      expect(myob.createMyobBill).not.toHaveBeenCalled();
    });

    it("an invoice that needs a director who hasn't approved it: director_approval_required", async () => {
      mockSql(createRoutes({ Amount: 6000 }));

      const res = await create();

      expect(res.status).toBe(422);
      expect(rows()).toEqual([expect.objectContaining({ action: "denied", ruleApplied: "director_approval_required" })]);
    });

    it("more than is left unpaid on the invoice: exceeds_unpaid_balance", async () => {
      mockSql(createRoutes({ PaidSoFar: 950 }));

      const res = await create();

      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: string }).error).toMatch(/more than the \$50\.00 still unpaid/);
      expect(rows()).toEqual([expect.objectContaining({ action: "denied", ruleApplied: "exceeds_unpaid_balance" })]);
    });

    it("records it in a transaction of its own, once the payment's has rolled back", async () => {
      mockSql(createRoutes({ Status: "pending" }));

      await create();

      expect(db.beginTransaction).toHaveBeenCalledTimes(2);
      expect(db.rollbackTransaction.mock.invocationCallOrder[0]).toBeLessThan(db.beginTransaction.mock.invocationCallOrder[1]);
      expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it("bad input (an invoice on another job) is a 422 as before, and is not recorded", async () => {
      mockSql(createRoutes({ JobID: 10 }));

      const res = await create();

      expect(res.status).toBe(422);
      expect(rows()).toHaveLength(0);
      expect(db.commitTransaction).not.toHaveBeenCalled();
    });

    it("answers the same 422 even when the refusal can't be recorded", async () => {
      mockSql([LEDGER_FAILS, ...createRoutes({ Status: "pending" })]);

      const res = await create();

      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: string }).error).toMatch(/approved before it can be paid/);
    });

    describe("when the role gate says no", () => {
      beforeEach(() => {
        auth.requireRole.mockResolvedValue(gate);
        auth.rolesForRequest.mockResolvedValue(["accounts"]);
        mockSql([APP_USER, invoiceScope]);
      });

      it("an attempt to record a payment is recorded against the invoice, and answered with the gate's own 403", async () => {
        const res = await create();

        expect(res).toBe(gate);
        expect(rows()).toEqual([
          expect.objectContaining({
            action: "denied",
            actorRole: "accounts",
            before: { attempted: "payment.create" },
            buildingId: 5,
            jobId: 9,
            ruleApplied: "role_not_permitted",
            subjectId: "5",
            subjectType: "invoice",
          }),
        ]);
        expect(myob.createMyobBill).not.toHaveBeenCalled();
      });

      it("an attempt to edit one is not a ledgered decision: nothing is recorded", async () => {
        const res = await create({ JobInvoiceID: 5, Notes: "x", PaymentID: 11 });

        expect(res).toBe(gate);
        expect(db.createRequestConnection).not.toHaveBeenCalled();
        expect(rows()).toHaveLength(0);
      });
    });
  });
});

// ── Changing a payment's amount ─────────────────────────────────────────────

describe("upsertPayment: changing the amount of a payment", () => {
  const invoiceLock = (over: Record<string, unknown> = {}): Route => ({
    match: /FROM JobInvoices i WITH \(UPDLOCK, HOLDLOCK\)/,
    rows: [{ Amount: 1000, DirectorApprovedAt: null, Direction: "incoming", JobID: 9, PaidSoFar: 0, Status: "approved", ...over }],
  });
  const invoiceRefs: Route = {
    match: /SELECT InvoiceNumber, ContractorName, SupplierInvoiceNumber, Amount, ContractorID FROM JobInvoices/,
    rows: [{ Amount: 1000, ContractorName: "Acme", InvoiceNumber: "IV-9-1", SupplierInvoiceNumber: "INV-0042" }],
  };
  const existing = (over: Record<string, unknown> = {}): Route => ({
    match: /SELECT PaymentID, JobID, JobInvoiceID, Amount, Status, MyobID FROM Payments/,
    rows: [payment({ MyobID: null, ...over })],
  });
  const storedPayment: Route = { match: /SELECT\s+PaymentID, JobID/, rows: [{ PaymentID: 11 }] };
  const paymentScope: Route = { match: /FROM Payments s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] };
  const routes = (over: Record<string, unknown> = {}, invoiceOver: Record<string, unknown> = {}): Route[] => [
    APP_USER,
    JOB_BUILDING,
    invoiceRefs,
    invoiceLock(invoiceOver),
    existing(over),
    storedPayment,
  ];
  const edit = (body: Record<string, unknown> = {}) => upsertPayment(makeRequest({ Amount: 150, PaymentID: 11, ...body }), ctx);
  const rows = () => ledgerInserts(db.executeQuery);
  const UPDATE = /UPDATE Payments SET/;

  beforeEach(() => mockSql(routes()));

  it("writes one payment.amount_change exception: the old amount before, the new amount after, and who it is for", async () => {
    const res = await edit();

    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      action: "payment.amount_change",
      actorKind: "user",
      actorName: "Casey Controller",
      actorRole: "accounts_manager",
      actorUserId: 21,
      buildingId: 5,
      isException: true,
      jobId: 9,
      subjectId: "11",
      subjectType: "payment",
    });
    expect(rows()[0].before).toEqual({
      amount: 100,
      contractorId: 3,
      contractorName: "Acme",
      jobInvoiceId: 5,
      myobBillUid: null,
      status: "pending",
    });
    expect(rows()[0].after).toEqual({
      amount: 150,
      contractorId: 3,
      contractorName: "Acme",
      delta: 50,
      deltaPercent: 50,
      invoiceNumber: "IV-9-1",
      jobInvoiceId: 5,
      newAmount: 150,
      originalApprovedAmount: 1000,
      previousAmount: 100,
      status: "pending",
      supplierInvoiceNumber: "INV-0042",
    });
  });

  it("says how far a cut moved the amount, below zero, measured against what the invoice was approved for", async () => {
    await edit({ Amount: 40 });

    expect(rows()[0].after).toMatchObject({
      amount: 40,
      delta: -60,
      deltaPercent: -60,
      newAmount: 40,
      originalApprovedAmount: 1000,
      previousAmount: 100,
    });
  });

  it("writes no row when the amount is sent back unchanged", async () => {
    const res = await edit({ Amount: 100 });

    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(0);
  });

  it("compares amounts in cents: a difference below a cent is not a change", async () => {
    const res = await edit({ Amount: 100.004 });

    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(0);
  });

  it("changes the amount and writes the ledger row inside one transaction that commits", async () => {
    await edit();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    expect(orderOf(FIRST_SELECT)).toBeGreaterThan(begun);
    expect(orderOf(UPDATE)).toBeGreaterThan(orderOf(FIRST_SELECT));
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(orderOf(UPDATE));
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(committed);
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("reads the payment under lock, so the amount recorded as replaced is the one replaced", async () => {
    await edit();

    const read = db.executeQuery.mock.calls.find((c: unknown[]) => /SELECT PaymentID, JobID, JobInvoiceID, Amount, Status, MyobID FROM Payments/.test(String(c[1])));
    expect(String(read?.[1])).toMatch(/FROM Payments WITH \(UPDLOCK, HOLDLOCK\) WHERE PaymentID = @Id/);
  });

  it("finds who is editing before anything is read or written", async () => {
    await edit();

    expect(orderOf(/FROM dbo\.AppUsers WHERE EntraOid/)).toBeLessThan(db.beginTransaction.mock.invocationCallOrder[0]);
  });

  it("is rolled back when the ledger write fails: the amount is not changed without its record", async () => {
    mockSql([LEDGER_FAILS, ...routes()]);

    const res = await edit();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(UPDATE)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("answers 401 and starts nothing when the ledger can't name who is editing", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(CALLER).mockResolvedValueOnce(null);

    const res = await edit();

    expect(res.status).toBe(401);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(orderOf(UPDATE)).toBe(-1);
  });

  it("404s an unknown payment inside the transaction, writing nothing", async () => {
    mockSql([APP_USER, JOB_BUILDING]);

    const res = await edit();

    expect(res.status).toBe(404);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  describe("refused attempts", () => {
    beforeEach(() => {
      limitsDb.getCachedApprovalLimits.mockResolvedValue([
        { MaxApprovalAmount: 5000, RoleName: "accounts_manager" },
        { MaxApprovalAmount: null, RoleName: "director" },
      ]);
    });

    it("a payment already sent to MYOB: the same 422, recorded with the MYOB bill it was refused over", async () => {
      mockSql(routes({ MyobID: "bill-uid" }));

      const res = await edit();

      expect(res).toEqual({
        jsonBody: { error: "This payment has already been sent to MYOB or paid, so its job, invoice and amount can't be changed." },
        status: 422,
      });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        action: "denied",
        actorName: "Casey Controller",
        actorRole: "accounts_manager",
        before: {
          amount: 100,
          attempted: "payment.amount_change",
          jobInvoiceId: 5,
          myobBillUid: "bill-uid",
          requestedAmount: 150,
          status: "pending",
        },
        buildingId: 5,
        isException: true,
        jobId: 9,
        ruleApplied: "payment_locked",
        subjectId: "11",
        subjectType: "payment",
      });
      expect(orderOf(UPDATE)).toBe(-1);
    });

    it("a payment already paid: the same 422, recorded", async () => {
      mockSql(routes({ Status: "paid" }));

      const res = await edit();

      expect(res.status).toBe(422);
      expect(rows()).toEqual([
        expect.objectContaining({
          action: "denied",
          before: expect.objectContaining({ attempted: "payment.amount_change", status: "paid" }),
          ruleApplied: "payment_locked",
        }),
      ]);
      expect(orderOf(UPDATE)).toBe(-1);
    });

    it("more than is left unpaid on the invoice: exceeds_unpaid_balance, recorded against the payment", async () => {
      mockSql(routes({}, { PaidSoFar: 950 }));

      const res = await edit();

      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: string }).error).toMatch(/more than the \$50\.00 still unpaid/);
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        action: "denied",
        before: { amount: 100, attempted: "payment.amount_change", invoiceStatus: "approved", requestedAmount: 150, status: "pending" },
        isException: true,
        ruleApplied: "exceeds_unpaid_balance",
        subjectId: "11",
        subjectType: "payment",
      });
      expect(orderOf(UPDATE)).toBe(-1);
    });

    it("an invoice that needs a director who hasn't approved it: director_approval_required", async () => {
      mockSql(routes({}, { Amount: 6000 }));

      const res = await edit();

      expect(res.status).toBe(422);
      expect(rows()).toEqual([expect.objectContaining({ action: "denied", ruleApplied: "director_approval_required" })]);
    });

    it("an invoice that is no longer approved: invoice_not_approved", async () => {
      mockSql(routes({}, { Status: "pending" }));

      const res = await edit();

      expect(res.status).toBe(422);
      expect(rows()).toEqual([expect.objectContaining({ action: "denied", ruleApplied: "invoice_not_approved" })]);
    });

    it("records it in a transaction of its own, once the edit's has rolled back", async () => {
      mockSql(routes({ Status: "paid" }));

      await edit();

      expect(db.beginTransaction).toHaveBeenCalledTimes(2);
      expect(db.rollbackTransaction.mock.invocationCallOrder[0]).toBeLessThan(db.beginTransaction.mock.invocationCallOrder[1]);
      expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it("an invoice that has gone is a 422 as before, and is not recorded: that is bad data, not a control", async () => {
      mockSql([APP_USER, JOB_BUILDING, invoiceRefs, existing(), storedPayment]);

      const res = await edit();

      expect(res).toEqual({
        jsonBody: { error: "The invoice this payment was recorded against no longer exists." },
        status: 422,
      });
      expect(rows()).toHaveLength(0);
      expect(db.commitTransaction).not.toHaveBeenCalled();
    });

    it("moving a paid payment to another invoice without touching the amount is the same 422, and is not recorded", async () => {
      mockSql(routes({ Status: "paid" }));

      const res = await edit({ Amount: undefined, JobInvoiceID: 6, Notes: "moved" });

      expect(res.status).toBe(422);
      expect(rows()).toHaveLength(0);
    });

    it("answers the same 422 even when the refusal can't be recorded", async () => {
      mockSql([LEDGER_FAILS, ...routes({ Status: "paid" })]);

      const res = await edit();

      expect(res.status).toBe(422);
      expect((res.jsonBody as { error: string }).error).toMatch(/already been sent to MYOB or paid/);
    });

    describe("when the role gate says no", () => {
      const gate = { jsonBody: { details: "Required role: accounts_manager. Have: accounts", error: "Forbidden" }, status: 403 };

      beforeEach(() => {
        auth.requireRole.mockResolvedValue(gate);
        auth.rolesForRequest.mockResolvedValue(["accounts"]);
        mockSql([APP_USER, paymentScope]);
      });

      it("an attempt to change an amount is recorded against the payment, and answered with the gate's own 403", async () => {
        const res = await edit();

        expect(res).toBe(gate);
        expect(rows()).toEqual([
          expect.objectContaining({
            action: "denied",
            actorRole: "accounts",
            before: { attempted: "payment.amount_change" },
            buildingId: 5,
            isException: true,
            jobId: 9,
            ruleApplied: "role_not_permitted",
            subjectId: "11",
            subjectType: "payment",
          }),
        ]);
        expect(orderOf(UPDATE)).toBe(-1);
      });

      it("an attempt to record a new payment is still recorded against its invoice, not a payment", async () => {
        mockSql([APP_USER, { match: /FROM JobInvoices s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] }]);

        const res = await upsertPayment(makeRequest({ Amount: 100, JobID: 9, JobInvoiceID: 5 }), ctx);

        expect(res).toBe(gate);
        expect(rows()).toEqual([
          expect.objectContaining({ before: { attempted: "payment.create" }, subjectId: "5", subjectType: "invoice" }),
        ]);
      });
    });
  });
});

it("wrote every payment money code in this file, each checked against the shape trend reports read", () => {
  moneyShape.expectEveryCodeWritten("payment.");
});
