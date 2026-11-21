/// <reference types="jest" />
// S1-5 (13 Oct L6 / L16): an emailed quote or invoice is promoted onto a job
// the way a typed one is. The history entry and the job's move (quote received,
// work complete) are written in the same transaction as the record, and before
// it commits. DB and the status helper mocked.
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({ id: "connection" }),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "fran@example.com", name: "Fran Manager", oid: "fran-oid" }),
  };
});
jest.mock("../blob-storage", () => ({ generateReadSasUrl: jest.fn() }));
jest.mock("../graph", () => ({ graphFetchEmails: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn().mockResolvedValue({ advanced: true }) }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn() }));

const db = require("../db") as { commitTransaction: jest.Mock; executeQuery: jest.Mock };
const { advanceJobStatus } = require("../jobStatusHelpers") as { advanceJobStatus: jest.Mock };
type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
const { promoteEmailToInvoice, promoteEmailToQuote } = require("./emails") as { promoteEmailToInvoice: Handler; promoteEmailToQuote: Handler };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };

const makeRequest = (body: unknown): HttpRequest =>
  ({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() }) as unknown as HttpRequest;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const MONEY_JOB = /SELECT j\.JobID, j\.Status, j\.IsInternal, j\.IsArchived/;
const ROUTES: { match: RegExp; rows: Record<string, unknown>[] }[] = [
  { match: MONEY_JOB, rows: [{ BuildingID: 5, HasApprovedQuote: 0, IsArchived: false, IsContract: false, IsInternal: false, JobID: 9, Status: "Quote" }] },
  {
    match: /SELECT EmailID, (MatchedJobID, ReceivedAt, AIClassification, )?FromAddress/,
    rows: [{ AIClassification: "quote", EmailID: 42, FromAddress: "acme@acme.example", MatchedJobID: 9, ReceivedAt: new Date("2026-10-10T00:00:00Z"), SenderAuthenticated: true, Source: "graph" }],
  },
  { match: /SELECT EmailAddress FROM dbo\.Contractors/, rows: [{ EmailAddress: "acme@acme.example" }] },
  { match: /SELECT ContractorName FROM dbo\.Contractors/, rows: [{ ContractorName: "Acme" }] },
  { match: /INSERT INTO Quotes/, rows: [{ QuoteID: 7 }] },
  { match: /INSERT INTO JobInvoices/, rows: [{ JobInvoiceID: 5 }] },
];

const sqlCalls = () =>
  db.executeQuery.mock.calls.map((call: unknown[], index: number) => ({
    order: db.executeQuery.mock.invocationCallOrder[index],
    params: Object.fromEntries(((call[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value])),
    sql: String(call[1]),
  }));

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => ROUTES.find((r) => r.match.test(sql))?.rows ?? []);
});

describe("promoting an emailed quote", () => {
  it("writes the quote_added event and advances the job with QUOTE_RECEIVED before the transaction commits", async () => {
    const res = await promoteEmailToQuote(makeRequest({ Amount: 500, ContractorID: 3, ContractorName: "Acme", EmailID: 42, JobID: 9 }), ctx);

    expect(res.status).toBe(200);
    const event = sqlCalls().find((c: { sql: string }) => /INSERT INTO JobEvents/.test(c.sql) && /'quote_added'/.test(c.sql));
    expect(event?.params).toMatchObject({ CreatedBy: "Fran Manager", EmailID: 42, JobID: 9, QuoteID: 7 });
    expect(advanceJobStatus).toHaveBeenCalledTimes(1);
    expect(advanceJobStatus).toHaveBeenCalledWith({ id: "connection" }, 9, "QUOTE_RECEIVED", expect.objectContaining({ actor: "Fran Manager", quoteId: 7 }));
    expect(advanceJobStatus.mock.invocationCallOrder[0]).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
  });

  it("moves nothing when the quote is refused", async () => {
    const res = await promoteEmailToQuote(makeRequest({ Amount: 0, EmailID: 42, JobID: 9 }), ctx);

    expect(res.status).not.toBe(200);
    expect(advanceJobStatus).not.toHaveBeenCalled();
  });
});

describe("promoting an emailed invoice", () => {
  it("writes the invoice_added event and advances the job with WORK_COMPLETED before the transaction commits", async () => {
    const res = await promoteEmailToInvoice(makeRequest({ Amount: 500, ContractorID: 3, ContractorName: "Acme", EmailID: 42, JobID: 9 }), ctx);

    expect(res.status).toBe(200);
    const event = sqlCalls().find((c: { sql: string }) => /INSERT INTO JobEvents/.test(c.sql) && /'invoice_added'/.test(c.sql));
    expect(event?.params).toMatchObject({ CreatedBy: "Fran Manager", EmailID: 42, InvoiceID: 5, JobID: 9 });
    expect(advanceJobStatus).toHaveBeenCalledTimes(1);
    expect(advanceJobStatus).toHaveBeenCalledWith({ id: "connection" }, 9, "WORK_COMPLETED", expect.objectContaining({ actor: "Fran Manager", invoiceId: 5 }));
    expect(advanceJobStatus.mock.invocationCallOrder[0]).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
  });

  it("moves nothing when the invoice is refused", async () => {
    const res = await promoteEmailToInvoice(makeRequest({ Amount: 0, EmailID: 42, JobID: 9 }), ctx);

    expect(res.status).not.toBe(200);
    expect(advanceJobStatus).not.toHaveBeenCalled();
  });
});
