/// <reference types="jest" />
// Marking a payment paid writes one decision-ledger row in the decision's own
// transaction, and the same correlation id goes to the MYOB call it makes
// (WP19b, PLAN §3.12, D17). The DB layer is mocked and the real ledger runs.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";

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
const { MyobWritesDisabledError } = require("../myob-api-log") as { MyobWritesDisabledError: new () => Error };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
require("./payments");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const registered = (name: string): Handler => (app.http.mock.calls.find((c: unknown[]) => c[0] === name)?.[1] as { handler: Handler }).handler;
const markPaymentPaid = registered("markPaymentPaid");
const upsertPayment = registered("upsertPayment");

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
const paymentRoutes = (over: Record<string, unknown> = {}): Route[] => [
  APP_USER,
  JOB_BUILDING,
  {
    match: /SELECT InvoiceNumber, ContractorName, SupplierInvoiceNumber FROM JobInvoices/,
    rows: [{ ContractorName: "Acme", InvoiceNumber: "IV-9-1", SupplierInvoiceNumber: "INV-0042" }],
  },
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

afterEach(() => jest.restoreAllMocks());

describe("markPaymentPaid", () => {
  it("writes one payment.myob_applied row naming who, what, where and from what", async () => {
    const res = await markPaid();

    expect(res.status).toBe(200);
    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "payment.myob_applied",
      actorKind: "user",
      actorName: "Casey Controller",
      actorRole: "accounts_manager",
      actorUserId: 21,
      after: {
        amount: 100,
        contractorName: "Acme",
        invoiceNumber: "IV-9-1",
        jobInvoiceId: 5,
        myobBillUid: "bill-uid",
        purchaseOrderId: null,
        quoteId: 7,
        status: "paid",
        supplierInvoiceNumber: "INV-0042",
      },
      before: { status: "pending" },
      buildingId: 5,
      isException: false,
      jobId: 9,
      reason: null,
      subjectId: "11",
      subjectType: "payment",
    });
  });

  describe("MYOB correlation", () => {
    it("gives the ledger row and the MYOB call the same correlation id", async () => {
      await markPaid();

      const [row] = ledgerInserts(db.executeQuery);
      expect(myob.applyMyobPayment).toHaveBeenCalledTimes(1);
      const sent = myob.applyMyobPayment.mock.calls[0][0] as { correlationId: string };
      expect(String(row.correlationId)).toMatch(GUID);
      expect(sent.correlationId).toBe(row.correlationId);
    });

    it("uses a fresh id for each decision", async () => {
      await markPaid();
      await markPaid();

      const [first, second] = ledgerInserts(db.executeQuery);
      expect(first.correlationId).not.toBe(second.correlationId);
      expect((myob.applyMyobPayment.mock.calls[1][0] as { correlationId: string }).correlationId).toBe(second.correlationId);
    });

    it("sends MYOB exactly what it always did, plus the id", async () => {
      await markPaid();

      expect(myob.applyMyobPayment).toHaveBeenCalledWith({
        actor: { kind: "user", name: "Casey Controller", oid: "controller-oid", role: "accounts_manager" },
        amount: 100,
        billUid: "bill-uid",
        correlationId: expect.stringMatching(GUID),
        sqlToken: "mock-token",
      });
    });

    it("tells MYOB only after the status and its ledger row have committed", async () => {
      await markPaid();

      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      expect(orderOf(/UPDATE Payments\s+SET Status = 'paid'/)).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
      expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(orderOf(/UPDATE Payments\s+SET Status = 'paid'/));
      expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(committed);
      expect(committed).toBeLessThan(myob.applyMyobPayment.mock.invocationCallOrder[0]);
      expect(db.rollbackTransaction).not.toHaveBeenCalled();
    });

    it("still records the payment, and says so, when MYOB writes are switched off", async () => {
      myob.applyMyobPayment.mockRejectedValue(new MyobWritesDisabledError());

      const res = await markPaid();

      expect(res.status).toBe(200);
      expect((res.jsonBody as { myobWarning: string }).myobWarning).toMatch(/MYOB sync is switched off/);
      expect(ledgerInserts(db.executeQuery)).toHaveLength(1);
      expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it("a failing MYOB call is still not fatal: the payment stays paid and ledgered", async () => {
      myob.applyMyobPayment.mockRejectedValue(new Error("MYOB API 500"));

      const res = await markPaid();

      expect(res.status).toBe(200);
      expect((res.jsonBody as { myobWarning?: string }).myobWarning).toBeUndefined();
      expect(ledgerInserts(db.executeQuery)).toHaveLength(1);
    });

    it("a payment with no MYOB bill is ledgered without one and calls nothing", async () => {
      mockSql(paymentRoutes({ MyobID: null }));

      const res = await markPaid();

      expect(res.status).toBe(200);
      expect(myob.applyMyobPayment).not.toHaveBeenCalled();
      expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ after: { myobBillUid: null, status: "paid" } });
    });
  });

  it("a payment recorded before invoices were linked is ledgered with no contractor, and asks nothing about an invoice", async () => {
    mockSql(paymentRoutes({ JobInvoiceID: null }));

    const res = await markPaid();

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)[0].after).toMatchObject({
      contractorName: null,
      jobInvoiceId: null,
      supplierInvoiceNumber: null,
    });
    expect(orderOf(/FROM JobInvoices/)).toBe(-1);
  });

  it("locks the payment row for the transaction, so two clicks can't both apply it in MYOB", async () => {
    await markPaid();

    expect(orderOf(FIRST_SELECT)).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
  });

  it("rolls the payment back when the ledger write fails, and never tells MYOB", async () => {
    mockSql([LEDGER_FAILS, ...paymentRoutes()]);

    const res = await markPaid();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(/UPDATE Payments\s+SET Status = 'paid'/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    expect(myob.applyMyobPayment).not.toHaveBeenCalled();
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("rolls back, with no ledger row and no MYOB call, when the status write fails", async () => {
    mockSql([{ match: /UPDATE Payments\s+SET Status = 'paid'/, reject: new Error("deadlock") }, ...paymentRoutes()]);

    const res = await markPaid();

    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(myob.applyMyobPayment).not.toHaveBeenCalled();
  });

  it("an already paid payment is not decided again: no row, no MYOB call, nothing changed", async () => {
    mockSql(paymentRoutes({ Status: "paid" }));

    const res = await markPaid();

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(myob.applyMyobPayment).not.toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(orderOf(/UPDATE Payments/)).toBe(-1);
  });

  it("404s an unknown payment, writing nothing", async () => {
    mockSql([APP_USER, JOB_BUILDING]);

    const res = await markPaid();

    expect(res.status).toBe(404);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(myob.applyMyobPayment).not.toHaveBeenCalled();
  });

  it("answers 401 before any MYOB call when the ledger can't name who is marking it paid", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(CALLER).mockResolvedValueOnce(null);

    const res = await markPaid();

    expect(res.status).toBe(401);
    expect(myob.applyMyobPayment).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  describe("when the role gate says no", () => {
    const gate = { jsonBody: { details: "Required role: accounts_manager. Have: accounts", error: "Forbidden" }, status: 403 };

    beforeEach(() => {
      auth.requireRole.mockResolvedValue(gate);
      auth.rolesForRequest.mockResolvedValue(["accounts"]);
      mockSql([APP_USER, { match: /FROM Payments s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] }]);
    });

    it("still answers with the gate's own 403, records `denied`, and calls nothing in MYOB", async () => {
      const res = await markPaid();

      expect(res).toBe(gate);
      expect(ledgerInserts(db.executeQuery)).toEqual([
        expect.objectContaining({
          action: "denied",
          actorRole: "accounts",
          before: { attempted: "payment.myob_applied" },
          buildingId: 5,
          jobId: 9,
          reason: "Required role: accounts_manager. Have: accounts",
          ruleApplied: "role_not_permitted",
          subjectId: "11",
          subjectType: "payment",
        }),
      ]);
      expect(myob.applyMyobPayment).not.toHaveBeenCalled();
      expect(orderOf(/UPDATE Payments/)).toBe(-1);
    });
  });
});

// ── Recording a payment ─────────────────────────────────────────────────────

describe("upsertPayment: recording a payment", () => {
  const invoiceLock = (over: Record<string, unknown> = {}): Route => ({
    match: /FROM JobInvoices i WITH \(UPDLOCK, HOLDLOCK\)/,
    rows: [{ Amount: 1000, DirectorApprovedAt: null, Direction: "incoming", JobID: 9, PaidSoFar: 0, Status: "approved", ...over }],
  });
  const invoiceRefs: Route = {
    match: /SELECT InvoiceNumber, ContractorName, SupplierInvoiceNumber FROM JobInvoices/,
    rows: [{ ContractorName: "Acme", InvoiceNumber: "IV-9-1", SupplierInvoiceNumber: "INV-0042" }],
  };
  const insertPayment: Route = { match: /INSERT INTO Payments/, rows: [{ PaymentID: 11 }] };
  const storedPayment: Route = { match: /SELECT\s+PaymentID, JobID/, rows: [{ PaymentID: 11 }] };
  const jobTitle: Route = { match: /SELECT Title FROM Jobs/, rows: [{ Title: "Roof repair" }] };
  const quoteContractor: Route = { match: /SELECT ContractorName FROM Quotes/, rows: [{ ContractorName: "Acme" }] };
  const invoiceScope: Route = { match: /FROM JobInvoices s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] };
  const createRoutes = (over: Record<string, unknown> = {}): Route[] => [
    APP_USER,
    JOB_BUILDING,
    invoiceRefs,
    invoiceLock(over),
    insertPayment,
    storedPayment,
    jobTitle,
    quoteContractor,
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

  describe("MYOB correlation", () => {
    it("gives the ledger row and the MYOB bill the same correlation id", async () => {
      await create();

      const [row] = rows();
      expect(String(row.correlationId)).toMatch(GUID);
      expect(myob.createMyobBill).toHaveBeenCalledTimes(1);
      expect((myob.createMyobBill.mock.calls[0][0] as { correlationId: string }).correlationId).toBe(row.correlationId);
    });

    it("asks MYOB for exactly what it always did, plus the id", async () => {
      await create();

      expect(myob.createMyobBill).toHaveBeenCalledWith({
        actor: { kind: "user", name: "Casey Controller", oid: "controller-oid", role: "accounts_manager" },
        amount: 100,
        contractorName: "Acme",
        correlationId: expect.stringMatching(GUID),
        jobId: 9,
        jobTitle: "Roof repair",
        notes: "first instalment",
        referenceNumber: "PAY-9-11",
        sqlToken: "mock-token",
      });
    });

    it("keeps its order: the payment and its ledger row commit first, and only then is MYOB asked for the bill", async () => {
      await create();

      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      expect(orderOf(/INSERT INTO Payments/)).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
      expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(orderOf(/INSERT INTO Payments/));
      expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(committed);
      expect(committed).toBeLessThan(myob.createMyobBill.mock.invocationCallOrder[0]);
      expect(db.beginTransaction).toHaveBeenCalledTimes(1);
      expect(db.rollbackTransaction).not.toHaveBeenCalled();
    });

    it("still keeps the payment and its record, and says so, when MYOB writes are switched off", async () => {
      myob.createMyobBill.mockRejectedValue(new MyobWritesDisabledError());

      const res = await create();

      expect(res.status).toBe(200);
      expect((res.jsonBody as { myobWarning: string }).myobWarning).toMatch(/MYOB sync is switched off/);
      expect(rows()).toHaveLength(1);
      expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it("a failing MYOB call is still not fatal: the payment stays recorded and ledgered", async () => {
      myob.createMyobBill.mockRejectedValue(new Error("MYOB createBill 500: boom"));

      const res = await create();

      expect(res.status).toBe(200);
      expect(rows()).toHaveLength(1);
    });
  });

  it("is rolled back when the ledger write fails: no payment, no bill in MYOB", async () => {
    mockSql([LEDGER_FAILS, ...createRoutes()]);

    const res = await create();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(/INSERT INTO Payments/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    expect(myob.createMyobBill).not.toHaveBeenCalled();
  });

  it("writes no ledger row and asks MYOB for nothing when the payment itself can't be inserted", async () => {
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

  it("editing a payment is not a ledgered decision", async () => {
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
