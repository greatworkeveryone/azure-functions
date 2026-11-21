/// <reference types="jest" />
// REV-04: archiving a job takes it out of every list and stops every money
// action on it, so it is refused while the job has live money, needs a reason,
// is ledgered, and admin alone cannot archive a job with money records on it.
// The DB layer is mocked; the real loader, guard facts and ledger run.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
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
jest.mock("../jobPlannerSync", () => ({ syncJobActionTriggersStandalone: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../escalation/criticalJob", () => ({ raiseCriticalJobEscalation: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn() }));
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
require("./jobs");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === "archiveJob");
if (!hit) throw new Error("archiveJob not registered");
const archiveJob = (hit[1] as { handler: Handler }).handler;

type Route = { match: RegExp; rows?: Record<string, unknown>[] };
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => routes.find((r) => r.match.test(sql))?.rows ?? []);
}
const calls = () => db.executeQuery.mock.calls.map((c: unknown[]) => ({ sql: String(c[1]) }));
const archived = () => calls().some((c) => /UPDATE Jobs SET IsArchived = 1/.test(c.sql));
const makeRequest = (body: unknown): HttpRequest =>
  ({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() }) as unknown as HttpRequest;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const JOB_LOCK = /FROM Jobs j WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE j\.JobID = @JobID/;
const INVOICES = /FROM JobInvoices i\s+WHERE i\.JobID = @JobID/;
const APP_USER: Route = { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 21 }] };
const OWNERSHIP: Route = { match: /SELECT CreatedBy, CreatedById, IsArchived FROM Jobs/, rows: [{ CreatedBy: "Fran Manager", CreatedById: "fran-oid", IsArchived: false }] };
const NO_TEST_FLAG: Route = { match: /COL_LENGTH\('dbo\.Jobs', 'IsTest'\)/, rows: [{ Len: null }] };
const job = (over: Record<string, unknown> = {}): Route => ({
  match: JOB_LOCK,
  rows: [{
    AwaitingRole: "facilities", BuildingID: 5, HasApprovedQuote: 0, HasCompletePurchaseOrder: 0, HasMoneyRecords: 0, HasQuote: 0,
    IsContract: false, IsInternal: false, PreBlockAwaitingRole: null, PreBlockStatus: null, PurchaseOrdersNotInMyob: 0, Status: "Work", ...over,
  }],
});
const invoice = (over: Record<string, unknown> = {}) => ({
  Amount: 4000, Direction: "incoming", MyobCreatedAt: new Date("2026-10-10T00:00:00Z"), PaidAmount: 0, Status: "approved", ...over,
});
const invoices = (...rows: Record<string, unknown>[]): Route => ({ match: INVOICES, rows });
const archive = (body: Record<string, unknown> = { Reason: "Raised by mistake" }) => archiveJob(makeRequest({ JobID: 9, ...body }), ctx);

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  auth.requireRole.mockResolvedValue(null);
  auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
  auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "fran@example.com", name: "Fran Manager", oid: "fran-oid" });
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  db.createRequestConnection.mockResolvedValue({ id: "connection" });
  limitsDb.getCachedApprovalLimits.mockResolvedValue([
    { MaxApprovalAmount: 20000, RoleName: "accounts_manager" },
    { MaxApprovalAmount: 50000, RoleName: "cfo" },
    { MaxApprovalAmount: null, RoleName: "director" },
  ]);
});

afterEach(() => jest.restoreAllMocks());

describe("archiveJob", () => {
  it("archives a job with no money on it, with the reason in its history and the ledger", async () => {
    mockSql([APP_USER, OWNERSHIP, job(), invoices()]);

    const res = await archive();

    expect(res).toMatchObject({ jsonBody: { archived: 9 }, status: 200 });
    const event = db.executeQuery.mock.calls.find((c: unknown[]) => /INSERT INTO JobEvents/.test(String(c[1])));
    expect((event?.[2] as { name: string; value: unknown }[]).find((p) => p.name === "Text")?.value).toBe("Job archived: Raised by mistake");
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "job.archive", actorRole: "facilities_manager", isException: true, jobId: 9, reason: "Raised by mistake" }),
    ]);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([[undefined], [""], ["   "], [5]])("needs a reason (%p): 422, nothing archived", async (Reason) => {
    mockSql([APP_USER, OWNERSHIP, job(), invoices()]);
    expect(await archive({ Reason })).toMatchObject({ jsonBody: { code: "reason_required" }, status: 422 });
    expect(archived()).toBe(false);
  });

  it.each([
    ["an approved quote with no completed purchase order", job({ HasApprovedQuote: 1, HasMoneyRecords: 1, HasQuote: 1 }), invoices()],
    ["a purchase order not recorded in MYOB", job({ HasApprovedQuote: 1, HasCompletePurchaseOrder: 1, HasMoneyRecords: 1, HasQuote: 1, PurchaseOrdersNotInMyob: 1 }), invoices()],
    ["a pending incoming invoice", job({ HasMoneyRecords: 1 }), invoices(invoice({ MyobCreatedAt: null, Status: "pending" }))],
    ["an approved invoice not in MYOB", job({ HasMoneyRecords: 1 }), invoices(invoice({ Amount: 100, MyobCreatedAt: null }))],
    ["an invoice still with the director", job({ HasMoneyRecords: 1 }), invoices(invoice({ Amount: 90000, Status: "approved" }))],
  ])("refuses while the job has %s, names it, ledgers the refusal and archives nothing", async (named, jobRoute, invoiceRoute) => {
    mockSql([APP_USER, OWNERSHIP, jobRoute, invoiceRoute]);

    const res = await archive();

    expect(res.status).toBe(422);
    expect(res.jsonBody).toMatchObject({ code: "job_has_live_money" });
    expect((res.jsonBody as { error: string }).error).toMatch(/Finish or reject them before archiving/);
    expect((res.jsonBody as { outstanding: string[] }).outstanding.length).toBeGreaterThan(0);
    expect(archived()).toBe(false);
    expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ action: "denied", ruleApplied: "job_has_live_money" })]);
    expect(named).toBeTruthy();
  });

  it("archives a job whose money is all finished: completed PO recorded in MYOB, invoice approved and recorded", async () => {
    mockSql([APP_USER, OWNERSHIP, job({ HasApprovedQuote: 1, HasCompletePurchaseOrder: 1, HasMoneyRecords: 1, HasQuote: 1 }), invoices(invoice())]);
    expect((await archive()).status).toBe(200);
  });

  it("admin alone cannot archive a job with money records on it, but can archive one with none", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    mockSql([APP_USER, OWNERSHIP, NO_TEST_FLAG, job({ HasMoneyRecords: 1 }), invoices(invoice())]);
    expect(await archive()).toMatchObject({ jsonBody: { code: "admin_test_records_only" }, status: 403 });
    expect(archived()).toBe(false);

    jest.clearAllMocks();
    mockSql([APP_USER, OWNERSHIP, NO_TEST_FLAG, job(), invoices()]);
    expect((await archive()).status).toBe(200);
  });
});
