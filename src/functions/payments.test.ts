/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  buildUpdateSet: jest.requireActual("../db").buildUpdateSet,
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../approval-limits-db", () => ({
  getCachedApprovalLimits: jest.fn().mockResolvedValue([
    { MaxApprovalAmount: 5000, RoleName: "accounts_manager" },
    { MaxApprovalAmount: null, RoleName: "director" },
  ]),
}));

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    rolesForRequest: jest.fn().mockResolvedValue(["accounts_manager"]),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({
      email: "johanne@randazzo.properties",
      name: "Johanne CFO",
      oid: "cfo-oid",
    }),
  };
});

jest.mock("../myob-client", () => ({
  applyMyobPayment: jest.fn().mockResolvedValue(undefined),
  createMyobBill: jest.fn().mockResolvedValue({ uid: "bill-uid", url: "https://myob/bill-uid" }),
}));

const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const auth = require("../auth") as { rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const { MyobWritesDisabledError } = require("../myob-api-log") as {
  MyobWritesDisabledError: new () => Error;
};
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
// Taken before beforeEach's clearAllMocks empties app.http's recorded calls.
const registeredNames: string[] = app.http.mock.calls.map((c: unknown[]) => c[0] as string);
const upsertPayment = registered("upsertPayment");
const markPaymentPaid = registered("markPaymentPaid");
interface RefusalInput {
  amount: number;
  invoice: {
    amount: number | null;
    directorApprovedAt: Date | null;
    direction: string;
    jobId: number;
    paidSoFar: number;
    status: string;
  };
  jobId: number;
  limits: { MaxApprovalAmount: number | null; RoleName: string }[];
}
const { paymentInvoiceError, paymentInvoiceRefusal } = require("./payments") as {
  paymentInvoiceError: (input: RefusalInput) => string | null;
  paymentInvoiceRefusal: (input: RefusalInput) => { code: string; message: string } | null;
};

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

// ── Invoice requirement ──────────────────────────────────────────────────────

const LIMITS = [
  { MaxApprovalAmount: 5000, RoleName: "accounts_manager" },
  { MaxApprovalAmount: null, RoleName: "director" },
];
const INVOICE = {
  amount: 1000 as number | null,
  directorApprovedAt: null as Date | null,
  direction: "incoming",
  jobId: 9,
  paidSoFar: 0,
  status: "approved",
};
const check = (over: Partial<typeof INVOICE> = {}, amount = 100, jobId = 9) =>
  paymentInvoiceError({ amount, invoice: { ...INVOICE, ...over }, jobId, limits: LIMITS });

describe("paymentInvoiceError", () => {
  it("accepts a payment within an approved incoming invoice", () => {
    expect(check()).toBeNull();
  });

  it("refuses an invoice from a different job", () => {
    expect(check({ jobId: 10 })).toMatch(/different job/);
  });

  it("refuses an outgoing invoice", () => {
    expect(check({ direction: "outgoing" })).toMatch(/incoming/);
  });

  it.each(["pending", "awaiting_approval", "rejected"])("refuses an invoice that is %s", (status) => {
    expect(check({ status })).toMatch(/approved before it can be paid/);
  });

  it("refuses an invoice with no amount", () => {
    expect(check({ amount: null })).toMatch(/no amount/);
  });

  it("refuses an over-limit invoice that has no director approval", () => {
    expect(check({ amount: 6000 }, 100)).toMatch(/director approval/);
  });

  it("accepts an over-limit invoice once the director has approved it", () => {
    expect(
      check({ amount: 6000, directorApprovedAt: new Date(), status: "director_approved" }, 6000),
    ).toBeNull();
  });

  it("does not demand director approval at exactly the limit", () => {
    expect(check({ amount: 5000 }, 5000)).toBeNull();
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])("refuses an amount of %s", (amount) => {
    expect(check({}, amount)).toMatch(/greater than zero/);
  });

  it("allows paying exactly what is left and refuses a cent more", () => {
    expect(check({ paidSoFar: 400 }, 600)).toBeNull();
    expect(check({ paidSoFar: 400 }, 600.01)).toMatch(/more than the \$600\.00 still unpaid/);
  });

  it("compares in cents, so float noise in earlier payments doesn't block the last one", () => {
    expect(check({ amount: 0.3, paidSoFar: 0.1 + 0.2 - 0.2 }, 0.2)).toBeNull();
  });

  it("refuses anything once the invoice is fully paid", () => {
    expect(check({ paidSoFar: 1000 }, 0.01)).toMatch(/more than the \$0\.00 still unpaid/);
  });
});

describe("paymentInvoiceRefusal", () => {
  const refusal = (over: Partial<typeof INVOICE> = {}, amount = 100) =>
    paymentInvoiceRefusal({ amount, invoice: { ...INVOICE, ...over }, jobId: 9, limits: LIMITS });

  it("gives each refusal a short code, and the same words as paymentInvoiceError", () => {
    expect(refusal()).toBeNull();
    expect(refusal({ jobId: 10 })).toMatchObject({ code: "different_job" });
    expect(refusal({ direction: "outgoing" })).toMatchObject({ code: "not_incoming" });
    expect(refusal({ status: "pending" })).toMatchObject({ code: "invoice_not_approved" });
    expect(refusal({ amount: null })).toMatchObject({ code: "no_invoice_amount" });
    expect(refusal({ amount: 6000 })).toMatchObject({ code: "director_approval_required" });
    expect(refusal({}, 0)).toMatchObject({ code: "invalid_amount" });
    expect(refusal({ paidSoFar: 950 }, 100)).toMatchObject({ code: "exceeds_unpaid_balance" });
    for (const over of [{ jobId: 10 }, { status: "pending" }, { amount: 6000 }, { paidSoFar: 950 }]) {
      expect(check(over)).toBe(refusal(over)?.message);
    }
  });
});

describe("upsertPayment create", () => {
  const invoiceRoute = (over: Record<string, unknown> = {}): SqlRoute => [
    /FROM JobInvoices i WITH \(UPDLOCK, HOLDLOCK\)/,
    [{ Amount: 1000, DirectorApprovedAt: null, Direction: "incoming", JobID: 9, PaidSoFar: 0, Status: "approved", ...over }],
  ];
  const insertRoute: SqlRoute = [/INSERT INTO Payments/, [{ PaymentID: 11 }]];
  const storedRoute: SqlRoute = [/SELECT\s+PaymentID, JobID/, [{ PaymentID: 11 }]];
  const valid = { Amount: 100, JobID: 9, JobInvoiceID: 5 };

  it("records the token's name as CreatedBy and PaidBy, ignoring the body", async () => {
    routeSql([invoiceRoute(), insertRoute, storedRoute]);

    const res = await upsertPayment(makeRequest({ ...valid, CreatedBy: "Someone Else", PaidBy: "Someone Else" }), ctx);

    expect(res.status).toBe(200);
    const insert = callMatching(/INSERT INTO Payments/);
    expect(insert?.params.CreatedBy).toBe("Johanne CFO");
    expect(insert?.params.PaidBy).toBe("Johanne CFO");
    expect(sqlCalls().flatMap((c) => Object.values(c.params))).not.toContain("Someone Else");
  });

  it("stores the invoice link and writes the amount at cent precision", async () => {
    routeSql([invoiceRoute(), insertRoute, storedRoute]);

    await upsertPayment(makeRequest({ ...valid, Amount: 100.55 }), ctx);

    const args = db.executeQuery.mock.calls.find((c: unknown[]) => /INSERT INTO Payments/.test(String(c[1])))?.[2] as {
      name: string;
      options?: { precision: number; scale: number };
      value: unknown;
    }[];
    expect(args.find((a) => a.name === "JobInvoiceID")?.value).toBe(5);
    expect(args.find((a) => a.name === "Amount")?.value).toBe(100.55);
    expect(args.find((a) => a.name === "Amount")?.options).toEqual({ precision: 18, scale: 2 });
  });

  it("locks the invoice row, checks and inserts in one transaction, then calls MYOB after commit", async () => {
    routeSql([invoiceRoute(), insertRoute, storedRoute]);

    await upsertPayment(makeRequest(valid), ctx);

    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
    expect(db.commitTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      myob.createMyobBill.mock.invocationCallOrder[0],
    );
  });

  it.each([
    ["no JobInvoiceID", { Amount: 100, JobID: 9 }, 400],
    ["a string JobInvoiceID", { Amount: 100, JobID: 9, JobInvoiceID: "5" }, 400],
    ["no JobID", { Amount: 100, JobInvoiceID: 5 }, 400],
    ["no Amount", { JobID: 9, JobInvoiceID: 5 }, 400],
    ["a zero Amount", { Amount: 0, JobID: 9, JobInvoiceID: 5 }, 422],
  ])("rejects a create with %s before touching the database", async (_label, body, status) => {
    const res = await upsertPayment(makeRequest(body), ctx);

    expect(res.status).toBe(status);
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(myob.createMyobBill).not.toHaveBeenCalled();
  });

  it("404s and rolls back when the invoice does not exist", async () => {
    routeSql([]);

    const res = await upsertPayment(makeRequest(valid), ctx);

    expect(res.status).toBe(404);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(callMatching(/INSERT INTO Payments/)).toBeUndefined();
  });

  // The refusals that are controls on paying money are also ledgered as refused
  // attempts (WP19b), in a transaction of their own; bad input is not.
  it.each([
    ["belongs to another job", { JobID: 10 }, /different job/, null],
    ["is outgoing", { Direction: "outgoing" }, /incoming/, null],
    ["is still pending", { Status: "pending" }, /approved before/, "invoice_not_approved"],
    ["needs director approval it hasn't got", { Amount: 6000 }, /director approval/, "director_approval_required"],
    ["has too little left", { PaidSoFar: 950 }, /more than the \$50\.00 still unpaid/, "exceeds_unpaid_balance"],
  ])("422s, rolls back and writes nothing when the invoice %s", async (_label, over, message, recordedAs) => {
    routeSql([invoiceRoute(over)]);

    const res = await upsertPayment(makeRequest(valid), ctx);

    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: string }).error).toMatch(message);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(callMatching(/INSERT INTO Payments/)).toBeUndefined();
    expect(myob.createMyobBill).not.toHaveBeenCalled();
    const refused = sqlCalls().filter((c) => /INSERT INTO dbo\.DecisionLedger/.test(c.sql));
    if (recordedAs === null) {
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(refused).toHaveLength(0);
    } else {
      expect(db.commitTransaction).toHaveBeenCalledTimes(1);
      expect(refused).toHaveLength(1);
      expect(refused[0].params).toMatchObject({ Action: "denied", RuleApplied: recordedAs });
    }
  });

  it("401s without touching the database when the token has no verified identity", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await upsertPayment(makeRequest(valid), ctx);

    expect(res.status).toBe(401);
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(myob.createMyobBill).not.toHaveBeenCalled();
  });
});

describe("upsertPayment update", () => {
  const paymentRow = (over: Record<string, unknown> = {}): SqlRoute => [
    /SELECT PaymentID, JobID, JobInvoiceID, Amount, Status, MyobID FROM Payments/,
    [{ Amount: 100, JobID: 9, JobInvoiceID: 5, MyobID: null, PaymentID: 11, Status: "pending", ...over }],
  ];
  const invoiceRoute = (over: Record<string, unknown> = {}): SqlRoute => [
    /FROM JobInvoices i WITH \(UPDLOCK, HOLDLOCK\)/,
    [{ Amount: 1000, DirectorApprovedAt: null, Direction: "incoming", JobID: 9, PaidSoFar: 0, Status: "approved", ...over }],
  ];
  const storedRoute: SqlRoute = [/SELECT\s+PaymentID, JobID/, [{ PaymentID: 11 }]];

  it("never writes PaidBy from the body", async () => {
    routeSql([paymentRow(), storedRoute]);

    const res = await upsertPayment(makeRequest({ Notes: "n", PaidBy: "Someone Else", PaymentID: 11 }), ctx);

    expect(res.status).toBe(200);
    expect(callMatching(/UPDATE Payments SET/)?.sql).not.toMatch(/PaidBy/);
    expect(sqlCalls().flatMap((c) => Object.values(c.params))).not.toContain("Someone Else");
  });

  it.each([
    ["it has a MYOB bill", { MyobID: "bill-uid" }],
    ["it is paid", { Status: "paid" }],
  ])("422s a changed Amount when %s", async (_label, over) => {
    routeSql([paymentRow(over), storedRoute]);

    const res = await upsertPayment(makeRequest({ Amount: 150, PaymentID: 11 }), ctx);

    expect(res.status).toBe(422);
    expect(callMatching(/UPDATE Payments SET/)).toBeUndefined();
  });

  it("422s a different JobID or JobInvoiceID once the payment has a MYOB bill", async () => {
    routeSql([paymentRow({ MyobID: "bill-uid" }), storedRoute]);

    const job = await upsertPayment(makeRequest({ JobID: 10, Notes: "n", PaymentID: 11 }), ctx);
    const invoice = await upsertPayment(makeRequest({ JobInvoiceID: 6, Notes: "n", PaymentID: 11 }), ctx);

    expect(job.status).toBe(422);
    expect(invoice.status).toBe(422);
    expect(callMatching(/UPDATE Payments SET/)).toBeUndefined();
  });

  it("still lets Notes change on a locked payment, and tolerates the unchanged fields being resent", async () => {
    routeSql([paymentRow({ MyobID: "bill-uid", Status: "paid" }), storedRoute]);

    const res = await upsertPayment(
      makeRequest({ Amount: 100, JobID: 9, JobInvoiceID: 5, Notes: "fixed typo", PaymentID: 11 }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(callMatching(/UPDATE Payments SET/)?.params.Notes).toBe("fixed typo");
  });

  it("re-checks the invoice cap when a pending payment's amount goes up, excluding the payment itself", async () => {
    routeSql([paymentRow(), invoiceRoute({ PaidSoFar: 900 }), storedRoute]);

    const res = await upsertPayment(makeRequest({ Amount: 150, PaymentID: 11 }), ctx);

    expect(res.status).toBe(422);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(callMatching(/FROM JobInvoices i WITH/)?.params.ExcludePaymentID).toBe(11);
    expect(callMatching(/UPDATE Payments SET/)).toBeUndefined();
  });

  it("applies a pending payment's amount change that fits, at cent precision, in a transaction", async () => {
    routeSql([paymentRow(), invoiceRoute({ PaidSoFar: 100 }), storedRoute]);

    const res = await upsertPayment(makeRequest({ Amount: 150.5, PaymentID: 11 }), ctx);

    expect(res.status).toBe(200);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    const args = db.executeQuery.mock.calls.find((c: unknown[]) => /UPDATE Payments SET/.test(String(c[1])))?.[2] as {
      name: string;
      options?: unknown;
    }[];
    expect(args.find((a) => a.name === "Amount")?.options).toEqual({ precision: 18, scale: 2 });
  });

  it("404s an unknown payment", async () => {
    routeSql([]);

    const res = await upsertPayment(makeRequest({ Notes: "n", PaymentID: 99 }), ctx);

    expect(res.status).toBe(404);
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

// ── MYOB calls ───────────────────────────────────────────────────────────────

describe("payments MYOB calls", () => {
  const ACTOR = { kind: "user", name: "Johanne CFO", oid: "cfo-oid", role: "accounts_manager" };
  const createRoutes = (): SqlRoute[] => [
    [
      /FROM JobInvoices i WITH \(UPDLOCK, HOLDLOCK\)/,
      [{ Amount: 1000, DirectorApprovedAt: null, Direction: "incoming", JobID: 9, PaidSoFar: 0, Status: "approved" }],
    ],
    [/INSERT INTO Payments/, [{ PaymentID: 11 }]],
    [/SELECT\s+PaymentID, JobID/, [{ PaymentID: 11 }]],
  ];
  const valid = { Amount: 100, JobID: 9, JobInvoiceID: 5 };
  const unpaid: SqlRoute = [
    /SELECT\s+PaymentID, JobID/,
    [{ Amount: 100, MyobID: "bill-uid", PaymentID: 11, Status: "pending" }],
  ];

  it("registers no myobWebhook endpoint: MYOB has no webhooks to call it", () => {
    expect(registeredNames).toEqual(expect.arrayContaining(["getPayments", "upsertPayment", "markPaymentPaid"]));
    expect(registeredNames).not.toContain("myobWebhook");
  });

  it("create: asks MYOB for the bill as the signed-in user, with their role", async () => {
    routeSql(createRoutes());

    const res = await upsertPayment(makeRequest(valid), ctx);

    expect(res.status).toBe(200);
    expect(myob.createMyobBill).toHaveBeenCalledWith(expect.objectContaining({ actor: ACTOR, sqlToken: "mock-token" }));
    expect((res.jsonBody as { myobWarning?: string }).myobWarning).toBeUndefined();
  });

  it("create: when MYOB writes are off, keeps the committed payment and says so", async () => {
    routeSql(createRoutes());
    myob.createMyobBill.mockRejectedValueOnce(new MyobWritesDisabledError());

    const res = await upsertPayment(makeRequest(valid), ctx);

    expect(res.status).toBe(200);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect((res.jsonBody as { myobWarning: string }).myobWarning).toMatch(/MYOB sync is switched off/);
    expect(callMatching(/SET MyobID = @MyobID/)).toBeUndefined();
  });

  it("create: any other MYOB failure is still non-fatal, with no warning field", async () => {
    routeSql(createRoutes());
    myob.createMyobBill.mockRejectedValueOnce(new Error("MYOB createBill 500: boom"));

    const res = await upsertPayment(makeRequest(valid), ctx);

    expect(res.status).toBe(200);
    expect((res.jsonBody as { myobWarning?: string }).myobWarning).toBeUndefined();
  });

  it("create: a failed role lookup doesn't stop the payment, it just leaves the role off", async () => {
    routeSql(createRoutes());
    auth.rolesForRequest.mockRejectedValueOnce(new Error("lookup failed"));

    const res = await upsertPayment(makeRequest(valid), ctx);

    expect(res.status).toBe(200);
    expect(myob.createMyobBill).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { kind: "user", name: "Johanne CFO", oid: "cfo-oid" } }),
    );
  });

  it("mark paid: applies the payment in MYOB as the signed-in user", async () => {
    routeSql([unpaid]);

    const res = await markPaymentPaid(makeRequest({ PaymentID: 11 }), ctx);

    expect(res.status).toBe(200);
    expect(myob.applyMyobPayment).toHaveBeenCalledWith(
      expect.objectContaining({ actor: ACTOR, billUid: "bill-uid", sqlToken: "mock-token" }),
    );
  });

  it("mark paid: when MYOB writes are off, still marks it paid locally and says so", async () => {
    routeSql([unpaid]);
    myob.applyMyobPayment.mockRejectedValueOnce(new MyobWritesDisabledError());

    const res = await markPaymentPaid(makeRequest({ PaymentID: 11 }), ctx);

    expect(res.status).toBe(200);
    expect(callMatching(/SET Status = 'paid'/)).toBeDefined();
    expect((res.jsonBody as { myobWarning: string }).myobWarning).toMatch(/MYOB sync is switched off/);
  });

  it("mark paid: skips MYOB entirely when the payment has no bill", async () => {
    routeSql([[/SELECT\s+PaymentID, JobID/, [{ Amount: 100, MyobID: null, PaymentID: 11, Status: "pending" }]]]);

    const res = await markPaymentPaid(makeRequest({ PaymentID: 11 }), ctx);

    expect(res.status).toBe(200);
    expect(myob.applyMyobPayment).not.toHaveBeenCalled();
  });
});
