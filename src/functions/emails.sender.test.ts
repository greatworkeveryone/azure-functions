/// <reference types="jest" />
// SECS-02: an email whose sender was not authenticated, or is not the contractor's
// address on record, becomes a quote or invoice only when the person promoting
// confirms they checked another way. The fact is stored on the record. DB mocked.
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
let emailRow: Record<string, unknown>;
let contractorAddress: string | null;
const GOOD = { AIClassification: "quote", EmailID: 42, FromAddress: "Accounts@Acme.example", MatchedJobID: 9, ReceivedAt: new Date("2026-10-10T00:00:00Z"), SenderAuthenticated: true, Source: "graph" };

const params = (re: RegExp) => {
  const call = db.executeQuery.mock.calls.find((c: unknown[]) => re.test(String(c[1])));
  return call ? Object.fromEntries((call[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value])) : undefined;
};
const wrote = () => db.executeQuery.mock.calls.some((c: unknown[]) => /INSERT INTO (Quotes|JobInvoices)|UPDATE Emails/.test(String(c[1])));

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  emailRow = { ...GOOD };
  contractorAddress = "accounts@acme.example";
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (MONEY_JOB.test(sql)) return [{ BuildingID: 5, HasApprovedQuote: 0, IsArchived: false, IsContract: false, IsInternal: false, JobID: 9, Status: "Quote" }];
    if (/FROM Emails WHERE EmailID/.test(sql)) return [emailRow];
    if (/SELECT EmailAddress FROM dbo\.Contractors/.test(sql)) return contractorAddress ? [{ EmailAddress: contractorAddress }] : [];
    if (/SELECT ContractorName FROM dbo\.Contractors/.test(sql)) return [{ ContractorName: "Acme" }];
    if (/INSERT INTO Quotes/.test(sql)) return [{ QuoteID: 7 }];
    if (/INSERT INTO JobInvoices/.test(sql)) return [{ JobInvoiceID: 5 }];
    return [];
  });
});

const quote = (extra: Record<string, unknown> = {}) => promoteEmailToQuote(makeRequest({ Amount: 500, ContractorID: 3, ContractorName: "Acme", EmailID: 42, JobID: 9, ...extra }), ctx);
const invoice = (extra: Record<string, unknown> = {}) => promoteEmailToInvoice(makeRequest({ Amount: 500, ContractorID: 3, ContractorName: "Acme", EmailID: 42, JobID: 9, ...extra }), ctx);

describe.each([
  ["quote", quote, /INSERT INTO Quotes/],
  ["invoice", invoice, /INSERT INTO JobInvoices/],
] as const)("promoting an email to a %s", (_name, promote, insert) => {
  it("records a verified sender without asking anyone", async () => {
    const res = await promote();
    expect(res.status).toBe(200);
    expect(params(insert)).toMatchObject({ SenderAddress: "accounts@acme.example", SenderCheck: "verified", SenderConfirmedAt: null, SenderConfirmedBy: null });
  });

  it("refuses mail that was not authenticated, writing nothing", async () => {
    emailRow = { ...GOOD, SenderAuthenticated: false };
    const res = await promote();
    expect(res.status).toBe(422);
    expect(res.jsonBody).toMatchObject({ code: "sender_unverified", senderCheck: "unverified" });
    expect(wrote()).toBe(false);
    expect(advanceJobStatus).not.toHaveBeenCalled();
  });

  it("treats a row filed through the ingest endpoint as unverified even if it says authenticated", async () => {
    emailRow = { ...GOOD, Source: "ingest" };
    expect((await promote()).status).toBe(422);
  });

  it("refuses authenticated mail from an address that is not the contractor's on record", async () => {
    emailRow = { ...GOOD, FromAddress: "billing@other.example" };
    const res = await promote();
    expect(res.status).toBe(422);
    expect(res.jsonBody).toMatchObject({ code: "sender_unverified", senderCheck: "mismatch" });
    expect(wrote()).toBe(false);
  });

  it("keeps who confirmed an unverified sender, and when, on the record", async () => {
    emailRow = { ...GOOD, SenderAuthenticated: false };
    const res = await promote({ confirmUnverifiedSender: true });
    expect(res.status).toBe(200);
    expect(params(insert)).toMatchObject({ SenderCheck: "unverified", SenderConfirmedBy: "Fran Manager" });
    expect(params(insert)?.SenderConfirmedAt).toBeInstanceOf(Date);
  });

  it("keeps an address mismatch as such when it is confirmed", async () => {
    emailRow = { ...GOOD, FromAddress: "billing@other.example" };
    await promote({ confirmUnverifiedSender: true });
    expect(params(insert)).toMatchObject({ SenderAddress: "billing@other.example", SenderCheck: "mismatch", SenderConfirmedBy: "Fran Manager" });
  });

  it("does not take a truthy string as the confirmation", async () => {
    emailRow = { ...GOOD, SenderAuthenticated: false };
    expect((await promote({ confirmUnverifiedSender: "true" })).status).toBe(422);
  });

  it("has nothing to compare when the contractor has no address on record, and an authenticated sender stands", async () => {
    contractorAddress = null;
    expect((await promote()).status).toBe(200);
  });
});
