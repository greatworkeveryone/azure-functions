/// <reference types="jest" />
// J2: the transition guard is enforced server-side. Every former bypass of
// spend authority answers 422 (403 for a role) with the sentence the frontend
// shows, and writes nothing: Work without an approved quote (JB1), Done
// without approved, MYOB-marked invoices (JB1), AwaitingRole written raw (N1),
// the internal-flag chain (N4), anything out of Done. The DB layer is mocked.
import { HttpRequest, InvocationContext } from "@azure/functions";

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
const registered = (name: string): Handler => {
  const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!hit) throw new Error(`handler ${name} not registered`);
  return (hit[1] as { handler: Handler }).handler;
};
const addJobEvent = registered("addJobEvent");
const upsertJob = registered("upsertJob");

type Route = { match: RegExp; rows?: Record<string, unknown>[] };
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => routes.find((r) => r.match.test(sql))?.rows ?? []);
}
const calls = (): { order: number; params: Record<string, unknown>; sql: string }[] =>
  db.executeQuery.mock.calls.map((c: unknown[], i: number) => ({
    order: db.executeQuery.mock.invocationCallOrder[i],
    params: Object.fromEntries(((c[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value])),
    sql: String(c[1]),
  }));
const find = (re: RegExp) => calls().find((c) => re.test(c.sql));
const wroteAnything = (): boolean => calls().some((c) => /^\s*(INSERT|UPDATE|MERGE|DELETE)\b/i.test(c.sql));
function makeRequest(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const JOB_LOCK = /FROM Jobs j WITH \(UPDLOCK, HOLDLOCK\)\s+WHERE j\.JobID = @JobID/;
const INVOICES = /FROM JobInvoices i\s+WHERE i\.JobID = @JobID/;
const EVENT_INSERT = /INSERT INTO JobEvents \(\s*JobID, CreatedBy, \[Text\], NewStatus/;
const GUARDED_UPDATE = /UPDATE Jobs SET [\s\S]*OUTPUT INSERTED\.JobID\s+WHERE JobID = @JobID AND Status = @ExpectedStatus/;

function job(over: Record<string, unknown> = {}): Route {
  return {
    match: JOB_LOCK,
    rows: [{
      AwaitingRole: "facilities", BuildingID: 5, HasApprovedQuote: 0, HasMoneyRecords: 0, HasQuote: 1, IsContract: false,
      IsInternal: false, PreBlockAwaitingRole: null, PreBlockStatus: null, Status: "Awaiting Approval", ...over,
    }],
  };
}
const invoice = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  Amount: 4000, Direction: "incoming", MyobCreatedAt: new Date("2026-10-10T00:00:00Z"), PaidAmount: 0, Status: "approved", ...over,
});
const invoices = (...rows: Record<string, unknown>[]): Route => ({ match: INVOICES, rows });
const ACCEPTS: Route[] = [
  { match: EVENT_INSERT, rows: [{ JobEventID: 77 }] },
  { match: GUARDED_UPDATE, rows: [{ JobID: 9 }] },
];
// J3: the invoice an entry names is on the entry's job.
const ON_JOB: Route = { match: /AS QuoteOnJob/, rows: [{ InvoiceOnJob: 1, PurchaseOrderOnJob: 1, QuoteOnJob: 1 }] };
const event = (body: Record<string, unknown>) => addJobEvent(makeRequest({ JobID: 9, ...body }), ctx);

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  auth.requireRole.mockResolvedValue(null);
  auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
  auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "fran@example.com", name: "Fran Manager", oid: "fran-oid" });
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  db.createRequestConnection.mockResolvedValue({ id: "connection" });
  limitsDb.getCachedApprovalLimits.mockResolvedValue([
    { MaxApprovalAmount: 5000, RoleName: "accounts" },
    { MaxApprovalAmount: 20000, RoleName: "accounts_manager" },
    { MaxApprovalAmount: null, RoleName: "director" },
  ]);
});

describe("addJobEvent: the transition guard", () => {
  it("JB1: Work without an approved quote is 422 with the reason, and nothing is written", async () => {
    mockSql([job(), invoices(), ...ACCEPTS]);

    const res = await event({ NewStatus: "Work", Text: "Starting" });

    expect(res.status).toBe(422);
    expect(res.jsonBody).toMatchObject({
      code: "quote_not_approved",
      error: "Work starts once a quote is approved (or on a contract or internal job).",
      from: "Awaiting Approval",
      to: "Work",
    });
    expect(wroteAnything()).toBe(false);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("Work with an approved quote moves the job, through an update predicated on the state it read", async () => {
    mockSql([job({ HasApprovedQuote: 1 }), invoices(), ...ACCEPTS]);

    const res = await event({ NewStatus: "Work" });

    expect(res.status).toBe(200);
    expect(find(GUARDED_UPDATE)?.params).toMatchObject({
      AwaitingRoleMirror: "facilities",
      ExpectedAwaitingRole: "facilities",
      ExpectedStatus: "Awaiting Approval",
      Status: "Work",
    });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("reads the job inside the transaction, locked, before deciding", async () => {
    mockSql([job({ HasApprovedQuote: 1 }), invoices(), ...ACCEPTS]);

    await event({ NewStatus: "Work" });

    expect(find(JOB_LOCK)?.order).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
  });

  it("answers 409 and keeps nothing when the job moved between the read and the write", async () => {
    mockSql([job({ HasApprovedQuote: 1 }), invoices(), { match: EVENT_INSERT, rows: [{ JobEventID: 77 }] }, { match: GUARDED_UPDATE, rows: [] }]);

    const res = await event({ NewStatus: "Work" });

    expect(res.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  describe("JB1: closing a job needs its invoices approved and in MYOB", () => {
    const atAccounts = job({ AwaitingRole: "accounts", HasApprovedQuote: 1 });

    it("no invoice: 422 invoice_missing", async () => {
      mockSql([atAccounts, invoices(), ...ACCEPTS]);
      const res = await event({ NewStatus: "Done" });
      expect(res).toMatchObject({ jsonBody: { code: "invoice_missing" }, status: 422 });
      expect(wroteAnything()).toBe(false);
    });

    it("an invoice still awaiting approval: 422 invoice_not_approved", async () => {
      mockSql([atAccounts, invoices(invoice({ Status: "pending" })), ...ACCEPTS]);
      expect(await event({ NewStatus: "Done" })).toMatchObject({ jsonBody: { code: "invoice_not_approved" }, status: 422 });
    });

    it("an invoice approved at stage 1 that still needs the director: 422 invoice_not_approved", async () => {
      mockSql([atAccounts, invoices(invoice({ Amount: 30000 })), ...ACCEPTS]);
      expect(await event({ NewStatus: "Done" })).toMatchObject({ jsonBody: { code: "invoice_not_approved" }, status: 422 });
    });

    it("an approved invoice not marked in MYOB: 422 invoice_not_in_myob", async () => {
      mockSql([atAccounts, invoices(invoice({ MyobCreatedAt: null })), ...ACCEPTS]);
      expect(await event({ NewStatus: "Done" })).toMatchObject({ jsonBody: { code: "invoice_not_in_myob" }, status: 422 });
    });

    it("every invoice approved (director included) and in MYOB: Done", async () => {
      mockSql([atAccounts, invoices(invoice(), invoice({ Amount: 30000, Status: "director_approved" }), invoice({ Status: "rejected", MyobCreatedAt: null })), ON_JOB, ...ACCEPTS]);
      const res = await event({ NewStatus: "Done", InvoiceID: 3 });
      expect(res.status).toBe(200);
      expect(find(GUARDED_UPDATE)?.params).toMatchObject({ ExpectedStatus: "Awaiting Approval", Status: "Done" });
    });
  });

  it("an internal job finishes straight to Done with no invoice", async () => {
    mockSql([job({ IsInternal: true, Status: "Work" }), invoices(), ...ACCEPTS]);
    expect((await event({ NewStatus: "Done", Text: "Job finished." })).status).toBe(200);
  });

  it("Done is final: any move out of it is 422 done_is_final", async () => {
    mockSql([job({ AwaitingRole: "accounts", Status: "Done" }), invoices(), ...ACCEPTS]);
    const res = await event({ NewStatus: "Tenant" });
    expect(res).toMatchObject({ jsonBody: { code: "done_is_final", error: "This job is done. A manager can reopen it, with a reason." }, status: 422 });
    expect(wroteAnything()).toBe(false);
  });

  it("plain facilities can still hold a job for the tenant and resume it", async () => {
    auth.rolesForRequest.mockResolvedValue(["facilities"]);
    mockSql([job(), invoices(), ...ACCEPTS]);
    expect((await event({ IsStalled: true, NewStatus: "Tenant", Text: "Waiting on tenant" })).status).toBe(200);
    expect(find(GUARDED_UPDATE)?.params).toMatchObject({ PreBlockStatus: "Awaiting Approval", Status: "Tenant" });

    db.executeQuery.mockClear();
    mockSql([job({ PreBlockAwaitingRole: "facilities", PreBlockStatus: "Awaiting Approval", Status: "Tenant" }), invoices(), ...ACCEPTS]);
    expect((await event({ NewStatus: "Work" })).status).toBe(200);
    expect(find(GUARDED_UPDATE)?.params).toMatchObject({ Status: "Awaiting Approval" });
  });

  it("a role with no job rights is 403 from the guard", async () => {
    auth.rolesForRequest.mockResolvedValue(["user"]);
    mockSql([job(), invoices(), ...ACCEPTS]);
    expect(await event({ NewStatus: "Tenant" })).toMatchObject({ jsonBody: { code: "role_not_permitted" }, status: 403 });
  });

  it("N1: AwaitingRole is never written from a request, with or without a status", async () => {
    mockSql([job(), invoices(), ...ACCEPTS]);
    for (const body of [{ NewAwaitingRole: "accounts" }, { NewAwaitingRole: "accounts", NewStatus: "Tenant" }]) {
      const res = await event(body);
      expect(res).toMatchObject({ jsonBody: { code: "awaiting_role_derived" }, status: 422 });
    }
    expect(wroteAnything()).toBe(false);
  });

  it("a note with no status change is written as before, without the guard", async () => {
    mockSql([...ACCEPTS]);
    const res = await event({ Text: "Spoke to the tenant" });
    expect(res.status).toBe(200);
    expect(find(JOB_LOCK)).toBeUndefined();
    expect(find(/UPDATE Jobs SET LastModifiedDate=SYSUTCDATETIME\(\) WHERE JobID = @JobID$/)).toBeDefined();
  });
});

describe("upsertJob: contract and internal flags (N4)", () => {
  const PREVIOUS = /SELECT Status, AssignedTo, Kind, IsContract, IsInternal, Priority,[\s\S]*FROM Jobs WITH \(UPDLOCK, HOLDLOCK\) WHERE JobID = @JobID/;
  const previous = (over: Record<string, unknown> = {}): Route => ({
    match: PREVIOUS,
    rows: [{ AssignedTo: null, HasMoneyRecords: 0, IsContract: false, IsInternal: false, Kind: "facilities", Priority: "Normal", Status: "New", ...over }],
  });
  const UPDATED: Route = { match: /UPDATE Jobs SET [\s\S]*OUTPUT INSERTED\.JobID/, rows: [{ JobID: 9 }] };

  it("plain facilities can't create an internal or contract job", async () => {
    auth.rolesForRequest.mockResolvedValue(["facilities"]);
    for (const flag of ["IsInternal", "IsContract"]) {
      const res = await upsertJob(makeRequest({ BuildingID: 1, [flag]: true, Status: "New", Title: "Leak" }), ctx);
      expect(res).toMatchObject({ jsonBody: { code: "role_not_permitted" }, status: 403 });
    }
    expect(wroteAnything()).toBe(false);
  });

  it("plain facilities still creates an ordinary job", async () => {
    auth.rolesForRequest.mockResolvedValue(["facilities"]);
    mockSql([{ match: /INSERT INTO Jobs/, rows: [{ JobID: 9 }] }]);
    expect((await upsertJob(makeRequest({ BuildingID: 1, IsInternal: false, Status: "New", Title: "Leak" }), ctx)).status).toBe(200);
  });

  it("accounts can't flip a job to internal", async () => {
    auth.rolesForRequest.mockResolvedValue(["accounts"]);
    mockSql([previous(), UPDATED]);
    const res = await upsertJob(makeRequest({ IsInternal: true, JobID: 9 }), ctx);
    expect(res).toMatchObject({ jsonBody: { code: "role_not_permitted" }, status: 403 });
    expect(find(/UPDATE Jobs SET/)).toBeUndefined();
  });

  it("a manager can't flip internal once the job has a quote, PO or invoice", async () => {
    mockSql([previous({ HasMoneyRecords: 1 }), UPDATED]);
    const res = await upsertJob(makeRequest({ IsInternal: true, JobID: 9 }), ctx);
    expect(res).toMatchObject({ jsonBody: { code: "flag_frozen" }, status: 422 });
    expect(find(/UPDATE Jobs SET/)).toBeUndefined();
  });

  it("a manager flips internal on a job with no money records, and it is recorded", async () => {
    mockSql([previous(), UPDATED]);
    const res = await upsertJob(makeRequest({ IsInternal: true, JobID: 9 }), ctx);
    expect(res.status).toBe(200);
    expect(find(/INSERT INTO JobEvents[\s\S]*@EventType/)?.params).toMatchObject({ EventType: "internal_change" });
  });

  it("re-sending the flag a job already has is not a change", async () => {
    auth.rolesForRequest.mockResolvedValue(["facilities"]);
    mockSql([previous({ HasMoneyRecords: 1, IsInternal: false }), UPDATED]);
    expect((await upsertJob(makeRequest({ IsInternal: false, JobID: 9, Title: "Leak (kitchen)" }), ctx)).status).toBe(200);
  });
});
