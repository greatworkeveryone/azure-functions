/// <reference types="jest" />
// J3 carry-overs on the job handlers: a client writes only its own kinds of
// history entry (money, contractor, archive and flag entries are written by
// the handler that made the change); a quote, invoice or PO an entry names
// must be on that job; and a new job always starts with facilities, whatever
// the request says. Each refusal writes nothing. The DB layer is mocked.
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

const LINKS = /AS QuoteOnJob[\s\S]*AS InvoiceOnJob[\s\S]*AS PurchaseOrderOnJob/;
const links = (over: Record<string, unknown> = {}): Route => ({
  match: LINKS,
  rows: [{ InvoiceOnJob: 1, PurchaseOrderOnJob: 1, QuoteOnJob: 1, ...over }],
});

describe("addJobEvent: the kinds of entry a client may write", () => {
  it.each([
    "quote_added", "quote_approved", "quote_rejected", "invoice_added", "invoice_rejected", "invoice_myob_created",
    "po_generated", "po_sent", "po_completed", "payment_made", "contractor_requested", "archived", "unarchived",
    "assignment_change", "internal_change", "job_reopened", "made_up",
  ])("refuses %s: Floorplan writes that entry itself, when the change is made", async (type) => {
    mockSql([links(), ...ACCEPTS]);

    const res = await event({ EventType: type, Text: "x" });

    expect(res).toMatchObject({ jsonBody: { code: "event_type_not_allowed" }, status: 422 });
    expect(wroteAnything()).toBe(false);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it.each(["comment", "acknowledged", "status_change", "expected_date_change", "stalled_toggle", "creation", "onchargeable_change", "attachment_added"])(
    "accepts %s, which the screens write themselves",
    async (type) => {
      mockSql([links(), ...ACCEPTS]);

      const res = await event({ EventType: type, Text: "x" });

      expect(res.status).toBe(200);
      expect(find(EVENT_INSERT)?.params).toMatchObject({ EventType: type });
    },
  );

  it("an entry with no type (a plain note) is still fine", async () => {
    mockSql([...ACCEPTS]);
    expect((await event({ Text: "Spoke to the tenant" })).status).toBe(200);
  });
});

describe("addJobEvent: a record an entry names must be on that job", () => {
  it.each([
    ["QuoteID", { QuoteOnJob: 0 }, /quote/],
    ["InvoiceID", { InvoiceOnJob: 0 }, /invoice/],
    ["PurchaseOrderID", { PurchaseOrderOnJob: 0 }, /purchase order/],
  ])("refuses a %s from another job, writing nothing", async (field, over, words) => {
    mockSql([links(over), ...ACCEPTS]);

    const res = await event({ EventType: "attachment_added", [field]: 41, Text: "Attached a file" });

    expect(res).toMatchObject({ jsonBody: { code: "record_not_on_job" }, status: 422 });
    expect((res.jsonBody as { error: string }).error).toMatch(words);
    expect(wroteAnything()).toBe(false);
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });

  it("checks inside the event's transaction, against the event's job", async () => {
    mockSql([links(), ...ACCEPTS]);

    const res = await event({ EventType: "attachment_added", InvoiceID: 41, PurchaseOrderID: 42, QuoteID: 43, Text: "Attached" });

    expect(res.status).toBe(200);
    const check = find(LINKS);
    expect(check?.params).toMatchObject({ InvoiceID: 41, JobID: 9, PurchaseOrderID: 42, QuoteID: 43 });
    expect(check!.order).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
    expect(check!.order).toBeLessThan(find(EVENT_INSERT)!.order);
  });

  it("does not query at all when the entry names no record", async () => {
    mockSql([links(), ...ACCEPTS]);
    await event({ EventType: "comment", Text: "x" });
    expect(find(LINKS)).toBeUndefined();
  });

  it.each([["a string", "41"], ["zero", 0], ["a fraction", 4.5]])("refuses an id that is %s before touching the database", async (_label, id) => {
    const res = await event({ QuoteID: id, Text: "x" });
    expect(res.status).toBe(400);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("upsertJob: a new job always starts with facilities", () => {
  const INSERT: Route = { match: /INSERT INTO Jobs/, rows: [{ JobID: 9 }] };
  const create = (over: Record<string, unknown> = {}) =>
    upsertJob(makeRequest({ BuildingID: 1, Status: "New", Title: "Leak", ...over }), ctx);

  it.each(["accounts", "director", "contractor"])("refuses a request that starts it waiting on %s", async (role) => {
    mockSql([INSERT]);

    const res = await create({ AwaitingRole: role });

    expect(res).toMatchObject({ jsonBody: { code: "awaiting_role_derived" }, status: 422 });
    expect(wroteAnything()).toBe(false);
  });

  it.each([[undefined], [null], ["facilities"]])("writes facilities when the request says %s", async (role) => {
    mockSql([INSERT]);

    const res = await create(role === undefined ? {} : { AwaitingRole: role });

    expect(res.status).toBe(200);
    expect(find(/INSERT INTO Jobs/)?.params).toMatchObject({ AwaitingRole: "facilities" });
  });
});
