/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  buildUpdateSet: jest.requireActual("../db").buildUpdateSet,
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
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
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({
      email: "johanne@randazzo.properties",
      name: "Johanne CFO",
      oid: "cfo-oid",
    }),
  };
});

jest.mock("../myob-client", () => ({
  MYOB_PAYMENT_APPLIED_EVENT: "PaymentPurchase.Created",
  MYOB_WEBHOOK_KEY: "",
  applyMyobPayment: jest.fn().mockResolvedValue(undefined),
  buildMyobBillUrl: jest.fn(),
  createMyobBill: jest.fn().mockResolvedValue({ uid: "bill-uid", url: "https://myob/bill-uid" }),
  validateMyobWebhookSignature: jest.fn(),
}));

const db = require("../db") as { executeQuery: jest.Mock };
const auth = require("../auth") as { verifiedIdentityFromRequest: jest.Mock };
const myob = require("../myob-client") as { applyMyobPayment: jest.Mock; createMyobBill: jest.Mock };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: unknown }>;

// payments.ts registers its handlers without exporting them. Capture them now:
// beforeEach's clearAllMocks wipes app.http's recorded calls.
require("./payments");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const registered = (name: string): Handler => {
  const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!hit) throw new Error(`handler ${name} not registered`);
  return (hit[1] as { handler: Handler }).handler;
};
const upsertPayment = registered("upsertPayment");
const markPaymentPaid = registered("markPaymentPaid");

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

function makeRequest(body: unknown): HttpRequest {
  return {
    headers: { get: () => null },
    json: jest.fn().mockResolvedValue(body),
    query: new URLSearchParams(),
  } as unknown as HttpRequest;
}

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset().mockResolvedValue([]);
});

describe("upsertPayment identity", () => {
  it("create: records the token's name as CreatedBy and PaidBy, ignoring the body", async () => {
    routeSql([
      [/INSERT INTO Payments/, [{ PaymentID: 11 }]],
      [/SELECT\s+PaymentID, JobID/, [{ PaymentID: 11 }]],
    ]);

    const res = await upsertPayment(
      makeRequest({ Amount: 100, CreatedBy: "Someone Else", JobID: 9, PaidBy: "Someone Else" }),
      ctx,
    );

    expect(res.status).toBe(200);
    const insert = callMatching(/INSERT INTO Payments/);
    expect(insert?.params.CreatedBy).toBe("Johanne CFO");
    expect(insert?.params.PaidBy).toBe("Johanne CFO");
    expect(sqlCalls().flatMap((c) => Object.values(c.params))).not.toContain("Someone Else");
  });

  it("update: never writes PaidBy from the body", async () => {
    routeSql([[/SELECT\s+PaymentID, JobID/, [{ PaymentID: 11 }]]]);

    const res = await upsertPayment(makeRequest({ Notes: "n", PaidBy: "Someone Else", PaymentID: 11 }), ctx);

    expect(res.status).toBe(200);
    const update = callMatching(/UPDATE Payments SET/);
    expect(update?.sql).not.toMatch(/PaidBy/);
    expect(sqlCalls().flatMap((c) => Object.values(c.params))).not.toContain("Someone Else");
  });

  it("401s without touching the database when the token has no verified identity", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await upsertPayment(makeRequest({ Amount: 100, JobID: 9 }), ctx);

    expect(res.status).toBe(401);
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(myob.createMyobBill).not.toHaveBeenCalled();
  });
});

describe("markPaymentPaid identity", () => {
  it("records the token's name as PaidBy, ignoring MarkedPaidBy in the body", async () => {
    routeSql([
      [/SELECT\s+PaymentID, JobID/, [{ Amount: 100, MyobID: null, PaymentID: 11, Status: "pending" }]],
    ]);

    const res = await markPaymentPaid(makeRequest({ MarkedPaidBy: "Someone Else", PaymentID: 11 }), ctx);

    expect(res.status).toBe(200);
    expect(callMatching(/SET Status = 'paid'/)?.params.MarkedPaidBy).toBe("Johanne CFO");
    expect(sqlCalls().flatMap((c) => Object.values(c.params))).not.toContain("Someone Else");
  });

  it("401s when the token has no verified identity", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await markPaymentPaid(makeRequest({ PaymentID: 11 }), ctx);

    expect(res.status).toBe(401);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});
