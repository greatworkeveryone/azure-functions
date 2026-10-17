/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HttpRequest, InvocationContext } from "@azure/functions";

// SEC-05: the baseline `user` tier reads no email and no job attachment, and
// the reviews-due widget gets a minimal projection instead of full tenant rows.
// Roles go through the real requireRole (dev role header, Development env).

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  buildUpdateSet: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../blob-storage", () => ({
  deleteBlob: jest.fn(),
  generateReadSasUrl: jest.fn().mockReturnValue("https://sas"),
  uploadBlob: jest.fn(),
}));
jest.mock("../graph", () => ({ graphFetchEmails: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }) }));
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn() }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../quote-decisions", () => ({ approveDirectorQuote: jest.fn(), rejectQuote: jest.fn() }));
jest.mock("../mybuildings-client", () => ({ uploadAttachment: jest.fn() }));
jest.mock("../ledger");
jest.mock("../ledger/actor", () => ({
  ...jest.requireActual("../ledger/actor"),
  resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Fay Facilities", role: "facilities", userId: 9 }),
}));

const db = require("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock; executeQuery: jest.Mock };
const ledger = require("../ledger") as { record: jest.Mock };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
require("../functions/emails");
require("../functions/attachments");
require("../functions/tenancy");

// Captured now: beforeEach's clearAllMocks wipes app.http's recorded calls.
const HANDLERS = new Map<string, Handler>(
  app.http.mock.calls.map((c: unknown[]) => [c[0] as string, (c[1] as { handler: Handler }).handler]),
);
const handler = (name: string): Handler => {
  const found = HANDLERS.get(name);
  if (!found) throw new Error(`handler ${name} not registered`);
  return found;
};

const jwt = (payload: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`;
const TOKEN = jwt({ name: "Fay Facilities", oid: "fay-oid", preferred_username: "fay@rp" });

function request(role: string, opts: { body?: unknown; query?: Record<string, string> } = {}): HttpRequest {
  const headers: Record<string, string> = { authorization: `Bearer ${TOKEN}`, "x-dev-roles": role };
  return {
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    json: jest.fn().mockResolvedValue(opts.body ?? {}),
    query: new URLSearchParams(opts.query ?? {}),
  } as unknown as HttpRequest;
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const saved = { env: process.env.AZURE_FUNCTIONS_ENVIRONMENT, flag: process.env.DEV_ROLE_OVERRIDE_ENABLED };
beforeAll(() => {
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
});
afterAll(() => {
  for (const [key, value] of [["AZURE_FUNCTIONS_ENVIRONMENT", saved.env], ["DEV_ROLE_OVERRIDE_ENABLED", saved.flag]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset().mockResolvedValue([]);
});

const EMAIL_AND_ATTACHMENT_READS: [string, { body?: unknown; query?: Record<string, string> }][] = [
  ["getEmails", {}],
  ["getEmail", { query: { emailId: "4" } }],
  ["getEmailThread", { query: { emailId: "4" } }],
  ["archiveEmail", { body: { EmailID: 4 } }],
  ["flagEmailForReview", { body: { EmailID: 4 } }],
  ["getAttachments", { query: { jobId: "12" } }],
  ["getPurchaseOrderAttachments", { query: { purchaseOrderId: "3" } }],
  ["getQuoteAttachments", { query: { quoteId: "3" } }],
];

describe("the user tier is refused email and attachment reads", () => {
  it.each(EMAIL_AND_ATTACHMENT_READS)("%s → 403 for user, before any query", async (name, opts) => {
    const res = await handler(name)(request("user", opts), ctx);
    expect(res.status).toBe(403);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it.each(EMAIL_AND_ATTACHMENT_READS)("%s still admits facilities", async (name, opts) => {
    const res = await handler(name)(request("facilities", opts), ctx);
    expect(res.status).not.toBe(403);
  });
});

describe("getReviewsDue", () => {
  const ROW = {
    TenantId: 31, BuildingId: 2, LegalName: "Acme Pty Ltd", TradingName: "Acme", Abn: "12345678901", Acn: "123456789",
    Status: "current", ReviewType: "cpi", NextReviewDate: new Date(Date.now() - 86_400_000), Expiry: new Date(Date.now() + 40 * 86_400_000),
    RentPerAnnum: 120000, SecurityDepositHeld: 30000, PrimaryContactName: "Pat", PrimaryContactEmail: "pat@acme", AccountsEmail: "ap@acme",
    Comments: "late payer",
  };

  it("returns only the widget's fields — no ABN, contacts or rent", async () => {
    db.executeQuery.mockResolvedValueOnce([ROW]);
    const res = await handler("getReviewsDue")(request("facilities"), ctx);

    expect(res.status).toBe(200);
    const [tenant] = res.jsonBody.tenants;
    expect(Object.keys(tenant).sort()).toEqual(
      ["buildingId", "daysToExpiry", "expiry", "legalName", "nextReviewDate", "optionNoticeMonths", "optionPeriods", "reviewState", "reviewType", "tenantId"],
    );
    expect(tenant).toMatchObject({ buildingId: 2, legalName: "Acme Pty Ltd", reviewState: "red", reviewType: "cpi", tenantId: 31 });
    expect(JSON.stringify(res.jsonBody)).not.toMatch(/12345678901|pat@acme|ap@acme|120000|late payer/);
  });
});

describe("archiveEmail", () => {
  it("ledgers email.archive with the actor in the same transaction as the archive", async () => {
    db.executeQuery.mockResolvedValueOnce([{ EmailID: 4, MatchedJobID: 12, PreviousStatus: "unread" }]);

    const res = await handler("archiveEmail")(request("facilities", { body: { EmailID: 4 } }), ctx);

    expect(res.status).toBe(200);
    expect(db.beginTransaction).toHaveBeenCalled();
    expect(ledger.record).toHaveBeenCalledWith({}, expect.objectContaining({
      action: "email.archive",
      actor: expect.objectContaining({ name: "Fay Facilities" }),
      after: { status: "archived" },
      before: { status: "unread" },
      jobId: 12,
      subject: { id: 4, type: "email" },
    }));
    expect(db.commitTransaction).toHaveBeenCalled();
  });

  it("stamps ArchivedBy and ArchivedAt on the email in the same transaction as the ledger row", async () => {
    db.executeQuery.mockResolvedValueOnce([{ EmailID: 4, MatchedJobID: null, PreviousStatus: "matched" }]);

    await handler("archiveEmail")(request("facilities", { body: { EmailID: 4, ArchivedBy: "Mallory" } }), ctx);

    const [, sql, params] = db.executeQuery.mock.calls[0] as [unknown, string, { name: string; value: unknown }[]];
    expect(sql).toMatch(/ArchivedAt = SYSUTCDATETIME\(\)/);
    expect(sql).toMatch(/ArchivedBy = @ArchivedBy/);
    expect(params.find((p) => p.name === "ArchivedBy")?.value).toBe("Fay Facilities");
    const order = (mock: jest.Mock) => mock.mock.invocationCallOrder[0];
    expect(order(db.beginTransaction)).toBeLessThan(db.executeQuery.mock.invocationCallOrder[0]);
    expect(db.executeQuery.mock.invocationCallOrder[0]).toBeLessThan(order(ledger.record));
    expect(order(ledger.record)).toBeLessThan(order(db.commitTransaction));
  });

  it("has migration 133 adding both columns, nullable and guarded", () => {
    const sql = readFileSync(join(__dirname, "..", "..", "migrations", "133_email_archive_columns.sql"), "utf8");
    expect(sql).toMatch(/IF COL_LENGTH\('dbo\.Emails', 'ArchivedBy'\) IS NULL\s+ALTER TABLE dbo\.Emails ADD ArchivedBy NVARCHAR\(256\) NULL;/);
    expect(sql).toMatch(/IF COL_LENGTH\('dbo\.Emails', 'ArchivedAt'\) IS NULL\s+ALTER TABLE dbo\.Emails ADD ArchivedAt DATETIME2 NULL;/);
  });

  it("returns 404 and ledgers nothing when the email does not exist", async () => {
    const res = await handler("archiveEmail")(request("facilities", { body: { EmailID: 404 } }), ctx);

    expect(res.status).toBe(404);
    expect(ledger.record).not.toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});
