/// <reference types="jest" />
// J3 review: email intake is where most real quotes and invoices arrive, so it
// keeps the typed paths' rules. A promoted quote or invoice is stored as added
// by the signed-in person's name (what separation of duties compares), needs
// an amount above $0, and lands only on a job that takes money records, read
// under lock in the record's own transaction. A refused promote is ledgered.
// DB mocked; the real ledger runs.
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
jest.mock("../blob-storage", () => ({ generateReadSasUrl: jest.fn() }));
jest.mock("../graph", () => ({ graphFetchEmails: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn() }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn() }));

const auth = require("../auth") as { requireRole: jest.Mock; rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };
type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
const { promoteEmailToInvoice, promoteEmailToQuote } = require("./emails") as { promoteEmailToInvoice: Handler; promoteEmailToQuote: Handler };

type Route = { match: RegExp; rows?: Record<string, unknown>[] };
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => routes.find((r) => r.match.test(sql))?.rows ?? []);
}
const calls = () =>
  db.executeQuery.mock.calls.map((c: unknown[], i: number) => ({
    order: db.executeQuery.mock.invocationCallOrder[i],
    params: Object.fromEntries(((c[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value])),
    sql: String(c[1]),
  }));
const find = (re: RegExp) => calls().find((c) => re.test(c.sql));
function makeRequest(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const CALLER = { email: "fran@example.com", name: "Fran Manager", oid: "fran-oid" };
const APP_USER: Route = { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 21 }] };
const JOB_BUILDING: Route = { match: /SELECT BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5 }] };
const MONEY_JOB = /SELECT j\.JobID, j\.Status, j\.IsInternal, j\.IsArchived/;
const job = (over: Record<string, unknown> = {}): Route => ({
  match: MONEY_JOB,
  rows: [{ BuildingID: 5, HasApprovedQuote: 0, IsArchived: false, IsContract: false, IsInternal: false, JobID: 9, Status: "Awaiting Approval", ...over }],
});
const EMAIL: Route = {
  match: /SELECT EmailID, MatchedJobID, ReceivedAt, AIClassification FROM Emails/,
  rows: [{ AIClassification: "quote", EmailID: 42, MatchedJobID: 9, ReceivedAt: new Date("2026-10-10T00:00:00Z") }],
};
const QUOTE_INSERT: Route = { match: /INSERT INTO Quotes/, rows: [{ QuoteID: 7 }] };
const INVOICE_INSERT: Route = { match: /INSERT INTO JobInvoices/, rows: [{ JobInvoiceID: 5 }] };
const wrote = (re: RegExp) => calls().some((c) => re.test(c.sql));

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  auth.requireRole.mockResolvedValue(null);
  auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
  auth.verifiedIdentityFromRequest.mockResolvedValue(CALLER);
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  db.createRequestConnection.mockResolvedValue({ id: "connection" });
});

afterEach(() => jest.restoreAllMocks());

describe.each([
  ["promoteEmailToQuote", () => promoteEmailToQuote, QUOTE_INSERT, /INSERT INTO Quotes/, "quote.create"],
  ["promoteEmailToInvoice", () => promoteEmailToInvoice, INVOICE_INSERT, /INSERT INTO JobInvoices/, "invoice.create"],
] as const)("%s keeps the typed paths' rules", (_name, handler, inserted, INSERT, attempted) => {
  const promote = (body: Record<string, unknown> = {}) => handler()(makeRequest({ Amount: 500, ContractorName: "Acme", EmailID: 42, JobID: 9, ...body }), ctx);

  it("stores who added it by name, so the person who promoted it can't approve it themselves", async () => {
    mockSql([APP_USER, EMAIL, job(), inserted]);

    expect((await promote({ CreatedBy: "Someone Else" })).status).toBe(200);
    expect(find(INSERT)?.params.CreatedBy).toBe("Fran Manager");
    expect(calls().flatMap((c) => Object.values(c.params))).not.toContain("fran-oid");
  });

  it.each([[undefined], [null], [0]])("refuses an amount of %p with 422, writing nothing", async (Amount) => {
    mockSql([APP_USER, EMAIL, job(), inserted]);

    expect(await promote({ Amount })).toMatchObject({ jsonBody: { code: "amount_invalid" }, status: 422 });
    expect(wrote(INSERT)).toBe(false);
    expect(wrote(/UPDATE Emails/)).toBe(false);
  });

  it.each([
    ["an internal job", { IsInternal: true }, 422, "internal_job"],
    ["an admin job", { Kind: "admin" }, 422, "admin_is_internal"],
    ["a done job", { Status: "Done" }, 409, "job_done"],
    ["an archived job", { IsArchived: true }, 409, "job_archived"],
  ])("refuses %s, writing nothing, and ledgers the refused attempt", async (_label, over, status, code) => {
    mockSql([APP_USER, JOB_BUILDING, EMAIL, job(over), inserted]);

    expect(await promote()).toMatchObject({ jsonBody: { code }, status });
    expect(wrote(INSERT)).toBe(false);
    expect(wrote(/UPDATE Emails/)).toBe(false);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: expect.objectContaining({ attempted }), jobId: 9, ruleApplied: code, subjectId: "9", subjectType: "job" }),
    ]);
  });

  it("reads the job under lock inside the record's transaction, then writes and commits", async () => {
    mockSql([APP_USER, EMAIL, job(), inserted]);

    await promote();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    expect(find(MONEY_JOB)!.order).toBeGreaterThan(begun);
    expect(find(INSERT)!.order).toBeGreaterThan(find(MONEY_JOB)!.order);
    expect(find(/UPDATE Emails/)!.order).toBeLessThan(committed);
  });

  it("404s a job that doesn't exist, writing nothing", async () => {
    mockSql([APP_USER, EMAIL, inserted]);
    expect((await promote()).status).toBe(404);
    expect(wrote(INSERT)).toBe(false);
  });
});

describe("promoteEmailToInvoice: an emailed invoice is a contractor's (incoming)", () => {
  it("is refused on a done job: decision 18 lets only outgoing invoices through", async () => {
    mockSql([APP_USER, JOB_BUILDING, job({ Status: "Done" }), INVOICE_INSERT]);
    const res = await promoteEmailToInvoice(makeRequest({ Amount: 500, EmailID: 42, JobID: 9 }), ctx);
    expect(res).toMatchObject({ jsonBody: { code: "job_done" }, status: 409 });
  });
});
