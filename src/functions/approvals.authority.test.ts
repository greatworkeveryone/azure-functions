/// <reference types="jest" />
// J1: approval authority enforced at every money call site. approveQuote and
// approveJobInvoice decide through the shared core (approvalAuthority.ts) via
// approvalOutcome.ts; the MYOB mark and payments use the same director gate.
// The DB layer is mocked; the real core, loader and ledger run.
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
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn() }));
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../jobPlannerSync", () => ({ syncJobActionTriggersStandalone: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../email/director-emails", () => ({ sendDirectorApprovalEmail: jest.fn() }));
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
const statusHelpers = require("../jobStatusHelpers") as { advanceJobStatus: jest.Mock };
const directorEmails = require("../email/director-emails") as { sendDirectorApprovalEmail: jest.Mock };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
require("./quotes");
require("./invoices");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const registered = (name: string): Handler => {
  const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!hit) throw new Error(`handler ${name} not registered`);
  return (hit[1] as { handler: Handler }).handler;
};
const approveQuote = registered("approveQuote");
const approveJobInvoice = registered("approveJobInvoice");
const markJobInvoiceMyobCreated = registered("markJobInvoiceMyobCreated");
const getApprovalLimits = registered("getApprovalLimits");

type Route = { match: RegExp; rows?: Record<string, unknown>[] };
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => routes.find((r) => r.match.test(sql))?.rows ?? []);
}
const ran = (re: RegExp): boolean => db.executeQuery.mock.calls.some((c: unknown[]) => re.test(String(c[1])));
const param = (re: RegExp, name: string): unknown => {
  const call = db.executeQuery.mock.calls.find((c: unknown[]) => re.test(String(c[1])));
  return ((call?.[2] as { name: string; value: unknown }[] | undefined) ?? []).find((p) => p.name === name)?.value;
};
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};
function makeRequest(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

/** Production rows on 13 Oct 2026, as SQL returns them. */
const PROD_TODAY = [
  { MaxApprovalAmount: 5000, RoleName: "accounts" },
  { MaxApprovalAmount: 5000, RoleName: "facilities" },
  { MaxApprovalAmount: 20000, RoleName: "accounts_manager" },
  { MaxApprovalAmount: 20000, RoleName: "facilities_manager" },
  { MaxApprovalAmount: null, RoleName: "director" },
  { MaxApprovalAmount: null, RoleName: "Admin" },
  { MaxApprovalAmount: 10000, RoleName: "timesheet_approval_accounts" },
  { MaxApprovalAmount: 10000, RoleName: "timesheet_approval_facilities" },
];
/** The same rows after migration 121. */
const PROD_AFTER_121 = [
  { MaxApprovalAmount: 5000, RoleName: "accounts" },
  { MaxApprovalAmount: 5000, RoleName: "facilities" },
  { MaxApprovalAmount: 20000, RoleName: "accounts_manager" },
  { MaxApprovalAmount: 20000, RoleName: "facilities_manager" },
  { MaxApprovalAmount: null, RoleName: "director" },
  { MaxApprovalAmount: 50000, RoleName: "admin" },
  { MaxApprovalAmount: null, RoleName: "cfo" },
];

const CALLER = { email: "pat@example.com", name: "Pat Approver", oid: "pat-oid" };
const APP_USER: Route = { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 21 }] };
const JOB_BUILDING: Route = { match: /SELECT BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5 }] };
const NO_TEST_FLAG: Route = { match: /COL_LENGTH\('dbo\.Jobs', 'IsTest'\)/, rows: [{ Len: null }] };
const TEST_JOB: Route[] = [
  { match: /COL_LENGTH\('dbo\.Jobs', 'IsTest'\)/, rows: [{ Len: 1 }] },
  { match: /SELECT IsTest FROM Jobs WHERE JobID = @JobID/, rows: [{ IsTest: true }] },
];

function as(role: string): void {
  auth.rolesForRequest.mockResolvedValue([role]);
}
function rules(rows: typeof PROD_TODAY, threshold?: string): void {
  limitsDb.getCachedApprovalLimits.mockResolvedValue(rows);
  if (threshold === undefined) delete process.env.DIRECTOR_APPROVAL_THRESHOLD;
  else process.env.DIRECTOR_APPROVAL_THRESHOLD = threshold;
}

const savedThreshold = process.env.DIRECTOR_APPROVAL_THRESHOLD;
afterAll(() => {
  if (savedThreshold === undefined) delete process.env.DIRECTOR_APPROVAL_THRESHOLD;
  else process.env.DIRECTOR_APPROVAL_THRESHOLD = savedThreshold;
});

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  auth.requireRole.mockResolvedValue(null);
  auth.verifiedIdentityFromRequest.mockResolvedValue(CALLER);
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  db.createRequestConnection.mockResolvedValue({ id: "connection" });
  directorEmails.sendDirectorApprovalEmail.mockResolvedValue({ sentAt: new Date("2026-10-14T00:00:00Z"), sentTo: ["d@example.com"] });
  rules(PROD_AFTER_121, "50000");
});

afterEach(() => jest.restoreAllMocks());

describe("approveQuote", () => {
  const quote = (amount: number | null): Route => ({
    match: /SELECT JobID, QuoteNumber, ContractorName, Amount/,
    rows: [{ Amount: amount, ContractorID: 3, ContractorName: "Acme", Currency: "AUD", JobID: 9, QuoteNumber: "QT-9-1", Status: "pending" }],
  });
  const STORED: Route = { match: /SELECT QuoteID FROM Quotes/, rows: [{ QuoteID: 7 }] };
  const approve = () => approveQuote(makeRequest({ QuoteID: 7 }), ctx);
  const landed = (): unknown => param(/UPDATE Quotes\s+SET Status = @Status/, "Status");

  it("lets every role that may approve a quote through the gate, and plain facilities not (attributed approval is held off, decisions 1 and 9)", async () => {
    as("facilities_manager");
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, quote(4000), STORED]);

    await approve();

    const allowed = auth.requireRole.mock.calls[0][1] as string[];
    expect([...allowed].sort()).toEqual(["accounts", "accounts_manager", "admin", "cfo", "director", "facilities_manager"]);
  });

  it("a facilities manager approves a $4,000 quote", async () => {
    as("facilities_manager");
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, quote(4000), STORED]);

    const res = await approve();

    expect(res.status).toBe(200);
    expect(landed()).toBe("approved");
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "quote.approve", actorRole: "facilities_manager", ruleApplied: "own_authority" });
    expect(statusHelpers.advanceJobStatus).toHaveBeenCalled();
  });

  it("before the threshold is set, $21,000 goes to the director (today's rows, 'Admin' and all)", async () => {
    rules(PROD_TODAY);
    as("accounts_manager");
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, quote(21000), STORED]);

    const res = await approve();
    await flush();

    expect(res.status).toBe(200);
    expect(landed()).toBe("awaiting_director");
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ ruleApplied: "director_threshold" });
    expect(directorEmails.sendDirectorApprovalEmail).toHaveBeenCalledTimes(1);
  });

  it("with the threshold at $50,000, $45,000 waits for the CFO or a director", async () => {
    as("accounts_manager");
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, quote(45000), STORED]);

    await approve();
    await flush();

    expect(landed()).toBe("awaiting_approval");
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ ruleApplied: "over_limit" });
    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
    expect(ran(/UPDATE Jobs\s+SET ApprovedQuoteID/)).toBe(false);
  });

  it.each(["cfo", "director"])("with the threshold at $50,000, the %s approves $45,000 outright", async (role) => {
    as(role);
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, quote(45000), STORED]);

    await approve();

    expect(landed()).toBe("approved");
    expect(ran(/UPDATE Jobs\s+SET ApprovedQuoteID/)).toBe(true);
  });

  it("a quote with no amount goes to the director, never approved as $0", async () => {
    as("accounts_manager");
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, quote(null), STORED]);

    await approve();

    expect(landed()).toBe("awaiting_director");
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ after: { amount: null }, ruleApplied: "director_threshold" });
  });

  it("admin approving a $500 quote on a real record: 403, nothing written, the refusal ledgered", async () => {
    as("admin");
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, quote(500), STORED]);

    const res = await approve();

    expect(res).toEqual({
      jsonBody: {
        code: "admin_test_records_only",
        error: "Admin can approve test records only. Real spend is approved by a manager, the CFO or a director.",
      },
      status: 403,
    });
    expect(ran(/UPDATE Quotes/)).toBe(false);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1); // the refusal's own transaction only
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", actorRole: "admin", ruleApplied: "admin_test_records_only", subjectId: "7" }),
    ]);
  });

  it("admin approving a $500 quote on a test record: approved", async () => {
    as("admin");
    mockSql([APP_USER, JOB_BUILDING, ...TEST_JOB, quote(500), STORED]);

    const res = await approve();

    expect(res.status).toBe(200);
    expect(landed()).toBe("approved");
  });

  it("refuses a role with no limit row, with the reason", async () => {
    rules(PROD_AFTER_121.filter((row) => row.RoleName !== "cfo"), "50000");
    as("cfo");
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, quote(100), STORED]);

    const res = await approve();

    expect(res.status).toBe(403);
    expect(res.jsonBody).toEqual({ code: "not_eligible", error: "Your role can't approve this quote." });
    expect(ran(/UPDATE Quotes/)).toBe(false);
  });
});

describe("approveJobInvoice", () => {
  const invoice = (amount: number | null): Route => ({
    match: /FROM JobInvoices WITH \(UPDLOCK, HOLDLOCK\) WHERE JobInvoiceID = @Id/,
    rows: [{ Amount: amount, ContractorName: "Acme", Direction: "incoming", InvoiceNumber: "IV-9-1", JobID: 9, Status: "pending", SupplierInvoiceNumber: "S-1" }],
  });
  const STORED: Route = { match: /JobInvoiceID, JobID, InvoiceNumber, Seq/, rows: [{ JobInvoiceID: 5 }] };
  const approve = () => approveJobInvoice(makeRequest({ JobInvoiceID: 5 }), ctx);
  const landed = (): unknown => param(/UPDATE JobInvoices\s+SET Status = @Status/, "Status");

  it("admits invoice approval roles including facilities managers, excluding officers", async () => {
    as("accounts");
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, invoice(4000), STORED]);

    await approve();

    const allowed = auth.requireRole.mock.calls[0][1] as string[];
    expect([...allowed].sort()).toEqual(["accounts", "accounts_manager", "admin", "cfo", "director", "facilities_manager"]);
  });

  it("accounts approves a $4,000 invoice", async () => {
    as("accounts");
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, invoice(4000), STORED]);

    const res = await approve();

    expect(res.status).toBe(200);
    expect(landed()).toBe("approved");
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "invoice.approve", actorRole: "accounts", ruleApplied: "own_authority" });
  });

  it("before the threshold is set, $21,000 is approved for stage 1 and goes to the director", async () => {
    rules(PROD_TODAY);
    as("accounts_manager");
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, invoice(21000), STORED]);

    await approve();
    await flush();

    expect(landed()).toBe("approved");
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ ruleApplied: "director_threshold" });
    expect(directorEmails.sendDirectorApprovalEmail).toHaveBeenCalledTimes(1);
  });

  it("with the threshold at $50,000, accounts' $45,000 waits for the CFO or a director", async () => {
    as("accounts");
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, invoice(45000), STORED]);

    await approve();

    expect(landed()).toBe("awaiting_approval");
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ ruleApplied: "over_limit" });
  });

  it("an invoice with no amount goes to the director", async () => {
    as("accounts_manager");
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, invoice(null), STORED]);

    await approve();
    await flush();

    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ ruleApplied: "director_threshold" });
    expect(directorEmails.sendDirectorApprovalEmail).toHaveBeenCalledTimes(1);
  });

  it("admin on a real invoice: 403; on a test invoice: approved", async () => {
    as("admin");
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, invoice(500), STORED]);
    const refused = await approve();
    expect(refused.status).toBe(403);
    expect(ran(/UPDATE JobInvoices/)).toBe(false);

    db.executeQuery.mockClear();
    mockSql([APP_USER, JOB_BUILDING, ...TEST_JOB, invoice(500), STORED]);
    const allowed = await approve();
    expect(allowed.status).toBe(200);
    expect(landed()).toBe("approved");
  });

  it("allows a facilities manager within their invoice limit (decision 21)", async () => {
    as("facilities_manager");
    mockSql([APP_USER, JOB_BUILDING, NO_TEST_FLAG, invoice(100), STORED]);

    const res = await approve();

    expect(res.status).toBe(200);
  });
});

describe("markJobInvoiceMyobCreated uses the same director gate", () => {
  const approvedInvoice = (amount: number | null): Route => ({
    match: /FROM JobInvoices WITH \(UPDLOCK, HOLDLOCK\) WHERE JobInvoiceID = @Id/,
    rows: [{ Amount: amount, ContractorName: "Acme", Direction: "incoming", InvoiceNumber: "IV-9-1", JobID: 9, MyobCreatedAt: null, Status: "approved", SupplierInvoiceNumber: "S-1" }],
  });
  const mark = () => markJobInvoiceMyobCreated(makeRequest({ JobInvoiceID: 5 }), ctx);

  it("a $30,000 invoice approved under a $50,000 threshold needs no director before MYOB", async () => {
    as("accounts_manager");
    mockSql([APP_USER, JOB_BUILDING, approvedInvoice(30000), { match: /JobInvoiceID, JobID, InvoiceNumber, Seq/, rows: [{ JobInvoiceID: 5 }] }]);

    const res = await mark();

    expect(res.status).toBe(200);
  });

  it("the same invoice under today's derived $20,000 gate needs the director first", async () => {
    rules(PROD_TODAY);
    as("accounts_manager");
    mockSql([APP_USER, JOB_BUILDING, approvedInvoice(30000)]);

    const res = await mark();

    expect(res.status).toBe(400);
    expect(res.jsonBody).toEqual({ error: "Invoice must be director-approved before MYOB creation" });
  });

  it("an invoice with no amount needs the director first", async () => {
    as("accounts_manager");
    mockSql([APP_USER, JOB_BUILDING, approvedInvoice(null)]);

    const res = await mark();

    expect(res.jsonBody).toEqual({ error: "Invoice must be director-approved before MYOB creation" });
  });
});

describe("getApprovalLimits", () => {
  it("sends role names normalised, and the director threshold the backend enforces", async () => {
    rules(PROD_TODAY, "50000");
    as("accounts");

    const res = await getApprovalLimits(makeRequest(undefined), ctx);

    expect(res.status).toBe(200);
    const body = res.jsonBody as { approvalLimits: { roleName: string }[]; directorThreshold: number | null; effectiveDirectorThreshold: number | null };
    expect(body.approvalLimits.map((row) => row.roleName)).toContain("admin");
    expect(body.approvalLimits.map((row) => row.roleName)).not.toContain("Admin");
    expect(body.directorThreshold).toBe(50000);
    expect(body.effectiveDirectorThreshold).toBe(50000);
  });

  it("reports the derived threshold when none is configured", async () => {
    rules(PROD_TODAY);
    as("accounts");

    const res = await getApprovalLimits(makeRequest(undefined), ctx);

    expect(res.jsonBody).toMatchObject({ directorThreshold: null, effectiveDirectorThreshold: 20000 });
  });

  it("says whether attributed quote approval is switched on (ATTRIBUTED_APPROVAL_ENABLED, off unless \"true\")", async () => {
    rules(PROD_TODAY);
    as("facilities");
    expect((await getApprovalLimits(makeRequest(undefined), ctx)).jsonBody).toMatchObject({ attributedApprovalEnabled: false });
    process.env.ATTRIBUTED_APPROVAL_ENABLED = "true";
    try {
      expect((await getApprovalLimits(makeRequest(undefined), ctx)).jsonBody).toMatchObject({ attributedApprovalEnabled: true });
    } finally {
      delete process.env.ATTRIBUTED_APPROVAL_ENABLED;
    }
  });

  it("sends the R13 variance margin and cap beside the limits, the defaults when the facts can't be read", async () => {
    rules(PROD_TODAY);
    as("accounts");
    const res = await getApprovalLimits(makeRequest(undefined), ctx);
    expect(res.jsonBody).toMatchObject({ varianceMargin: { capDollars: 1000, marginPercent: 10 } });
  });
});
