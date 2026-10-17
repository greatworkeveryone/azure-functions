/// <reference types="jest" />
// J3 for invoices: amounts above $0, no money changes on internal, done or
// archived jobs; a changed amount or payee on an approved invoice clears the
// approval and any MYOB mark (ledgered), and is refused once payments exist;
// approvals only from pending or awaiting approval and never by whoever added
// the invoice; the director's approval from someone other than the creator
// and the stage-1 approver; no undoing a director approval once a payment
// exists; rejection only before the director, MYOB and payments; admin marks
// in MYOB on test records only (decision 4). DB mocked; real ledger.
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
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn() }));
jest.mock("../jobPlannerSync", () => ({ syncJobActionTriggersStandalone: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../email/director-emails", () => ({ sendDirectorApprovalEmail: jest.fn().mockResolvedValue({ sentAt: new Date(), sentTo: [] }) }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

const auth = require("../auth") as { requireRole: jest.Mock; rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const limitsDb = require("../approval-limits-db") as { getCachedApprovalLimits: jest.Mock };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
require("./invoices");
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

const CALLER = { email: "dana@example.com", name: "Dana Director", oid: "dana-oid" };
const APP_USER: Route = { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 21 }] };
const JOB_BUILDING: Route = { match: /SELECT BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5 }] };
const INVOICE_SCOPE: Route = { match: /FROM JobInvoices s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] };
const STORED: Route = { match: /JobInvoiceID, JobID, InvoiceNumber, SupplierInvoiceNumber, Seq/, rows: [{ JobInvoiceID: 5 }] };
const NO_TEST_FLAG: Route = { match: /COL_LENGTH\('dbo\.Jobs', 'IsTest'\)/, rows: [{ Len: null }] };
const LOCKED_INVOICE = /FROM JobInvoices WITH \(UPDLOCK, HOLDLOCK\) WHERE JobInvoiceID = @Id/;
const PAYMENTS = (count: number): Route => ({ match: /SELECT COUNT\(\*\) AS Payments FROM Payments WHERE JobInvoiceID = @Id/, rows: [{ Payments: count }] });
const job = (over: Record<string, unknown> = {}): Route => ({
  match: /SELECT j\.JobID, j\.Status, j\.IsInternal, j\.IsArchived/,
  rows: [{ BuildingID: 5, HasApprovedQuote: 1, IsArchived: false, IsContract: false, IsInternal: false, JobID: 9, Status: "Awaiting Approval", ...over }],
});
const invoice = (over: Record<string, unknown> = {}): Route => ({
  match: LOCKED_INVOICE,
  rows: [{
    Amount: 4000, ApprovedAt: null, ApprovedBy: null, ContractorName: "Acme", CreatedBy: "Abby Accounts", Currency: "AUD",
    DirectorApprovedAt: null, DirectorApprovedBy: null, Direction: "incoming", InvoiceNumber: "IV-9-1", JobID: 9, JobInvoiceID: 5,
    MyobCreatedAt: null, Status: "pending", SupplierInvoiceNumber: "S-1", ...over,
  }],
});

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
  limitsDb.getCachedApprovalLimits.mockResolvedValue([
    { MaxApprovalAmount: 20000, RoleName: "accounts_manager" },
    { MaxApprovalAmount: null, RoleName: "director" },
  ]);
});

afterEach(() => jest.restoreAllMocks());

describe("upsertJobInvoice: creating", () => {
  const CREATED: Route = { match: /INSERT INTO JobInvoices/, rows: [{ JobInvoiceID: 5 }] };

  it("adds an invoice with an amount above $0 on a live job", async () => {
    mockSql([APP_USER, job(), CREATED, STORED]);
    expect((await call("upsertJobInvoice", { Amount: 500, JobID: 9 })).status).toBe(200);
  });

  it.each([[undefined], [null], [0]])("refuses an amount of %p", async (Amount) => {
    mockSql([APP_USER, job(), CREATED]);
    expect(await call("upsertJobInvoice", { Amount, JobID: 9 })).toMatchObject({ jsonBody: { code: "amount_invalid" }, status: 422 });
    expect(wrote(/INSERT INTO JobInvoices/)).toBe(false);
  });

  it.each([
    [{ IsInternal: true }, 422, "internal_job"],
    [{ Status: "Done" }, 409, "job_done"],
  ])("refuses an invoice on a job like %p", async (over, status, code) => {
    mockSql([APP_USER, job(over), CREATED]);
    expect(await call("upsertJobInvoice", { Amount: 500, JobID: 9 })).toMatchObject({ jsonBody: { code }, status });
    expect(wrote(/INSERT INTO JobInvoices/)).toBe(false);
  });

  it("decision 18: an outgoing (on-charge) invoice raised after the job is done is allowed, and ledgered", async () => {
    mockSql([APP_USER, job({ Status: "Done" }), CREATED, STORED]);

    const res = await call("upsertJobInvoice", { Amount: 500, ContractorName: "Tenant Co", Direction: "outgoing", JobID: 9 });

    expect(res.status).toBe(200);
    expect(wrote(/INSERT INTO JobInvoices/)).toBe(true);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "invoice.raised_after_close",
        after: expect.objectContaining({ amount: 500, direction: "outgoing", jobStatus: "Done" }),
        isException: true,
        jobId: 9,
        ruleApplied: "outgoing_after_close",
        subjectId: "5",
      }),
    ]);
  });

  it("decision 18: an outgoing invoice on a live job is not an after-close row", async () => {
    mockSql([APP_USER, job({ Status: "Work" }), CREATED, STORED]);
    expect((await call("upsertJobInvoice", { Amount: 500, Direction: "outgoing", JobID: 9 })).status).toBe(200);
    expect(ledgerInserts(db.executeQuery)).toEqual([]);
  });

  it("decision 18: an outgoing invoice on an internal job is still refused", async () => {
    mockSql([APP_USER, job({ IsInternal: true, Status: "Done" }), CREATED]);
    expect(await call("upsertJobInvoice", { Amount: 500, Direction: "outgoing", JobID: 9 })).toMatchObject({ jsonBody: { code: "internal_job" }, status: 422 });
  });

  it("decision 18: editing an outgoing invoice on a done job is allowed; turning an incoming one outgoing is not", async () => {
    mockSql([APP_USER, job({ Status: "Done" }), invoice({ Direction: "outgoing" }), PAYMENTS(0), STORED]);
    expect((await call("upsertJobInvoice", { JobInvoiceID: 5, Notes: "Sent to tenant" })).status).toBe(200);

    mockSql([APP_USER, job({ Status: "Done" }), invoice({ Direction: "incoming" }), PAYMENTS(0), STORED]);
    expect(await call("upsertJobInvoice", { Direction: "outgoing", JobInvoiceID: 5 })).toMatchObject({ jsonBody: { code: "job_done" }, status: 409 });
  });

  it("decision 18: turning an outgoing invoice incoming on a done job is refused with 409", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Done" }), invoice({ Direction: "outgoing" }), PAYMENTS(0), STORED]);
    expect(await call("upsertJobInvoice", { Direction: "incoming", JobInvoiceID: 5 })).toMatchObject({ jsonBody: { code: "job_done" }, status: 409 });
    expect(wrote(/UPDATE JobInvoices/)).toBe(false);
  });
});

// J3 review: a refusal that is a control on money is ledgered on the create
// and edit paths too; a malformed amount is plain validation and is not.
describe("upsertJobInvoice: control refusals are ledgered", () => {
  it.each([
    ["internal", { IsInternal: true }, "internal_job"],
    ["done", { Status: "Done" }, "job_done"],
    ["archived", { IsArchived: true }, "job_archived"],
  ])("creating on an %s job: one `denied` row against the job", async (_label, over, code) => {
    mockSql([APP_USER, JOB_BUILDING, job(over)]);
    await call("upsertJobInvoice", { Amount: 500, JobID: 9 });
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: expect.objectContaining({ attempted: "invoice.create" }), ruleApplied: code, subjectId: "9", subjectType: "job" }),
    ]);
  });

  it("editing on a done job: one `denied` row against the invoice", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Done" }), invoice(), INVOICE_SCOPE]);
    await call("upsertJobInvoice", { JobInvoiceID: 5, Notes: "x" });
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: expect.objectContaining({ attempted: "invoice.edit" }), ruleApplied: "job_done", subjectId: "5", subjectType: "invoice" }),
    ]);
  });

  it("changing the amount of an invoice with payments: one `denied` row, invoice_paid", async () => {
    mockSql([APP_USER, JOB_BUILDING, job(), invoice(), PAYMENTS(1), INVOICE_SCOPE]);
    expect(await call("upsertJobInvoice", { Amount: 9000, JobInvoiceID: 5 })).toMatchObject({ jsonBody: { code: "invoice_paid" }, status: 409 });
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: expect.objectContaining({ attempted: "invoice.edit" }), ruleApplied: "invoice_paid", subjectType: "invoice" }),
    ]);
  });

  it("a missing amount is plain validation: answered, not ledgered", async () => {
    mockSql([APP_USER, JOB_BUILDING, job()]);
    await call("upsertJobInvoice", { JobID: 9 });
    expect(ledgerInserts(db.executeQuery)).toEqual([]);
  });
});

describe("upsertJobInvoice: editing", () => {
  const approvedInMyob = { ApprovedAt: new Date(), ApprovedBy: "Abby Accounts", MyobCreatedAt: new Date(), Status: "approved" };

  it("a payee change on an approved, MYOB-marked invoice clears the approval and the MYOB mark, ledgered", async () => {
    mockSql([APP_USER, job(), invoice(approvedInMyob), PAYMENTS(0), STORED]);

    const res = await call("upsertJobInvoice", { ContractorName: "Other Co", JobInvoiceID: 5 });

    expect(res.status).toBe(200);
    const reset = sqls().find((sql) => /UPDATE JobInvoices\s+SET Status = 'pending'/.test(sql)) ?? "";
    expect(reset).toMatch(/MyobCreatedAt = NULL, MyobCreatedBy = NULL/);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "invoice.approval_reset", ruleApplied: "payee_changed", subjectId: "5" }),
    ]);
  });

  it("refuses an amount or payee change once payments are recorded", async () => {
    mockSql([APP_USER, job(), invoice(approvedInMyob), PAYMENTS(1)]);
    for (const body of [{ Amount: 4100 }, { ContractorName: "Other Co" }]) {
      expect(await call("upsertJobInvoice", { ...body, JobInvoiceID: 5 })).toMatchObject({ jsonBody: { code: "invoice_paid" }, status: 409 });
    }
    expect(wrote(/UPDATE JobInvoices/)).toBe(false);
  });

  it("refuses edits on a done job, and clearing the amount", async () => {
    mockSql([APP_USER, job({ Status: "Done" }), invoice(), PAYMENTS(0)]);
    expect((await call("upsertJobInvoice", { JobInvoiceID: 5, Notes: "x" })).status).toBe(409);
    mockSql([APP_USER, job(), invoice(), PAYMENTS(0)]);
    expect((await call("upsertJobInvoice", { Amount: null, JobInvoiceID: 5 })).status).toBe(422);
    expect(wrote(/UPDATE JobInvoices/)).toBe(false);
  });
});

describe("approveJobInvoice", () => {
  it.each([
    ["done (incoming)", { Status: "Done" }, 409, "job_done"],
    ["archived", { IsArchived: true }, 409, "job_archived"],
    ["internal", { IsInternal: true }, 422, "internal_job"],
  ])("refuses an invoice on a %s job, writing nothing", async (_label, over, status, code) => {
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, job(over), invoice(), INVOICE_SCOPE]);
    expect(await call("approveJobInvoice", { JobInvoiceID: 5 })).toMatchObject({ jsonBody: { code }, status });
    expect(wrote(/UPDATE JobInvoices/)).toBe(false);
  });

  it("approves an outgoing invoice on a done job (decision 18)", async () => {
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, job({ Status: "Done" }), invoice({ Direction: "outgoing" }), STORED]);
    expect((await call("approveJobInvoice", { JobInvoiceID: 5 })).status).toBe(200);
  });

  it("approves a pending invoice someone else added", async () => {
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, job(), invoice(), STORED]);
    expect((await call("approveJobInvoice", { JobInvoiceID: 5 })).status).toBe(200);
  });

  it.each(["approved", "director_approved", "rejected"])("refuses an invoice that is %s with 409", async (Status) => {
    mockSql([APP_USER, JOB_BUILDING, job(), invoice({ Status }), INVOICE_SCOPE]);
    expect(await call("approveJobInvoice", { JobInvoiceID: 5 })).toMatchObject({ jsonBody: { code: "not_approvable" }, status: 409 });
    expect(wrote(/UPDATE JobInvoices/)).toBe(false);
  });

  it("refuses the person who added the invoice, as sod_blocked", async () => {
    mockSql([APP_USER, JOB_BUILDING, job(), invoice({ CreatedBy: "Dana Director" }), INVOICE_SCOPE]);
    expect(await call("approveJobInvoice", { JobInvoiceID: 5 })).toMatchObject({ jsonBody: { code: "creator" }, status: 403 });
    expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ action: "sod_blocked", ruleApplied: "creator" })]);
  });
});

describe("directorApproveJobInvoice", () => {
  beforeEach(() => auth.rolesForRequest.mockResolvedValue(["director"]));
  const stageOne = (over: Record<string, unknown> = {}) => invoice({ Amount: 30000, ApprovedAt: new Date(), ApprovedBy: "Abby Accounts", Status: "approved", ...over });

  it("approves an invoice someone else added and approved at stage 1", async () => {
    mockSql([APP_USER, JOB_BUILDING, stageOne(), STORED]);
    expect((await call("directorApproveJobInvoice", { JobInvoiceID: 5 })).status).toBe(200);
  });

  it.each([
    ["done (incoming)", { Status: "Done" }, 409, "job_done"],
    ["archived", { IsArchived: true }, 409, "job_archived"],
    ["internal", { IsInternal: true }, 422, "internal_job"],
  ])("refuses the director approval on a %s job: nothing written, ledgered", async (_label, over, status, code) => {
    mockSql([APP_USER, JOB_BUILDING, job(over), stageOne(), INVOICE_SCOPE]);
    expect(await call("directorApproveJobInvoice", { JobInvoiceID: 5 })).toMatchObject({ jsonBody: { code }, status });
    expect(wrote(/SET Status = 'director_approved'/)).toBe(false);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: expect.objectContaining({ attempted: "invoice.director_approve" }), ruleApplied: code }),
    ]);
  });

  it("gives the director approval to an outgoing invoice on a done job (decision 18)", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Done" }), stageOne({ Direction: "outgoing" }), STORED]);
    expect((await call("directorApproveJobInvoice", { JobInvoiceID: 5 })).status).toBe(200);
  });

  it("decision 17: a director who added the invoice and gave its stage-1 approval still gives the director approval", async () => {
    mockSql([APP_USER, JOB_BUILDING, stageOne({ ApprovedBy: "Dana Director", CreatedBy: "Dana Director" }), STORED]);
    expect((await call("directorApproveJobInvoice", { JobInvoiceID: 5 })).status).toBe(200);
    expect(wrote(/SET Status = 'director_approved'/)).toBe(true);
    expect(ledgerInserts(db.executeQuery)).not.toContainEqual(expect.objectContaining({ action: "sod_blocked" }));
  });
});

describe("undoDirectorApproveJobInvoice", () => {
  beforeEach(() => auth.rolesForRequest.mockResolvedValue(["director"]));
  const directorApproved = invoice({ ApprovedBy: "Abby", DirectorApprovedAt: new Date(), DirectorApprovedBy: "Dana Director", Status: "director_approved" });

  it("undoes a director approval with no payment", async () => {
    mockSql([APP_USER, JOB_BUILDING, directorApproved, PAYMENTS(0), STORED]);
    expect((await call("undoDirectorApproveJobInvoice", { JobInvoiceID: 5 })).status).toBe(200);
  });

  it("refuses once a payment exists, ledgered as denied", async () => {
    mockSql([APP_USER, JOB_BUILDING, directorApproved, PAYMENTS(1), INVOICE_SCOPE]);
    expect(await call("undoDirectorApproveJobInvoice", { JobInvoiceID: 5 })).toMatchObject({ jsonBody: { code: "payment_exists" }, status: 409 });
    expect(wrote(/SET Status = 'approved'/)).toBe(false);
    expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ action: "denied", ruleApplied: "payment_exists" })]);
  });
});

describe("rejectJobInvoice", () => {
  it("rejects a pending invoice", async () => {
    mockSql([APP_USER, JOB_BUILDING, invoice(), PAYMENTS(0), STORED]);
    expect((await call("rejectJobInvoice", { JobInvoiceID: 5 })).status).toBe(200);
  });

  it.each([
    ["director-approved", { Status: "director_approved" }, 0],
    ["marked in MYOB", { MyobCreatedAt: new Date(), Status: "approved" }, 0],
    ["paid in part", { Status: "approved" }, 1],
    ["already rejected", { Status: "rejected" }, 0],
  ])("refuses an invoice %s with 409", async (_label, over, payments) => {
    mockSql([APP_USER, JOB_BUILDING, invoice(over), PAYMENTS(payments), INVOICE_SCOPE]);
    expect(await call("rejectJobInvoice", { JobInvoiceID: 5 })).toMatchObject({ jsonBody: { code: "not_rejectable" }, status: 409 });
    expect(wrote(/SET Status = 'rejected'/)).toBe(false);
  });
});

describe("markJobInvoiceMyobCreated (decision 4)", () => {
  const ready = invoice({ ApprovedAt: new Date(), ApprovedBy: "Abby", Status: "approved" });

  it("refuses admin on a real record", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, ready, INVOICE_SCOPE]);
    expect(await call("markJobInvoiceMyobCreated", { JobInvoiceID: 5 })).toMatchObject({ jsonBody: { code: "admin_test_records_only" }, status: 403 });
    expect(wrote(/SET MyobCreatedAt = SYSUTCDATETIME\(\)/)).toBe(false);
  });

  it("lets admin mark a test record", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    mockSql([APP_USER, JOB_BUILDING, { match: /COL_LENGTH/, rows: [{ Len: 1 }] }, { match: /SELECT IsTest FROM Jobs/, rows: [{ IsTest: true }] }, ready, STORED]);
    expect((await call("markJobInvoiceMyobCreated", { JobInvoiceID: 5 })).status).toBe(200);
    expect(paramsOf(/SET MyobCreatedAt = SYSUTCDATETIME\(\)/).CreatedBy).toBe("Dana Director");
  });
  it("refuses admin un-marking a real record too, ledgered", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, invoice({ MyobCreatedAt: new Date(), Status: "approved" }), INVOICE_SCOPE]);
    expect(await call("unmarkJobInvoiceMyobCreated", { JobInvoiceID: 5 })).toMatchObject({ jsonBody: { code: "admin_test_records_only" }, status: 403 });
    expect(wrote(/SET MyobCreatedAt = NULL/)).toBe(false);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: expect.objectContaining({ attempted: "invoice.unmark_myob_created" }), ruleApplied: "admin_test_records_only" }),
    ]);
  });
});
