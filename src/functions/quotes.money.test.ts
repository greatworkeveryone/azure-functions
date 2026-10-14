/// <reference types="jest" />
// J3 for quotes: amounts above $0, no money changes on internal, done or
// archived jobs, a payee change clears the approval (ledgered), approvals only
// from pending or awaiting approval, never by the person who added the quote,
// never a second approved quote on one job, and the director's approval from
// someone other than the quote's creator and its first approver. DB mocked;
// the real ledger and quote-decisions run.
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
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn().mockResolvedValue({ advanced: false }) }));
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
require("./quotes");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const REGISTERED = new Map<string, Handler>(app.http.mock.calls.map((c: unknown[]) => [c[0] as string, (c[1] as { handler: Handler }).handler]));
const handler = (name: string): Handler => {
  const hit = REGISTERED.get(name);
  if (!hit) throw new Error(`handler ${name} not registered`);
  return hit;
};

type Route = { match: RegExp; rows?: Record<string, unknown>[] };
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => routes.find((r) => r.match.test(sql))?.rows ?? []);
}
const calls = () =>
  db.executeQuery.mock.calls.map((c: unknown[]) => ({
    params: Object.fromEntries(((c[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value])),
    sql: String(c[1]),
  }));
const wrote = (re: RegExp) => calls().some((c) => re.test(c.sql));
function makeRequest(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const CALLER = { email: "dana@example.com", name: "Dana Director", oid: "dana-oid" };
const APP_USER: Route = { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 21 }] };
const JOB_BUILDING: Route = { match: /SELECT BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5 }] };
const QUOTE_SCOPE: Route = { match: /FROM Quotes s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] };
const MONEY_JOB = /SELECT j\.JobID, j\.Status, j\.IsInternal, j\.IsArchived/;
const job = (over: Record<string, unknown> = {}): Route => ({
  match: MONEY_JOB,
  rows: [{ BuildingID: 5, HasApprovedQuote: 0, IsArchived: false, IsContract: false, IsInternal: false, JobID: 9, Status: "Awaiting Approval", ...over }],
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

describe("upsertQuote: creating", () => {
  const create = (body: Record<string, unknown>) => handler("upsertQuote")(makeRequest({ JobID: 9, ...body }), ctx);
  const CREATED: Route = { match: /INSERT INTO Quotes/, rows: [{ QuoteID: 7 }] };

  it("adds a quote with an amount above $0 on a live job", async () => {
    mockSql([APP_USER, job(), CREATED, { match: /SELECT\s+QuoteID, JobID, QuoteNumber, Seq/, rows: [{ QuoteID: 7 }] }]);
    expect((await create({ Amount: 500, ContractorName: "Acme" })).status).toBe(200);
  });

  it.each([[undefined], [null], [0], [-10]])("refuses an amount of %p with 422, writing nothing", async (Amount) => {
    mockSql([APP_USER, job(), CREATED]);
    expect(await create({ Amount })).toEqual({ jsonBody: { code: "amount_invalid", error: "Amount is required and must be more than $0." }, status: 422 });
    expect(wrote(/INSERT INTO Quotes/)).toBe(false);
  });

  it.each([
    ["an internal job", { IsInternal: true }, 422, "internal_job"],
    ["a done job", { Status: "Done" }, 409, "job_done"],
    ["an archived job", { IsArchived: true }, 409, "job_archived"],
  ])("refuses a quote on %s", async (_label, over, status, code) => {
    mockSql([APP_USER, job(over), CREATED]);
    const res = await create({ Amount: 500 });
    expect(res.status).toBe(status);
    expect(res.jsonBody).toMatchObject({ code });
    expect(wrote(/INSERT INTO Quotes/)).toBe(false);
  });
});

describe("upsertQuote: editing", () => {
  const BEFORE = /SELECT QuoteID, JobID, QuoteNumber, Amount, ContractorID, ContractorName, Status/;
  const quote = (over: Record<string, unknown> = {}): Route => ({
    match: BEFORE,
    rows: [{ Amount: 4000, ApprovedAt: new Date("2026-10-10T00:00:00Z"), ApprovedBy: "Abby", ContractorID: 3, ContractorName: "Acme", JobID: 9, QuoteID: 7, QuoteNumber: "QT-9-1", Status: "approved", ...over }],
  });
  const edit = (body: Record<string, unknown>) => handler("upsertQuote")(makeRequest({ QuoteID: 7, ...body }), ctx);

  it("a payee change clears the approval and the job's approved quote, and is ledgered", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ HasApprovedQuote: 1, Status: "Work" }), quote(), { match: /SELECT\s+QuoteID, JobID, QuoteNumber, Seq/, rows: [{ QuoteID: 7 }] }]);

    const res = await edit({ ContractorID: 4, ContractorName: "Other Co" });

    expect(res.status).toBe(200);
    expect(wrote(/UPDATE Quotes\s+SET Status = 'pending'/)).toBe(true);
    expect(wrote(/UPDATE Jobs\s+SET ApprovedQuoteID = NULL/)).toBe(true);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "quote.approval_reset", before: expect.objectContaining({ status: "approved" }), ruleApplied: "payee_changed", subjectId: "7" }),
    ]);
  });

  it("an amount change on an approved quote is ledgered as amount_changed", async () => {
    mockSql([APP_USER, JOB_BUILDING, job(), quote(), { match: /SELECT\s+QuoteID, JobID, QuoteNumber, Seq/, rows: [{ QuoteID: 7 }] }]);
    await edit({ Amount: 9000 });
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "quote.approval_reset", ruleApplied: "amount_changed" });
  });

  it("refuses clearing the amount, and a non-positive one", async () => {
    mockSql([APP_USER, job(), quote()]);
    for (const Amount of [null, 0]) {
      expect((await edit({ Amount })).status).toBe(422);
    }
    expect(wrote(/UPDATE Quotes/)).toBe(false);
  });

  it("refuses editing a quote on a done job", async () => {
    mockSql([APP_USER, job({ Status: "Done" }), quote()]);
    expect(await edit({ Notes: "x" })).toMatchObject({ jsonBody: { code: "job_done" }, status: 409 });
    expect(wrote(/UPDATE Quotes/)).toBe(false);
  });

  it("reads the quote under a lock inside the transaction", async () => {
    mockSql([APP_USER, JOB_BUILDING, job(), quote({ Status: "pending", ApprovedAt: null }), { match: /SELECT\s+QuoteID, JobID, QuoteNumber, Seq/, rows: [{ QuoteID: 7 }] }]);
    await edit({ Notes: "x" });
    expect(calls().find((c) => BEFORE.test(c.sql))?.sql).toMatch(/FROM Quotes WITH \(UPDLOCK, HOLDLOCK\) WHERE QuoteID = @Id/);
  });
});

describe("approveQuote", () => {
  const quoteRow = (over: Record<string, unknown> = {}): Route => ({
    match: /SELECT JobID, QuoteNumber, ContractorName, Amount/,
    rows: [{ Amount: 4000, ContractorID: 3, ContractorName: "Acme", CreatedBy: "Abby Accounts", Currency: "AUD", JobID: 9, QuoteNumber: "QT-9-1", Status: "pending", ...over }],
  });
  const approve = () => handler("approveQuote")(makeRequest({ QuoteID: 7 }), ctx);

  it("approves a pending quote someone else added", async () => {
    mockSql([APP_USER, JOB_BUILDING, job(), quoteRow(), { match: /SELECT QuoteID FROM Quotes/, rows: [{ QuoteID: 7 }] }]);
    expect((await approve()).status).toBe(200);
  });

  it.each(["approved", "rejected", "awaiting_director", "completed"])("refuses a quote that is %s with 409, writing nothing", async (Status) => {
    mockSql([APP_USER, JOB_BUILDING, job(), quoteRow({ Status }), QUOTE_SCOPE]);
    const res = await approve();
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "not_approvable" });
    expect(wrote(/UPDATE Quotes/)).toBe(false);
  });

  it("refuses the person who added the quote: 403, ledgered as sod_blocked", async () => {
    mockSql([APP_USER, JOB_BUILDING, job(), quoteRow({ CreatedBy: "Dana Director" }), QUOTE_SCOPE]);
    const res = await approve();
    expect(res).toEqual({ jsonBody: { code: "creator", error: "You added this quote, so someone else has to approve it." }, status: 403 });
    expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ action: "sod_blocked", ruleApplied: "creator" })]);
    expect(wrote(/UPDATE Quotes/)).toBe(false);
  });

  it("refuses a second approved quote on one job", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ HasApprovedQuote: 1 }), quoteRow(), QUOTE_SCOPE]);
    const res = await approve();
    expect(res).toMatchObject({ jsonBody: { code: "quote_already_approved" }, status: 409 });
    expect(wrote(/UPDATE Quotes/)).toBe(false);
  });

  it("refuses a quote on a done job", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Done" }), quoteRow(), QUOTE_SCOPE]);
    expect((await approve()).status).toBe(409);
  });
});

describe("directorApproveQuote", () => {
  const DIRECTOR_READ = /SELECT JobID, QuoteNumber, ContractorName, Status, CreatedBy, ApprovedBy FROM Quotes/;
  const awaiting = (over: Record<string, unknown> = {}): Route => ({
    match: DIRECTOR_READ,
    rows: [{ ApprovedBy: "Abby Accounts", ContractorName: "Acme", CreatedBy: "Fran Facilities", JobID: 9, QuoteNumber: "QT-9-1", Status: "awaiting_director", ...over }],
  });
  const directorApprove = () => handler("directorApproveQuote")(makeRequest({ QuoteID: 7 }), ctx);

  beforeEach(() => auth.rolesForRequest.mockResolvedValue(["director"]));

  it("approves a quote someone else added and selected", async () => {
    mockSql([APP_USER, JOB_BUILDING, awaiting(), { match: /OUTPUT inserted\.QuoteID/, rows: [{ QuoteID: 7 }] }, { match: /SELECT\s+QuoteID, JobID/, rows: [{ QuoteID: 7 }] }]);
    expect((await directorApprove()).status).toBe(200);
  });

  it("refuses a director who added the quote", async () => {
    mockSql([APP_USER, JOB_BUILDING, awaiting({ CreatedBy: "Dana Director" }), QUOTE_SCOPE]);
    const res = await directorApprove();
    expect(res).toMatchObject({ jsonBody: { code: "creator" }, status: 403 });
    expect(wrote(/UPDATE Quotes/)).toBe(false);
    expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ action: "sod_blocked", before: expect.objectContaining({ attempted: "quote.director_approve" }) })]);
  });

  it("refuses a director who gave the quote its first approval", async () => {
    mockSql([APP_USER, JOB_BUILDING, awaiting({ ApprovedBy: "Dana Director" }), QUOTE_SCOPE]);
    expect(await directorApprove()).toMatchObject({ jsonBody: { code: "same_approver" }, status: 403 });
    expect(wrote(/UPDATE Quotes/)).toBe(false);
  });
});
