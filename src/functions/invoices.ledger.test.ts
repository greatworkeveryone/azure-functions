/// <reference types="jest" />
// Invoice approvals, rejections, director approvals and "created in MYOB"
// markings each write one decision-ledger row in the decision's own transaction
// (WP19b, PLAN §3.12). The DB layer is mocked and the real ledger runs, so what
// is asserted is the INSERT record() really sends.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  buildUpdateSet: jest.fn(),
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
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../jobPlannerSync", () => ({ syncJobActionTriggersStandalone: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../email/director-emails", () => ({ sendDirectorApprovalEmail: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

const auth = require("../auth") as {
  requireRole: jest.Mock;
  rolesForRequest: jest.Mock;
  verifiedIdentityFromRequest: jest.Mock;
};
const db = require("../db") as {
  beginTransaction: jest.Mock;
  buildUpdateSet: jest.Mock;
  closeConnection: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const limitsDb = require("../approval-limits-db") as { getCachedApprovalLimits: jest.Mock };
const planner = require("../planner") as { resolveActivePlannerTasks: jest.Mock };
const plannerSync = require("../jobPlannerSync") as { syncJobActionTriggersStandalone: jest.Mock };
const directorEmails = require("../email/director-emails") as { sendDirectorApprovalEmail: jest.Mock };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
require("./invoices");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const registered = (name: string): Handler => {
  const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!hit) throw new Error(`handler ${name} not registered`);
  return (hit[1] as { handler: Handler }).handler;
};
const approveJobInvoice = registered("approveJobInvoice");
const resendDirectorInvoiceEmail = registered("resendDirectorInvoiceEmail");
const { upsertJobInvoice } = require("./invoices") as { upsertJobInvoice: Handler };
const directorApproveJobInvoice = registered("directorApproveJobInvoice");
const rejectJobInvoice = registered("rejectJobInvoice");
const markJobInvoiceMyobCreated = registered("markJobInvoiceMyobCreated");
const undoDirectorApproveJobInvoice = registered("undoDirectorApproveJobInvoice");
const unmarkJobInvoiceMyobCreated = registered("unmarkJobInvoiceMyobCreated");
const deleteJobInvoice = registered("deleteJobInvoice");

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
const ran = (re: RegExp): boolean => orderOf(re) >= 0;
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

function makeRequest(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const CALLER = { email: "casey@example.com", name: "Casey Controller", oid: "controller-oid" };
const APP_USER: Route = { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 21 }] };
const JOB_BUILDING: Route = { match: /SELECT BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5 }] };
const STORED: Route = { match: /JobInvoiceID, JobID, InvoiceNumber, Seq/, rows: [{ JobInvoiceID: 5, Status: "approved" }] };
const LEDGER_FAILS: Route = { match: /INSERT INTO dbo\.DecisionLedger/, reject: new Error("ledger unavailable") };
const INVOICE_SCOPE: Route = { match: /FROM JobInvoices s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] };
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const invoice = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  Amount: 500,
  ContractorName: "Acme",
  Direction: "incoming",
  InvoiceNumber: "IV-9-1",
  JobID: 9,
  Status: "pending",
  SupplierInvoiceNumber: "INV-0042",
  ...over,
});
const FIRST_SELECT = /FROM JobInvoices WITH \(UPDLOCK, HOLDLOCK\) WHERE JobInvoiceID = @Id/;
const invoiceRow = (over: Record<string, unknown> = {}): Route => ({ match: FIRST_SELECT, rows: [invoice(over)] });
const FACTS = {
  amount: 500,
  contractorName: "Acme",
  direction: "incoming",
  invoiceNumber: "IV-9-1",
  supplierInvoiceNumber: "INV-0042",
};

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
  limitsDb.getCachedApprovalLimits.mockResolvedValue([
    { MaxApprovalAmount: 100, RoleName: "facilities_manager" },
    { MaxApprovalAmount: 1000, RoleName: "accounts_manager" },
    { MaxApprovalAmount: null, RoleName: "director" },
  ]);
  directorEmails.sendDirectorApprovalEmail.mockResolvedValue({ sentAt: new Date("2026-10-13T00:00:00Z"), sentTo: ["d@example.com"] });
  mockSql([APP_USER, JOB_BUILDING, STORED]);
});

afterEach(() => jest.restoreAllMocks());

describe("approveJobInvoice", () => {
  const approve = () => approveJobInvoice(makeRequest({ JobInvoiceID: 5 }), ctx);

  it("within the caller's limit: writes one invoice.approve row naming who, what, where and from what", async () => {
    mockSql([APP_USER, JOB_BUILDING, invoiceRow(), STORED]);

    const res = await approve();

    expect(res.status).toBe(200);
    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "invoice.approve",
      actorKind: "user",
      actorName: "Casey Controller",
      actorRole: "accounts_manager",
      actorUserId: 21,
      after: { ...FACTS, status: "approved" },
      before: { status: "pending" },
      buildingId: 5,
      isException: false,
      jobId: 9,
      reason: null,
      ruleApplied: "own_authority",
      subjectId: "5",
      subjectType: "invoice",
    });
    expect(String(rows[0].correlationId)).toMatch(GUID);
  });

  it("past every other role's limit: approved for stage 1, says the director gate engaged, and only then emails the director", async () => {
    mockSql([APP_USER, JOB_BUILDING, invoiceRow({ Amount: 5000 }), STORED]);

    const res = await approve();
    await flush();

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({
      after: { amount: 5000, status: "approved" },
      ruleApplied: "director_threshold",
    });
    expect(directorEmails.sendDirectorApprovalEmail).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      directorEmails.sendDirectorApprovalEmail.mock.invocationCallOrder[0],
    );
  });

  it("beyond the caller's own limit but short of the director's: waits for someone senior, as over_limit", async () => {
    auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
    mockSql([APP_USER, JOB_BUILDING, invoiceRow({ Amount: 800 }), STORED]);

    await approve();

    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({
      actorRole: "facilities_manager",
      after: { status: "awaiting_approval" },
      ruleApplied: "over_limit",
    });
    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
    expect(plannerSync.syncJobActionTriggersStandalone).not.toHaveBeenCalled();
  });

  it("does the approval's writes and the ledger row inside one transaction, then commits", async () => {
    mockSql([APP_USER, JOB_BUILDING, invoiceRow(), STORED]);

    await approve();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    for (const write of [FIRST_SELECT, /UPDATE JobInvoices\s+SET Status = @Status/, /INSERT INTO JobEvents/, /UPDATE Jobs SET LastModifiedDate/, /INSERT INTO dbo\.DecisionLedger/]) {
      expect(orderOf(write)).toBeGreaterThan(begun);
      expect(orderOf(write)).toBeLessThan(committed);
    }
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(orderOf(/UPDATE JobInvoices\s+SET Status = @Status/));
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
    expect(plannerSync.syncJobActionTriggersStandalone).toHaveBeenCalledWith(9, expect.any(Function));
  });

  it("rolls the approval back when the ledger write fails: no ledger row, no decision", async () => {
    mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, invoiceRow({ Amount: 5000 }), STORED]);

    const res = await approve();
    await flush();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(/UPDATE JobInvoices\s+SET Status = @Status/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
    expect(plannerSync.syncJobActionTriggersStandalone).not.toHaveBeenCalled();
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("404s an unknown invoice, rolling back and writing nothing", async () => {
    const res = await approve();

    expect(res.status).toBe(404);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(ran(/UPDATE JobInvoices/)).toBe(false);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });

  it("records a refused role as `denied` and answers with the gate's own 403", async () => {
    const gate = { jsonBody: { details: "Required role: accounts_manager. Have: facilities", error: "Forbidden" }, status: 403 };
    auth.requireRole.mockResolvedValue(gate);
    auth.rolesForRequest.mockResolvedValue(["facilities"]);
    mockSql([APP_USER, INVOICE_SCOPE]);

    const res = await approve();

    expect(res).toBe(gate);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "denied",
        actorRole: "facilities",
        before: { attempted: "invoice.approve" },
        buildingId: 5,
        jobId: 9,
        ruleApplied: "role_not_permitted",
        subjectId: "5",
        subjectType: "invoice",
      }),
    ]);
    expect(ran(/UPDATE JobInvoices/)).toBe(false);
  });
});

describe("directorApproveJobInvoice", () => {
  const approve = () => directorApproveJobInvoice(makeRequest({ JobInvoiceID: 5 }), ctx);

  beforeEach(() => auth.rolesForRequest.mockResolvedValue(["director"]));

  it("writes one invoice.director_approve row: approved to director_approved, by the director", async () => {
    mockSql([APP_USER, JOB_BUILDING, invoiceRow({ Amount: 5000, Status: "approved" }), STORED]);

    const res = await approve();

    expect(res.status).toBe(200);
    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "invoice.director_approve",
      actorName: "Casey Controller",
      actorRole: "director",
      actorUserId: 21,
      after: { ...FACTS, amount: 5000, status: "director_approved" },
      before: { status: "approved" },
      buildingId: 5,
      isException: false,
      jobId: 9,
      subjectId: "5",
      subjectType: "invoice",
    });
  });

  it("writes the approval and the ledger row inside one transaction that commits, then closes the Planner task", async () => {
    mockSql([APP_USER, JOB_BUILDING, invoiceRow({ Status: "approved" }), STORED]);

    await approve();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    for (const write of [FIRST_SELECT, /SET Status = 'director_approved'/, /INSERT INTO JobEvents/, /INSERT INTO dbo\.DecisionLedger/]) {
      expect(orderOf(write)).toBeGreaterThan(begun);
      expect(orderOf(write)).toBeLessThan(committed);
    }
    expect(planner.resolveActivePlannerTasks).toHaveBeenCalledWith("job", 9, ["director_approval"]);
  });

  it("rolls the approval back when the ledger write fails", async () => {
    mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, invoiceRow({ Status: "approved" }), STORED]);

    const res = await approve();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(/SET Status = 'director_approved'/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    expect(planner.resolveActivePlannerTasks).not.toHaveBeenCalled();
  });

  it("an invoice already director-approved is a 400 with no ledger row", async () => {
    mockSql([APP_USER, JOB_BUILDING, invoiceRow({ Status: "director_approved" }), STORED]);

    const res = await approve();

    expect(res.status).toBe(400);
    expect(res.jsonBody).toEqual({ error: "Invoice is already director-approved" });
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });

  describe("refused attempts", () => {
    it("stage 1 can't be skipped: the same 400, recorded as `denied` after the decision's transaction has rolled back", async () => {
      mockSql([APP_USER, JOB_BUILDING, invoiceRow({ Status: "pending" }), STORED]);

      const res = await approve();

      expect(res).toEqual({ jsonBody: { error: "Invoice must be stage-1 approved before director approval" }, status: 400 });
      const rows = ledgerInserts(db.executeQuery);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "denied",
        actorRole: "director",
        before: { attempted: "invoice.director_approve", status: "pending" },
        buildingId: 5,
        isException: true,
        jobId: 9,
        reason: "Invoice must be stage-1 approved before director approval",
        ruleApplied: "stage_one_approval_required",
        subjectId: "5",
        subjectType: "invoice",
      });
      expect(ran(/SET Status = 'director_approved'/)).toBe(false);
      // The decision's transaction rolled back; the refusal then had one of its own.
      expect(db.rollbackTransaction.mock.invocationCallOrder[0]).toBeLessThan(db.beginTransaction.mock.invocationCallOrder[1]);
      expect(db.beginTransaction).toHaveBeenCalledTimes(2);
      expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it("an admin is not a director: still 403 \"Director role required\", recorded as director_role_required", async () => {
      auth.rolesForRequest.mockResolvedValue(["admin"]);
      mockSql([APP_USER, INVOICE_SCOPE]);

      const res = await approve();

      expect(res).toEqual({ jsonBody: { error: "Director role required" }, status: 403 });
      expect(ledgerInserts(db.executeQuery)).toEqual([
        expect.objectContaining({
          action: "denied",
          actorRole: "admin",
          before: { attempted: "invoice.director_approve" },
          jobId: 9,
          ruleApplied: "director_role_required",
          subjectId: "5",
        }),
      ]);
      expect(ran(/UPDATE JobInvoices/)).toBe(false);
    });

    it("the role gate refusing is recorded as role_not_permitted, and answers as before", async () => {
      const gate = { jsonBody: { details: "Required role: director. Have: accounts", error: "Forbidden" }, status: 403 };
      auth.requireRole.mockResolvedValue(gate);
      auth.rolesForRequest.mockResolvedValue(["accounts"]);
      mockSql([APP_USER, INVOICE_SCOPE]);

      const res = await approve();

      expect(res).toBe(gate);
      expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ ruleApplied: "role_not_permitted" })]);
    });

    it("answers the same 400 even when the refusal can't be recorded", async () => {
      mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, invoiceRow({ Status: "pending" }), STORED]);

      const res = await approve();

      expect(res).toEqual({ jsonBody: { error: "Invoice must be stage-1 approved before director approval" }, status: 400 });
    });
  });
});

describe("rejectJobInvoice", () => {
  const reject = () => rejectJobInvoice(makeRequest({ JobInvoiceID: 5 }), ctx);

  it("writes one invoice.reject row, from whatever the invoice was to rejected", async () => {
    mockSql([APP_USER, JOB_BUILDING, invoiceRow({ Status: "awaiting_approval" }), STORED]);

    const res = await reject();

    expect(res.status).toBe(200);
    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "invoice.reject",
      actorName: "Casey Controller",
      actorRole: "accounts_manager",
      actorUserId: 21,
      after: { ...FACTS, status: "rejected" },
      before: { status: "awaiting_approval" },
      buildingId: 5,
      isException: false,
      jobId: 9,
      subjectId: "5",
      subjectType: "invoice",
    });
  });

  it("writes the rejection and the ledger row inside one transaction that commits", async () => {
    mockSql([APP_USER, JOB_BUILDING, invoiceRow(), STORED]);

    await reject();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    for (const write of [/SET Status = 'rejected'/, /INSERT INTO JobEvents/, /INSERT INTO dbo\.DecisionLedger/]) {
      expect(orderOf(write)).toBeGreaterThan(begun);
      expect(orderOf(write)).toBeLessThan(committed);
    }
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("rolls the rejection back when the ledger write fails", async () => {
    mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, invoiceRow(), STORED]);

    const res = await reject();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(/SET Status = 'rejected'/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
  });

  it("404s an unknown invoice, writing nothing", async () => {
    const res = await reject();

    expect(res.status).toBe(404);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });

  it("records a refused role as `denied` and answers with the gate's own 403", async () => {
    const gate = { jsonBody: { details: "Required role: accounts_manager. Have: accounts", error: "Forbidden" }, status: 403 };
    auth.requireRole.mockResolvedValue(gate);
    auth.rolesForRequest.mockResolvedValue(["accounts"]);
    mockSql([APP_USER, INVOICE_SCOPE]);

    const res = await reject();

    expect(res).toBe(gate);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: { attempted: "invoice.reject" }, ruleApplied: "role_not_permitted" }),
    ]);
  });
});

describe("markJobInvoiceMyobCreated", () => {
  const mark = () => markJobInvoiceMyobCreated(makeRequest({ JobInvoiceID: 5 }), ctx);

  it("writes one invoice.myob_created row once the invoice is fully approved", async () => {
    mockSql([APP_USER, JOB_BUILDING, invoiceRow({ Status: "approved" }), STORED]);

    const res = await mark();

    expect(res.status).toBe(200);
    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "invoice.myob_created",
      actorName: "Casey Controller",
      actorRole: "accounts_manager",
      actorUserId: 21,
      after: { ...FACTS, myobCreated: true, status: "approved" },
      before: { myobCreated: false },
      buildingId: 5,
      isException: false,
      jobId: 9,
      subjectId: "5",
      subjectType: "invoice",
    });
    expect(String(rows[0].correlationId)).toMatch(GUID);
  });

  it("shows that it was already marked when it is marked again", async () => {
    mockSql([APP_USER, JOB_BUILDING, invoiceRow({ MyobCreatedAt: new Date("2026-10-01T00:00:00Z"), Status: "approved" }), STORED]);

    await mark();

    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ after: { myobCreated: true }, before: { myobCreated: true } });
  });

  it("accepts a director-approved invoice that needed the director", async () => {
    mockSql([APP_USER, JOB_BUILDING, invoiceRow({ Amount: 5000, Status: "director_approved" }), STORED]);

    const res = await mark();

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "invoice.myob_created", after: { status: "director_approved" } });
  });

  it("stamps the invoice and writes the ledger row inside one transaction that commits", async () => {
    mockSql([APP_USER, JOB_BUILDING, invoiceRow({ Status: "approved" }), STORED]);

    await mark();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    for (const write of [/SET MyobCreatedAt = SYSUTCDATETIME\(\)/, /INSERT INTO JobEvents/, /INSERT INTO dbo\.DecisionLedger/]) {
      expect(orderOf(write)).toBeGreaterThan(begun);
      expect(orderOf(write)).toBeLessThan(committed);
    }
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("rolls the marking back when the ledger write fails", async () => {
    mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, invoiceRow({ Status: "approved" }), STORED]);

    const res = await mark();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(/SET MyobCreatedAt = SYSUTCDATETIME\(\)/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
  });

  describe("refused attempts", () => {
    it("an unapproved invoice: the same 400, recorded as `denied` / approval_required", async () => {
      mockSql([APP_USER, JOB_BUILDING, invoiceRow({ Status: "pending" }), STORED]);

      const res = await mark();

      expect(res).toEqual({ jsonBody: { error: "Invoice must be approved before MYOB creation" }, status: 400 });
      const rows = ledgerInserts(db.executeQuery);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "denied",
        before: { attempted: "invoice.myob_created", status: "pending" },
        buildingId: 5,
        jobId: 9,
        reason: "Invoice must be approved before MYOB creation",
        ruleApplied: "approval_required",
        subjectId: "5",
      });
      expect(ran(/SET MyobCreatedAt/)).toBe(false);
    });

    it("an invoice the director has yet to approve: director_approval_required", async () => {
      mockSql([APP_USER, JOB_BUILDING, invoiceRow({ Amount: 5000, Status: "approved" }), STORED]);

      const res = await mark();

      expect(res).toEqual({ jsonBody: { error: "Invoice must be director-approved before MYOB creation" }, status: 400 });
      expect(ledgerInserts(db.executeQuery)).toEqual([
        expect.objectContaining({ action: "denied", ruleApplied: "director_approval_required" }),
      ]);
    });

    it("the role gate refusing is recorded as role_not_permitted, and answers as before", async () => {
      const gate = { jsonBody: { details: "Required role: accounts_manager. Have: facilities", error: "Forbidden" }, status: 403 };
      auth.requireRole.mockResolvedValue(gate);
      auth.rolesForRequest.mockResolvedValue(["facilities"]);
      mockSql([APP_USER, INVOICE_SCOPE]);

      const res = await mark();

      expect(res).toBe(gate);
      expect(ledgerInserts(db.executeQuery)).toEqual([
        expect.objectContaining({ before: { attempted: "invoice.myob_created" }, ruleApplied: "role_not_permitted" }),
      ]);
    });

    it("answers the same 400 even when the refusal can't be recorded", async () => {
      mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, invoiceRow({ Status: "pending" }), STORED]);

      const res = await mark();

      expect(res).toEqual({ jsonBody: { error: "Invoice must be approved before MYOB creation" }, status: 400 });
    });
  });
});

// ── Reversals and deletions ─────────────────────────────────────────────────

describe("invoice reversals and deletions", () => {
  const stamps = {
    ApprovedAt: new Date("2026-10-01T02:03:04Z"),
    ApprovedBy: "Pat Approver",
    DirectorApprovedAt: new Date("2026-10-02T03:04:05Z"),
    DirectorApprovedBy: "Dana Director",
    InvoicePDFBlobName: "invoices/5.pdf",
  };
  const SNAPSHOT = {
    ...FACTS,
    approvedAt: "2026-10-01T02:03:04.000Z",
    approvedBy: "Pat Approver",
    currency: "AUD",
    directorApprovedAt: "2026-10-02T03:04:05.000Z",
    directorApprovedBy: "Dana Director",
    myobCreatedAt: null,
    myobCreatedBy: null,
    pdfBlobName: "invoices/5.pdf",
  };
  const row = (over: Record<string, unknown> = {}): Route => invoiceRow({ Currency: "AUD", ...stamps, ...over });
  const calls = () => ledgerInserts(db.executeQuery);
  const gate = { jsonBody: { details: "Required role: accounts_manager. Have: accounts", error: "Forbidden" }, status: 403 };
  const refuseRole = () => {
    auth.requireRole.mockResolvedValue(gate);
    auth.rolesForRequest.mockResolvedValue(["accounts"]);
    mockSql([APP_USER, INVOICE_SCOPE]);
  };

  describe("undoDirectorApproveJobInvoice", () => {
    const undo = () => undoDirectorApproveJobInvoice(makeRequest({ JobInvoiceID: 5 }), ctx);

    beforeEach(() => auth.rolesForRequest.mockResolvedValue(["director"]));

    it("writes one invoice.undo_director_approve exception row, keeping who approved it and when", async () => {
      mockSql([APP_USER, JOB_BUILDING, row({ Amount: 5000, Status: "director_approved" }), STORED]);

      const res = await undo();

      expect(res.status).toBe(200);
      expect(calls()).toHaveLength(1);
      expect(calls()[0]).toMatchObject({
        action: "invoice.undo_director_approve",
        actorName: "Casey Controller",
        actorRole: "director",
        actorUserId: 21,
        after: { ...FACTS, amount: 5000, status: "approved" },
        before: { ...SNAPSHOT, amount: 5000, status: "director_approved" },
        buildingId: 5,
        isException: true,
        jobId: 9,
        subjectId: "5",
        subjectType: "invoice",
      });
    });

    it("clears the approval and writes the ledger row inside one transaction that commits", async () => {
      mockSql([APP_USER, JOB_BUILDING, row({ Status: "director_approved" }), STORED]);

      await undo();

      const begun = db.beginTransaction.mock.invocationCallOrder[0];
      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      for (const write of [FIRST_SELECT, /SET Status = 'approved',\s+DirectorApprovedAt = NULL/, /INSERT INTO JobEvents/, /INSERT INTO dbo\.DecisionLedger/]) {
        expect(orderOf(write)).toBeGreaterThan(begun);
        expect(orderOf(write)).toBeLessThan(committed);
      }
      expect(db.rollbackTransaction).not.toHaveBeenCalled();
    });

    it("is rolled back when the ledger write fails: the approval is not undone without its record", async () => {
      mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, row({ Status: "director_approved" }), STORED]);

      const res = await undo();

      expect(res.status).toBe(500);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(orderOf(/SET Status = 'approved',\s+DirectorApprovedAt = NULL/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    });

    it("an invoice already created in MYOB: the same 400, recorded as a refused attempt", async () => {
      mockSql([APP_USER, JOB_BUILDING, row({ MyobCreatedAt: new Date("2026-10-03T00:00:00Z"), Status: "director_approved" }), STORED]);

      const res = await undo();

      expect(res).toEqual({ jsonBody: { error: "Invoice has been created in MYOB — unmark MYOB first" }, status: 400 });
      expect(calls()).toEqual([
        expect.objectContaining({
          action: "denied",
          before: { attempted: "invoice.undo_director_approve", status: "director_approved" },
          jobId: 9,
          ruleApplied: "already_in_myob",
          subjectId: "5",
        }),
      ]);
      expect(ran(/SET Status = 'approved'/)).toBe(false);
    });

    it("an invoice that isn't director-approved is a 400 with no ledger row", async () => {
      mockSql([APP_USER, JOB_BUILDING, row({ Status: "approved" }), STORED]);

      const res = await undo();

      expect(res.status).toBe(400);
      expect(calls()).toHaveLength(0);
    });

    it("an admin is not a director: still 403 \"Director role required\", recorded as director_role_required", async () => {
      auth.rolesForRequest.mockResolvedValue(["admin"]);
      mockSql([APP_USER, INVOICE_SCOPE]);

      const res = await undo();

      expect(res).toEqual({ jsonBody: { error: "Director role required" }, status: 403 });
      expect(calls()).toEqual([
        expect.objectContaining({ actorRole: "admin", before: { attempted: "invoice.undo_director_approve" }, ruleApplied: "director_role_required" }),
      ]);
    });

    it("the role gate refusing is recorded as role_not_permitted, and answers as before", async () => {
      refuseRole();

      const res = await undo();

      expect(res).toBe(gate);
      expect(calls()).toEqual([expect.objectContaining({ ruleApplied: "role_not_permitted" })]);
    });
  });

  describe("unmarkJobInvoiceMyobCreated", () => {
    const unmark = () => unmarkJobInvoiceMyobCreated(makeRequest({ JobInvoiceID: 5 }), ctx);
    const marked = row({ MyobCreatedAt: new Date("2026-10-03T04:05:06Z"), MyobCreatedBy: "Casey Controller", Status: "approved" });

    it("writes one invoice.unmark_myob_created exception row, keeping who marked it and when", async () => {
      mockSql([APP_USER, JOB_BUILDING, marked, STORED]);

      const res = await unmark();

      expect(res.status).toBe(200);
      expect(calls()).toHaveLength(1);
      expect(calls()[0]).toMatchObject({
        action: "invoice.unmark_myob_created",
        actorName: "Casey Controller",
        actorRole: "accounts_manager",
        actorUserId: 21,
        after: { ...FACTS, myobCreated: false, status: "approved" },
        before: { ...SNAPSHOT, myobCreatedAt: "2026-10-03T04:05:06.000Z", myobCreatedBy: "Casey Controller", status: "approved" },
        buildingId: 5,
        isException: true,
        jobId: 9,
        subjectId: "5",
        subjectType: "invoice",
      });
    });

    it("clears the marking and writes the ledger row inside one transaction that commits", async () => {
      mockSql([APP_USER, JOB_BUILDING, marked, STORED]);

      await unmark();

      const begun = db.beginTransaction.mock.invocationCallOrder[0];
      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      for (const write of [/SET MyobCreatedAt = NULL/, /INSERT INTO JobEvents/, /INSERT INTO dbo\.DecisionLedger/]) {
        expect(orderOf(write)).toBeGreaterThan(begun);
        expect(orderOf(write)).toBeLessThan(committed);
      }
    });

    it("is rolled back when the ledger write fails", async () => {
      mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, marked, STORED]);

      const res = await unmark();

      expect(res.status).toBe(500);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(orderOf(/SET MyobCreatedAt = NULL/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    });

    it("404s an unknown invoice, writing nothing", async () => {
      mockSql([APP_USER, JOB_BUILDING]);

      const res = await unmark();

      expect(res.status).toBe(404);
      expect(calls()).toHaveLength(0);
    });

    it("records a refused role as `denied`", async () => {
      refuseRole();

      const res = await unmark();

      expect(res).toBe(gate);
      expect(calls()).toEqual([expect.objectContaining({ before: { attempted: "invoice.unmark_myob_created" }, ruleApplied: "role_not_permitted" })]);
    });
  });

  describe("deleteJobInvoice", () => {
    const remove = () => deleteJobInvoice(makeRequest({ JobInvoiceID: 5 }), ctx);

    it("writes one invoice.delete exception row whose `before` is a snapshot of what was deleted", async () => {
      mockSql([APP_USER, JOB_BUILDING, row({ Amount: 750, Status: "rejected" })]);

      const res = await remove();

      expect(res).toEqual({ jsonBody: { deleted: true, invoiceId: 5 }, status: 200 });
      expect(calls()).toHaveLength(1);
      expect(calls()[0]).toMatchObject({
        action: "invoice.delete",
        actorName: "Casey Controller",
        actorRole: "accounts_manager",
        actorUserId: 21,
        after: null,
        before: { ...SNAPSHOT, amount: 750, status: "rejected" },
        buildingId: 5,
        isException: true,
        jobId: 9,
        subjectId: "5",
        subjectType: "invoice",
      });
    });

    it("snapshots the supplier's invoice number and contractor, so the invoice can be found again", async () => {
      mockSql([APP_USER, JOB_BUILDING, row({ Status: "pending" })]);

      await remove();

      expect(calls()[0].before).toMatchObject({ contractorName: "Acme", invoiceNumber: "IV-9-1", supplierInvoiceNumber: "INV-0042" });
    });

    it("deletes the invoice and writes the ledger row inside one transaction that commits", async () => {
      mockSql([APP_USER, JOB_BUILDING, row()]);

      await remove();

      const begun = db.beginTransaction.mock.invocationCallOrder[0];
      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      expect(orderOf(FIRST_SELECT)).toBeGreaterThan(begun);
      expect(orderOf(/DELETE FROM JobInvoices WHERE JobInvoiceID = @Id/)).toBeGreaterThan(orderOf(FIRST_SELECT));
      expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(orderOf(/DELETE FROM JobInvoices/));
      expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(committed);
      expect(db.rollbackTransaction).not.toHaveBeenCalled();
    });

    it("is rolled back when the ledger write fails: the invoice is not deleted without its record", async () => {
      mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, row()]);

      const res = await remove();

      expect(res.status).toBe(500);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      // The DELETE ran inside the transaction that was rolled back.
      expect(orderOf(/DELETE FROM JobInvoices/)).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
      expect(orderOf(/DELETE FROM JobInvoices/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    });

    it("an approved invoice is protected: the same 400, recorded as a refused attempt", async () => {
      mockSql([APP_USER, JOB_BUILDING, row({ Status: "approved" })]);

      const res = await remove();

      expect(res).toEqual({ jsonBody: { error: "Cannot delete an approved invoice. Reject it first." }, status: 400 });
      expect(calls()).toEqual([
        expect.objectContaining({
          action: "denied",
          before: { attempted: "invoice.delete", status: "approved" },
          jobId: 9,
          ruleApplied: "approved_invoice_protected",
          subjectId: "5",
        }),
      ]);
      expect(ran(/DELETE FROM JobInvoices/)).toBe(false);
    });

    it("404s an unknown invoice, writing nothing", async () => {
      mockSql([APP_USER, JOB_BUILDING]);

      const res = await remove();

      expect(res.status).toBe(404);
      expect(calls()).toHaveLength(0);
    });

    it("answers 401 and deletes nothing when the ledger can't name who is deleting", async () => {
      auth.verifiedIdentityFromRequest.mockResolvedValue(null);
      mockSql([APP_USER, JOB_BUILDING, row()]);

      const res = await remove();

      expect(res.status).toBe(401);
      expect(ran(/DELETE FROM JobInvoices/)).toBe(false);
    });

    it("records a refused role as `denied`, deleting nothing", async () => {
      refuseRole();

      const res = await remove();

      expect(res).toBe(gate);
      expect(calls()).toEqual([expect.objectContaining({ before: { attempted: "invoice.delete" }, ruleApplied: "role_not_permitted" })]);
      expect(ran(/DELETE FROM JobInvoices/)).toBe(false);
    });
  });
});

// ── Approval resets and director requests ───────────────────────────────────

describe("upsertJobInvoice: an amount edit that tears down an approval", () => {
  const APPROVED_AT = new Date("2026-10-01T02:03:04Z");
  const DIRECTOR_AT = new Date("2026-10-02T05:06:07Z");
  const approved = (over: Record<string, unknown> = {}): Route =>
    invoiceRow({
      ApprovedAt: APPROVED_AT,
      ApprovedBy: "Pat Approver",
      Currency: "AUD",
      DirectorApprovedAt: DIRECTOR_AT,
      DirectorApprovedBy: "Dana Director",
      Status: "approved",
      ...over,
    });
  const reloaded: Route = {
    match: /SELECT\s+JobInvoiceID, JobID, InvoiceNumber, SupplierInvoiceNumber, Seq/,
    rows: [{ JobInvoiceID: 5, Status: "pending" }],
  };
  const edit = (body: Record<string, unknown> = {}) => upsertJobInvoice(makeRequest({ Amount: 9000, JobInvoiceID: 5, ...body }), ctx);
  const resets = () => ledgerInserts(db.executeQuery).filter((r) => r.action === "invoice.approval_reset");
  const CLEAR = /UPDATE JobInvoices\s+SET Status = 'pending'/;

  beforeEach(() => {
    db.buildUpdateSet.mockReturnValue({ params: [], setClause: "Amount = @Amount" });
    mockSql([APP_USER, JOB_BUILDING, approved(), reloaded]);
  });

  it("writes one invoice.approval_reset exception: the old amount, status and approval stamps before, the new amount after", async () => {
    const res = await edit();

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(1);
    const [row] = resets();
    expect(row).toMatchObject({
      action: "invoice.approval_reset",
      actorKind: "user",
      actorName: "Casey Controller",
      actorRole: "accounts_manager",
      actorUserId: 21,
      buildingId: 5,
      isException: true,
      jobId: 9,
      subjectId: "5",
      subjectType: "invoice",
    });
    expect(row.before).toEqual({
      amount: 500,
      approvedAt: "2026-10-01T02:03:04.000Z",
      approvedBy: "Pat Approver",
      directorApprovedAt: "2026-10-02T05:06:07.000Z",
      directorApprovedBy: "Dana Director",
      status: "approved",
    });
    expect(row.after).toEqual({ ...FACTS, amount: 9000, status: "pending" });
  });

  it("shows the edit as a whole in `after`: the new supplier number and direction come with the new amount", async () => {
    await edit({ Direction: "outgoing", SupplierInvoiceNumber: "INV-0099" });

    expect(resets()[0].after).toMatchObject({ amount: 9000, direction: "outgoing", supplierInvoiceNumber: "INV-0099", status: "pending" });
    expect(resets()[0].before).toMatchObject({ amount: 500 });
  });

  it("an invoice that was waiting for its second approval still shows what it held", async () => {
    mockSql([APP_USER, JOB_BUILDING, approved({ DirectorApprovedAt: null, DirectorApprovedBy: null }), reloaded]);

    await edit();

    expect(resets()[0].before).toMatchObject({ directorApprovedAt: null, directorApprovedBy: null, status: "approved" });
  });

  it("writes no row for an invoice that was never approved: there was no approval to tear down", async () => {
    mockSql([
      APP_USER,
      JOB_BUILDING,
      invoiceRow({ ApprovedAt: null, ApprovedBy: null, DirectorApprovedAt: null, DirectorApprovedBy: null, Status: "pending" }),
      reloaded,
    ]);

    const res = await edit();

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(ran(CLEAR)).toBe(false);
  });

  it("writes no row when the amount is sent back unchanged", async () => {
    const res = await edit({ Amount: 500 });

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(ran(CLEAR)).toBe(false);
  });

  it("a contractor-only edit leaves the approval alone, writes no row and doesn't look up who is editing", async () => {
    const res = await edit({ Amount: undefined, ContractorName: "Beta Pty" });

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(ran(/FROM dbo\.AppUsers WHERE EntraOid/)).toBe(false);
    expect(ran(CLEAR)).toBe(false);
  });

  it("clears the approval and writes the ledger row inside one transaction that commits", async () => {
    await edit();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    expect(orderOf(FIRST_SELECT)).toBeGreaterThan(begun);
    for (const write of [/UPDATE JobInvoices SET Amount/, CLEAR, /INSERT INTO dbo\.DecisionLedger/]) {
      expect(orderOf(write)).toBeGreaterThan(orderOf(FIRST_SELECT));
      expect(orderOf(write)).toBeLessThan(committed);
    }
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(orderOf(CLEAR));
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("finds who is editing before anything is written", async () => {
    await edit();

    expect(orderOf(/FROM dbo\.AppUsers WHERE EntraOid/)).toBeLessThan(db.beginTransaction.mock.invocationCallOrder[0]);
  });

  it("rolls the edit back when the ledger write fails: the approval is not torn down without its record", async () => {
    mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, approved(), reloaded]);

    const res = await edit();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(CLEAR)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("answers 401 and starts nothing when the ledger can't name who is editing", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(CALLER).mockResolvedValueOnce(null);

    const res = await edit();

    expect(res.status).toBe(401);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(ran(/UPDATE JobInvoices/)).toBe(false);
  });

  it("404s an unknown invoice inside the transaction, writing nothing", async () => {
    mockSql([APP_USER, JOB_BUILDING]);

    const res = await edit();

    expect(res.status).toBe(404);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });
});

describe("the director request that follows an invoice approval", () => {
  const SENT_AT = new Date("2026-10-13T00:00:00Z");
  const PACKET = { attachments: 1, sections: ["job summary", "quote QT-9-1", "invoice IV-9-1"], separateFiles: 0 };
  const NAMES: Route = { match: /SELECT DisplayName FROM dbo\.AppUsers WHERE Email IN/, rows: [{ DisplayName: "Dana Director" }, { DisplayName: "Bo Boss" }] };
  const STAMP = /UPDATE JobInvoices\s+SET DirectorEmailSentAt/;
  const overEveryLimit = invoiceRow({ Amount: 5000 });
  const approve = async () => {
    const res = await approveJobInvoice(makeRequest({ JobInvoiceID: 5 }), ctx);
    await flush();
    return res;
  };
  const byAction = (action: string) => ledgerInserts(db.executeQuery).filter((r) => r.action === action);

  beforeEach(() => {
    directorEmails.sendDirectorApprovalEmail.mockResolvedValue({
      packet: PACKET,
      sentAt: SENT_AT,
      sentTo: ["dana@example.com", "boss@example.com"],
    });
    mockSql([APP_USER, JOB_BUILDING, overEveryLimit, STORED, NAMES]);
  });

  it("writes one invoice.director_request_sent row once the mail has gone: who it went to, that it was not a resend, what the packet held", async () => {
    const res = await approve();

    expect(res.status).toBe(200);
    expect(byAction("invoice.director_request_sent")).toHaveLength(1);
    const [row] = byAction("invoice.director_request_sent");
    expect(row).toMatchObject({
      actorKind: "user",
      actorName: "Casey Controller",
      actorRole: "accounts_manager",
      actorUserId: 21,
      before: null,
      buildingId: 5,
      isException: false,
      jobId: 9,
      subjectId: "5",
      subjectType: "invoice",
    });
    expect(row.after).toEqual({
      amount: 5000,
      currency: "AUD",
      packet: PACKET,
      recipients: ["Bo Boss", "Dana Director"],
      resend: false,
      unnamedRecipients: 0,
    });
  });

  it("keeps every email address out of every row it writes", async () => {
    await approve();

    expect(JSON.stringify(ledgerInserts(db.executeQuery))).not.toMatch(/@example\.com/);
  });

  it("shares one correlation id with the approval that triggered it", async () => {
    await approve();

    const [approval] = byAction("invoice.approve");
    const [request] = byAction("invoice.director_request_sent");
    expect(String(approval.correlationId)).toMatch(GUID);
    expect(request.correlationId).toBe(approval.correlationId);
  });

  it("stamps the invoice and writes the row in one transaction of its own that commits, after the mail has gone", async () => {
    await approve();

    const mailed = directorEmails.sendDirectorApprovalEmail.mock.invocationCallOrder[0];
    const begun = db.beginTransaction.mock.invocationCallOrder[1];
    const committed = db.commitTransaction.mock.invocationCallOrder[1];
    expect(db.beginTransaction).toHaveBeenCalledTimes(2);
    expect(begun).toBeGreaterThan(mailed);
    expect(orderOf(STAMP)).toBeGreaterThan(begun);
    const requestRow = byAction("invoice.director_request_sent")[0];
    expect(requestRow.order).toBeGreaterThan(orderOf(STAMP));
    expect(requestRow.order).toBeLessThan(committed);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("still stamps who it went to and who sent it, as the e-mail decision check expects", async () => {
    await approve();

    const stamp = db.executeQuery.mock.calls.find((c: unknown[]) => STAMP.test(String(c[1])));
    const params = Object.fromEntries((stamp?.[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value]));
    expect(params).toMatchObject({
      Id: 5,
      SentAt: SENT_AT,
      SentBy: "Casey Controller",
      SentTo: JSON.stringify(["dana@example.com", "boss@example.com"]),
    });
  });

  it("a send that fails leaves the invoice unstamped and writes a invoice.director_request_failed exception row of its own", async () => {
    directorEmails.sendDirectorApprovalEmail.mockRejectedValue(new Error("Graph is down for dana@example.com"));

    const res = await approve();

    expect(res.status).toBe(200);
    expect(byAction("invoice.director_request_sent")).toHaveLength(0);
    expect(ran(STAMP)).toBe(false);
    const [row] = byAction("invoice.director_request_failed");
    expect(row).toMatchObject({
      actorName: "Casey Controller",
      actorRole: "accounts_manager",
      after: { amount: 5000, currency: "AUD", resend: false },
      buildingId: 5,
      isException: true,
      jobId: 9,
      reason: "The director approval email could not be sent",
      ruleApplied: "send_failed",
      subjectId: "5",
      subjectType: "invoice",
    });
    expect(row.correlationId).toBe(byAction("invoice.approve")[0].correlationId);
    expect(byAction("invoice.approve")).toHaveLength(1);
    expect(JSON.stringify(ledgerInserts(db.executeQuery))).not.toMatch(/Graph is down|@example\.com/);
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringContaining("Director email failed for invoice 5"));
  });

  it("rolls the stamp back when the row for the send can't be written: never a stamp without its record", async () => {
    let inserts = 0;
    const routes = [APP_USER, JOB_BUILDING, overEveryLimit, STORED, NAMES];
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/INSERT INTO dbo\.DecisionLedger/.test(sql) && ++inserts >= 2) throw new Error("ledger unavailable");
      return routes.find((r) => r.match.test(sql))?.rows ?? [];
    });

    const res = await approve();

    expect(res.status).toBe(200);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(STAMP)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringContaining("Director email failed for invoice 5"));
  });

  it("sends nothing and records no request for an invoice the caller's own limit covers", async () => {
    mockSql([APP_USER, JOB_BUILDING, invoiceRow({ Amount: 500 }), STORED, NAMES]);

    await approve();

    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
    expect(byAction("invoice.director_request_sent")).toHaveLength(0);
    expect(byAction("invoice.director_request_failed")).toHaveLength(0);
  });
});

describe("resendDirectorInvoiceEmail", () => {
  const SENT_AT = new Date("2026-10-13T00:00:00Z");
  const awaiting = (over: Record<string, unknown> = {}): Route => ({
    match: /SELECT JobID, Amount, Status FROM JobInvoices WHERE JobInvoiceID/,
    rows: [{ Amount: 5000, JobID: 9, Status: "approved", ...over }],
  });
  const NAMES: Route = { match: /SELECT DisplayName FROM dbo\.AppUsers WHERE Email IN/, rows: [{ DisplayName: "Dana Director" }] };
  const STAMP = /UPDATE JobInvoices\s+SET DirectorEmailSentAt/;
  const resend = () => resendDirectorInvoiceEmail(makeRequest({ JobInvoiceID: 5 }), ctx);
  const rows = () => ledgerInserts(db.executeQuery);

  beforeEach(() => {
    auth.rolesForRequest.mockResolvedValue(["facilities"]);
    directorEmails.sendDirectorApprovalEmail.mockResolvedValue({
      packet: { attachments: 0, sections: ["job summary", "invoice IV-9-1"], separateFiles: 0 },
      sentAt: SENT_AT,
      sentTo: ["dana@example.com"],
    });
    mockSql([APP_USER, JOB_BUILDING, awaiting(), STORED, NAMES]);
  });

  it("writes one invoice.director_request_sent row marked as a resend, by whoever pressed the button", async () => {
    const res = await resend();

    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      action: "invoice.director_request_sent",
      actorName: "Casey Controller",
      actorRole: "facilities",
      after: {
        amount: 5000,
        currency: "AUD",
        packet: { attachments: 0, sections: ["job summary", "invoice IV-9-1"], separateFiles: 0 },
        recipients: ["Dana Director"],
        resend: true,
        unnamedRecipients: 0,
      },
      buildingId: 5,
      isException: false,
      jobId: 9,
      subjectId: "5",
      subjectType: "invoice",
    });
    expect(JSON.stringify(rows())).not.toContain("dana@example.com");
  });

  it("stamps the invoice and writes the row in one transaction that commits, after the mail has gone", async () => {
    await resend();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    expect(begun).toBeGreaterThan(directorEmails.sendDirectorApprovalEmail.mock.invocationCallOrder[0]);
    expect(orderOf(STAMP)).toBeGreaterThan(begun);
    expect(rows()[0].order).toBeGreaterThan(orderOf(STAMP));
    expect(rows()[0].order).toBeLessThan(committed);
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
  });

  it("a send that fails writes a invoice.director_request_failed row marked as a resend, and answers as it always did", async () => {
    directorEmails.sendDirectorApprovalEmail.mockRejectedValue(new Error("Graph is down"));

    const res = await resend();

    expect(res.status).toBe(500);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      action: "invoice.director_request_failed",
      after: { amount: 5000, currency: "AUD", resend: true },
      isException: true,
      ruleApplied: "send_failed",
      subjectId: "5",
    });
    expect(ran(STAMP)).toBe(false);
  });

  it("answers the same 500 when the failure can't be recorded either", async () => {
    directorEmails.sendDirectorApprovalEmail.mockRejectedValue(new Error("Graph is down"));
    mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, awaiting(), STORED, NAMES]);

    const res = await resend();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("rolls the stamp back when the row for the send can't be written", async () => {
    mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, awaiting(), STORED, NAMES]);

    const res = await resend();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(STAMP)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
  });

  it("an invoice that isn't awaiting the director is the same 400: nothing sent, nothing recorded", async () => {
    mockSql([APP_USER, JOB_BUILDING, awaiting({ Status: "pending" }), STORED]);

    const res = await resend();

    expect(res).toEqual({ jsonBody: { error: "Invoice is not in the awaiting-director state" }, status: 400 });
    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it("404s an unknown invoice, sending nothing", async () => {
    mockSql([APP_USER, JOB_BUILDING]);

    const res = await resend();

    expect(res.status).toBe(404);
    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
  });

  it("answers 401 and sends nothing when the ledger can't name who pressed resend", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(CALLER).mockResolvedValueOnce(null);

    const res = await resend();

    expect(res.status).toBe(401);
    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("records a refused role as `denied`, answers with the gate's own 403 and sends nothing", async () => {
    const gate = { jsonBody: { details: "Required role: accounts | director | facilities. Have: user", error: "Forbidden" }, status: 403 };
    auth.requireRole.mockResolvedValue(gate);
    auth.rolesForRequest.mockResolvedValue(["user"]);
    mockSql([APP_USER, INVOICE_SCOPE]);

    const res = await resend();

    expect(res).toBe(gate);
    expect(rows()).toEqual([
      expect.objectContaining({
        action: "denied",
        actorRole: "user",
        before: { attempted: "invoice.director_request_sent" },
        buildingId: 5,
        isException: true,
        jobId: 9,
        ruleApplied: "role_not_permitted",
        subjectId: "5",
        subjectType: "invoice",
      }),
    ]);
    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
  });
});
