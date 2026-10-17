/// <reference types="jest" />
// J2: Done is final. Reopening is an explicit manager action with a reason,
// ledgered as job.reopen (an exception). The system edge INVOICE_PAID closes a
// job only for the MYOB read-back, recording the system actor and the paid
// timestamps. The DB layer is mocked; the real guard, loader and ledger run.
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
const { closeJobWhenInvoicesPaid } = require("../jobInvoicesPaid") as {
  closeJobWhenInvoicesPaid: (
    connection: unknown,
    jobId: number,
    input: { paid: { invoiceId: number; paidAt: Date }[]; source: string },
  ) => Promise<{ closed: boolean; code?: string }>;
};

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
require("./reopenJob");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === "reopenJob");
if (!hit) throw new Error("reopenJob not registered");
const reopenJob = (hit[1] as { handler: Handler }).handler;

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
function makeRequest(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const JOB_LOCK = /FROM Jobs j WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE j\.JobID = @JobID/;
const INVOICES = /FROM JobInvoices i\s+WHERE i\.JobID = @JobID/;
const APP_USER: Route = { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 21 }] };
const JOB_BUILDING: Route = { match: /SELECT BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5 }] };
const REOPEN_UPDATE = /UPDATE Jobs SET [\s\S]*OUTPUT INSERTED\.JobID\s+WHERE JobID = @JobID AND Status = @ExpectedStatus/;
const job = (over: Record<string, unknown> = {}): Route => ({
  match: JOB_LOCK,
  rows: [{
    AwaitingRole: "accounts", BuildingID: 5, HasApprovedQuote: 1, HasMoneyRecords: 1, HasQuote: 1, IsContract: false,
    IsInternal: false, PreBlockAwaitingRole: null, PreBlockStatus: null, Status: "Done", ...over,
  }],
});
const reopen = (body: Record<string, unknown>) => reopenJob(makeRequest({ JobID: 9, ...body }), ctx);

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
  limitsDb.getCachedApprovalLimits.mockResolvedValue([{ MaxApprovalAmount: 20000, RoleName: "accounts_manager" }]);
});

afterEach(() => jest.restoreAllMocks());

describe("reopenJob", () => {
  it("lets every manager role through the gate", async () => {
    mockSql([APP_USER, JOB_BUILDING, job(), { match: REOPEN_UPDATE, rows: [{ JobID: 9 }] }]);
    await reopen({ Reason: "Invoice was for another job" });
    expect([...(auth.requireRole.mock.calls[0][1] as string[])].sort()).toEqual(["accounts_manager", "cfo", "director", "facilities_manager"]);
  });

  it("a manager reopens a done job with a reason: back to accounts, recorded and ledgered as an exception", async () => {
    mockSql([APP_USER, JOB_BUILDING, job(), { match: INVOICES, rows: [] }, { match: REOPEN_UPDATE, rows: [{ JobID: 9 }] }]);

    const res = await reopen({ Reason: "Invoice was for another job" });

    expect(res.status).toBe(200);
    expect(find(REOPEN_UPDATE)?.params).toMatchObject({ AwaitingRole: "accounts", ExpectedStatus: "Done", Status: "Awaiting Approval" });
    expect(find(/INSERT INTO JobEvents/)?.params).toMatchObject({
      CreatedBy: "Fran Manager",
      EventType: "job_reopened",
      NewStatus: "Awaiting Approval",
      Text: "Reopened: Invoice was for another job",
    });
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "job.reopen",
        actorName: "Fran Manager",
        actorRole: "facilities_manager",
        after: { awaitingRole: "accounts", status: "Awaiting Approval" },
        before: { awaitingRole: "accounts", status: "Done" },
        isException: true,
        jobId: 9,
        reason: "Invoice was for another job",
        subjectId: "9",
        subjectType: "job",
      }),
    ]);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("an internal job reopens to Work", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ IsInternal: true }), { match: REOPEN_UPDATE, rows: [{ JobID: 9 }] }]);
    await reopen({ Reason: "Not finished after all" });
    expect(find(REOPEN_UPDATE)?.params).toMatchObject({ AwaitingRole: "facilities", Status: "Work" });
  });

  it.each([["facilities"], ["accounts"], ["admin"]])("%s may not reopen: 403, refusal ledgered, nothing changed", async (role) => {
    auth.rolesForRequest.mockResolvedValue([role]);
    mockSql([APP_USER, JOB_BUILDING, job(), { match: REOPEN_UPDATE, rows: [{ JobID: 9 }] }]);

    const res = await reopen({ Reason: "Because" });

    expect(res).toMatchObject({ jsonBody: { code: "role_not_permitted" }, status: 403 });
    expect(find(REOPEN_UPDATE)).toBeUndefined();
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: expect.objectContaining({ attempted: "job.reopen" }), ruleApplied: "role_not_permitted" }),
    ]);
  });

  it("a reason is required", async () => {
    mockSql([APP_USER, JOB_BUILDING, job(), { match: REOPEN_UPDATE, rows: [{ JobID: 9 }] }]);
    for (const Reason of [undefined, "", "   "]) {
      const res = await reopen({ Reason });
      expect(res.status).toBe(422);
      expect(res.jsonBody).toMatchObject({ code: "reason_required" });
    }
    expect(find(REOPEN_UPDATE)).toBeUndefined();
  });

  it("only a done job can be reopened", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Work", AwaitingRole: "facilities" }), { match: REOPEN_UPDATE, rows: [{ JobID: 9 }] }]);
    expect(await reopen({ Reason: "x" })).toMatchObject({ jsonBody: { code: "not_done" }, status: 422 });
  });

  it("answers 404 for a job that doesn't exist", async () => {
    mockSql([APP_USER, JOB_BUILDING]);
    expect((await reopen({ Reason: "x" })).status).toBe(404);
  });

  it("answers 409 when the job changed underneath", async () => {
    mockSql([APP_USER, JOB_BUILDING, job(), { match: REOPEN_UPDATE, rows: [] }]);
    expect((await reopen({ Reason: "x" })).status).toBe(409);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});

describe("closeJobWhenInvoicesPaid (INVOICE_PAID, for the MYOB read-back)", () => {
  const atAccounts = job({ Status: "Awaiting Approval" });
  const paidInvoice = { Amount: 4000, Direction: "incoming", MyobCreatedAt: new Date("2026-10-10T00:00:00Z"), PaidAmount: 4000, Status: "approved" };
  const SYSTEM_MOVE = /UPDATE Jobs\s+SET Status = @Status,[\s\S]*WHERE JobID = @JobID\s+AND Status = @ExpectedFromStatus/;
  const PAID = [{ invoiceId: 3, paidAt: new Date("2026-10-13T23:30:00Z") }];

  it("closes the job when every incoming invoice is paid, as the system, with the paid dates", async () => {
    mockSql([JOB_BUILDING, atAccounts, { match: INVOICES, rows: [paidInvoice] }, { match: /SELECT Status, AwaitingRole FROM Jobs WHERE JobID/, rows: [{ AwaitingRole: "accounts", Status: "Awaiting Approval" }] }]);

    const result = await closeJobWhenInvoicesPaid({}, 9, { paid: PAID, source: "myobReadBack" });

    expect(result).toEqual({ closed: true });
    expect(find(SYSTEM_MOVE)?.params).toMatchObject({ Status: "Done" });
    expect(find(/INSERT INTO JobEvents/)?.params).toMatchObject({
      CreatedBy: "System (myobReadBack)",
      NewStatus: "Done",
      Text: "All invoices paid (invoice 3 paid 14/10/2026) — job done.",
    });
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "job.invoices_paid",
        actorKind: "system",
        actorName: "myobReadBack",
        after: { paid: [{ invoiceId: 3, paidAt: "2026-10-13T23:30:00.000Z" }], status: "Done" },
        jobId: 9,
        subjectType: "job",
      }),
    ]);
  });

  it("does nothing while an invoice is unpaid", async () => {
    mockSql([JOB_BUILDING, atAccounts, { match: INVOICES, rows: [paidInvoice, { ...paidInvoice, PaidAmount: 1000 }] }]);

    expect(await closeJobWhenInvoicesPaid({}, 9, { paid: PAID, source: "myobReadBack" })).toEqual({ closed: false, code: "invoices_not_paid" });
    expect(find(SYSTEM_MOVE)).toBeUndefined();
    expect(ledgerInserts(db.executeQuery)).toEqual([]);
  });

  it("does nothing for a job that isn't waiting on accounts", async () => {
    mockSql([JOB_BUILDING, job({ AwaitingRole: "facilities", Status: "Work" }), { match: INVOICES, rows: [paidInvoice] }]);
    expect(await closeJobWhenInvoicesPaid({}, 9, { paid: PAID, source: "myobReadBack" })).toEqual({ closed: false, code: "illegal" });
  });
});
