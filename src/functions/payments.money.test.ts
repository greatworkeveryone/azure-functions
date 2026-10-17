/// <reference types="jest" />
// J3 for payments: a payment is recorded and marked paid in Floorplan only;
// MYOB is never called from here (a MYOB bill is its own explicit action
// through lane M's proposals, decision 12). Recording one writes the job's
// history. Marking one paid re-checks the invoice it pays (still approved,
// director approval where needed, the balance covers it) and is ledgered as
// payment.mark_paid. Admin pays on test records only (decision 4).
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
jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn() }));
jest.mock("../myob-client", () => ({ applyMyobPayment: jest.fn(), createMyobBill: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

const auth = require("../auth") as { requireRole: jest.Mock; rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as {
  beginTransaction: jest.Mock;
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
const REGISTERED = new Map<string, Handler>(app.http.mock.calls.map((c: unknown[]) => [c[0] as string, (c[1] as { handler: Handler }).handler]));
const call = (name: string, body: Record<string, unknown>) => {
  const hit = REGISTERED.get(name);
  if (!hit) throw new Error(`handler ${name} not registered`);
  return hit(makeRequest(body), ctx);
};

type Route = { match: RegExp; rows?: Record<string, unknown>[] };
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => routes.find((r) => r.match.test(sql))?.rows ?? []);
}
const sqls = (): string[] => db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1]));
const wrote = (re: RegExp) => sqls().some((sql) => re.test(sql));
const paramsOf = (re: RegExp) => {
  const hit = db.executeQuery.mock.calls.find((c: unknown[]) => re.test(String(c[1])));
  return Object.fromEntries(((hit?.[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value]));
};
function makeRequest(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const CALLER = { email: "casey@example.com", name: "Casey Controller", oid: "casey-oid" };
const APP_USER: Route = { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 21 }] };
const JOB_BUILDING: Route = { match: /SELECT BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5 }] };
const NO_TEST_FLAG: Route = { match: /COL_LENGTH\('dbo\.Jobs', 'IsTest'\)/, rows: [{ Len: null }] };
const INVOICE_SCOPE: Route = { match: /FROM JobInvoices s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] };
const PAYMENT_SCOPE: Route = { match: /FROM Payments s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] };
const invoiceLock = (over: Record<string, unknown> = {}): Route => ({
  match: /FROM JobInvoices i WITH \(UPDLOCK, HOLDLOCK\)/,
  rows: [{ Amount: 1000, DirectorApprovedAt: null, Direction: "incoming", JobID: 9, PaidSoFar: 0, Status: "approved", ...over }],
});
const paymentLock = (over: Record<string, unknown> = {}): Route => ({
  match: /FROM Payments WITH \(UPDLOCK, HOLDLOCK\) WHERE PaymentID = @Id/,
  rows: [{ Amount: 400, JobID: 9, JobInvoiceID: 5, MyobID: null, PaymentID: 11, PurchaseOrderID: null, QuoteID: null, Status: "pending", ...over }],
});
const STORED: Route = { match: /SELECT\s+PaymentID, JobID/, rows: [{ PaymentID: 11 }] };

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  auth.requireRole.mockResolvedValue(null);
  auth.rolesForRequest.mockResolvedValue(["accounts_manager"]);
  auth.verifiedIdentityFromRequest.mockResolvedValue(CALLER);
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  db.createRequestConnection.mockResolvedValue({ id: "connection" });
  limitsDb.getCachedApprovalLimits.mockResolvedValue([{ MaxApprovalAmount: 20000, RoleName: "accounts_manager" }]);
});

afterEach(() => jest.restoreAllMocks());

describe("upsertPayment: recording a payment", () => {
  const record = () => call("upsertPayment", { Amount: 400, JobID: 9, JobInvoiceID: 5 });

  it("records it in Floorplan only, never asking MYOB for a bill, and writes the job's history", async () => {
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, invoiceLock(), { match: /INSERT INTO Payments/, rows: [{ PaymentID: 11 }] }, STORED]);

    const res = await record();

    expect(res.status).toBe(200);
    expect(myob.createMyobBill).not.toHaveBeenCalled();
    expect(res.jsonBody).not.toHaveProperty("myobWarning");
    expect(sqls().find((sql) => /INSERT INTO JobEvents/.test(sql))).toMatch(/'payment_made'/);
    expect(paramsOf(/INSERT INTO JobEvents/)).toMatchObject({ CreatedBy: "Casey Controller", JobID: 9 });
  });

  it("refuses admin on a real record (decision 4), writing nothing", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, invoiceLock(), INVOICE_SCOPE]);

    expect(await record()).toMatchObject({ jsonBody: { code: "admin_test_records_only" }, status: 403 });
    expect(wrote(/INSERT INTO Payments/)).toBe(false);
  });
});

describe("upsertPayment: editing a payment (decision 4)", () => {
  it("refuses admin editing a real record's payment, ledgered", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    mockSql([
      APP_USER,
      JOB_BUILDING,
      NO_TEST_FLAG,
      { match: /SELECT PaymentID, JobID, JobInvoiceID, Amount, Status, MyobID FROM Payments WITH \(UPDLOCK, HOLDLOCK\)/, rows: [{ Amount: 400, JobID: 9, JobInvoiceID: 5, MyobID: null, PaymentID: 11, Status: "pending" }] },
      PAYMENT_SCOPE,
    ]);

    const res = await call("upsertPayment", { Amount: 300, PaymentID: 11 });

    expect(res).toMatchObject({ jsonBody: { code: "admin_test_records_only" }, status: 403 });
    expect(wrote(/UPDATE Payments SET/)).toBe(false);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: expect.objectContaining({ attempted: "payment.amount_change" }), ruleApplied: "admin_test_records_only" }),
    ]);
  });

  it("lets accounts edit the notes on a pending payment", async () => {
    mockSql([
      APP_USER,
      { match: /SELECT PaymentID, JobID, JobInvoiceID, Amount, Status, MyobID FROM Payments WITH \(UPDLOCK, HOLDLOCK\)/, rows: [{ Amount: 400, JobID: 9, JobInvoiceID: 5, MyobID: null, PaymentID: 11, Status: "pending" }] },
      STORED,
    ]);
    expect((await call("upsertPayment", { Notes: "Paid by EFT", PaymentID: 11 })).status).toBe(200);
  });
});

describe("markPaymentPaid", () => {
  const markPaid = () => call("markPaymentPaid", { PaymentID: 11 });

  it("marks it paid in Floorplan only, ledgered as payment.mark_paid, never calling MYOB", async () => {
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, paymentLock({ MyobID: "bill-uid" }), invoiceLock(), STORED]);

    const res = await markPaid();

    expect(res.status).toBe(200);
    expect(myob.applyMyobPayment).not.toHaveBeenCalled();
    expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ action: "payment.mark_paid", subjectId: "11" })]);
  });

  it.each([
    ["no longer approved", { Status: "rejected" }, "invoice_not_approved"],
    ["over the gate with no director approval", { Amount: 30000 }, "director_approval_required"],
    ["already paid off by other payments", { PaidSoFar: 900 }, "exceeds_unpaid_balance"],
  ])("re-checks the invoice: refuses when it is %s", async (_label, over, code) => {
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, paymentLock(), invoiceLock(over), PAYMENT_SCOPE]);

    expect(await markPaid()).toMatchObject({ jsonBody: { code }, status: 422 });
    expect(wrote(/SET Status = 'paid'/)).toBe(false);
    expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ action: "denied", ruleApplied: code })]);
  });

  it("refuses a payment that pays no invoice: nothing to check it against", async () => {
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, paymentLock({ JobInvoiceID: null }), PAYMENT_SCOPE]);
    expect(await markPaid()).toMatchObject({ jsonBody: { code: "no_invoice" }, status: 422 });
    expect(wrote(/SET Status = 'paid'/)).toBe(false);
  });

  it("refuses admin on a real record (decision 4)", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, paymentLock(), invoiceLock(), PAYMENT_SCOPE]);
    expect(await markPaid()).toMatchObject({ jsonBody: { code: "admin_test_records_only" }, status: 403 });
    expect(wrote(/SET Status = 'paid'/)).toBe(false);
  });
});
