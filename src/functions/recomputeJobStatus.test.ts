/// <reference types="jest" />
// REV-02: the correction path. A manager puts a job where its own records say
// it is, with a reason, ledgered with before, after and the facts. The DB layer
// is mocked; the real guard, loader and ledger run.
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
require("./recomputeJobStatus");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === "recomputeJobStatus");
if (!hit) throw new Error("recomputeJobStatus not registered");
const recompute = (hit[1] as { handler: Handler }).handler;

type Route = { match: RegExp; rows?: Record<string, unknown>[] };
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => routes.find((r) => r.match.test(sql))?.rows ?? []);
}
const calls = () =>
  db.executeQuery.mock.calls.map((c: unknown[]) => ({
    params: Object.fromEntries(((c[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value])),
    sql: String(c[1]),
  }));
const find = (re: RegExp) => calls().find((c) => re.test(c.sql));
const makeRequest = (body: unknown): HttpRequest =>
  ({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() }) as unknown as HttpRequest;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const JOB_LOCK = /FROM Jobs j WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE j\.JobID = @JobID/;
const APP_USER: Route = { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 21 }] };
const JOB_BUILDING: Route = { match: /SELECT BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5 }] };
const MOVE = /UPDATE Jobs SET Status = @Status[\s\S]*OUTPUT INSERTED\.JobID\s+WHERE JobID = @JobID AND Status = @ExpectedStatus AND AwaitingRole = @ExpectedRole/;
const job = (over: Record<string, unknown> = {}): Route => ({
  match: JOB_LOCK,
  rows: [{
    AwaitingRole: "facilities", BuildingID: 5, HasApprovedQuote: 1, HasCompletePurchaseOrder: 0, HasMoneyRecords: 1, HasQuote: 1,
    IsContract: false, IsInternal: false, PreBlockAwaitingRole: null, PreBlockStatus: null, RequestedContractors: 1, Status: "Awaiting Approval",
    WorkStarted: 0, ...over,
  }],
});
const fix = (body: Record<string, unknown>) => recompute(makeRequest({ JobID: 9, ...body }), ctx);

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
  limitsDb.getCachedApprovalLimits.mockResolvedValue([]);
});

afterEach(() => jest.restoreAllMocks());

describe("recomputeJobStatus", () => {
  it("gates on the reopen roles", async () => {
    mockSql([APP_USER, JOB_BUILDING, job()]);
    await fix({ Reason: "x" });
    expect([...(auth.requireRole.mock.calls[0][1] as string[])].sort()).toEqual(["accounts_manager", "cfo", "director", "facilities_manager"]);
  });

  it("moves a job held at Quote that got a quote approved during the hold, then resumed, from Quote to Work: ledgered with before, after and facts", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Quote" }), { match: MOVE, rows: [{ JobID: 9 }] }]);

    const res = await fix({ Reason: "Quote was approved while the job was on hold" });

    expect(res.status).toBe(200);
    expect(find(MOVE)?.params).toMatchObject({ AwaitingRole: "facilities", ExpectedRole: "facilities", ExpectedStatus: "Quote", Status: "Work" });
    expect(find(/INSERT INTO JobEvents/)?.params).toMatchObject({
      NewStatus: "Work",
      Text: "Status corrected from Quote to Work: Quote was approved while the job was on hold",
    });
    expect(find(/INSERT INTO JobEvents/)?.sql).toMatch(/'status_corrected'/);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "job.status_recomputed",
        actorRole: "facilities_manager",
        after: expect.objectContaining({ awaitingRole: "facilities", facts: expect.objectContaining({ hasApprovedQuote: true }), status: "Work" }),
        before: { awaitingRole: "facilities", status: "Quote" },
        isException: true,
        reason: "Quote was approved while the job was on hold",
      }),
    ]);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("moves a job at Work whose purchase order was completed to accounts, and stamps the service run", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ HasCompletePurchaseOrder: 1, Status: "Work" }), { match: MOVE, rows: [{ JobID: 9 }] }]);
    const res = await fix({ Reason: "PO completed during the hold" });
    expect(res.status).toBe(200);
    expect(find(MOVE)?.params).toMatchObject({ AwaitingRole: "accounts", Status: "Awaiting Approval" });
    expect(calls().some((c) => /ServiceScheduleRuns/i.test(c.sql))).toBe(true);
  });

  it("moves a job back from accounts to Work when the only invoice was rejected, without stamping a run", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ AwaitingRole: "accounts", Status: "Awaiting Approval", WorkStarted: 1 }), { match: MOVE, rows: [{ JobID: 9 }] }]);
    const res = await fix({ Reason: "The invoice was rejected" });
    expect(res.status).toBe(200);
    expect(find(MOVE)?.params).toMatchObject({ AwaitingRole: "facilities", Status: "Work" });
    expect(calls().some((c) => /ServiceScheduleRuns/i.test(c.sql))).toBe(false);
  });

  it("lands at accounts, not Done, when an invoice is still waiting for approval", async () => {
    const invoice = { match: /FROM JobInvoices i\s+WHERE i\.JobID = @JobID/, rows: [{ Amount: 500, Direction: "incoming", MyobCreatedAt: null, PaidAmount: 0, Status: "pending" }] };
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Work" }), invoice, { match: MOVE, rows: [{ JobID: 9 }] }]);
    await fix({ Reason: "Invoice added during the hold" });
    expect(find(MOVE)?.params).toMatchObject({ AwaitingRole: "accounts", Status: "Awaiting Approval" });
  });

  it.each([
    ["Done", "facilities", "done_is_final"],
    ["Tenant", "facilities", "on_hold"],
  ])("never moves a %s job (%s)", async (status, awaitingRole, code) => {
    mockSql([APP_USER, JOB_BUILDING, job({ AwaitingRole: awaitingRole, Status: status }), { match: MOVE, rows: [{ JobID: 9 }] }]);
    expect(await fix({ Reason: "x" })).toMatchObject({ jsonBody: { code }, status: 422 });
    expect(find(MOVE)).toBeUndefined();
  });

  it("refuses an internal job, and a job that is already where its records say", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ IsInternal: true, Status: "Work" }), { match: MOVE, rows: [{ JobID: 9 }] }]);
    expect(await fix({ Reason: "x" })).toMatchObject({ jsonBody: { code: "internal_job" }, status: 422 });
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Work" }), { match: MOVE, rows: [{ JobID: 9 }] }]);
    expect(await fix({ Reason: "x" })).toMatchObject({ jsonBody: { code: "status_already_right" }, status: 422 });
    expect(find(MOVE)).toBeUndefined();
  });

  it.each([["facilities"], ["accounts"], ["admin"]])("%s may not: 403, refusal ledgered, nothing changed", async (role) => {
    auth.rolesForRequest.mockResolvedValue([role]);
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Quote" }), { match: MOVE, rows: [{ JobID: 9 }] }]);
    const res = await fix({ Reason: "Because" });
    expect(res).toMatchObject({ jsonBody: { code: "role_not_permitted" }, status: 403 });
    expect(find(MOVE)).toBeUndefined();
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: expect.objectContaining({ attempted: "job.status_recomputed" }), ruleApplied: "role_not_permitted" }),
    ]);
  });

  it("needs a reason", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Quote" }), { match: MOVE, rows: [{ JobID: 9 }] }]);
    for (const Reason of [undefined, "", "   "]) {
      expect(await fix({ Reason })).toMatchObject({ jsonBody: { code: "reason_required" }, status: 422 });
    }
    expect(find(MOVE)).toBeUndefined();
  });

  it("previews without writing: the status now and the status the records say", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Quote" }), { match: MOVE, rows: [{ JobID: 9 }] }]);
    const res = await fix({ Preview: true });
    expect(res).toMatchObject({ jsonBody: { current: { status: "Quote" }, matches: false, to: { awaitingRole: "facilities", status: "Work" } }, status: 200 });
    expect(find(MOVE)).toBeUndefined();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("answers 409 when the job changed underneath, and 404 for no such job", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Quote" }), { match: MOVE, rows: [] }]);
    expect((await fix({ Reason: "x" })).status).toBe(409);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    mockSql([APP_USER, JOB_BUILDING]);
    expect((await fix({ Reason: "x" })).status).toBe(404);
  });
});
