/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

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
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    rolesForRequest: jest.fn().mockResolvedValue(["director"]),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({
      email: "johanne@randazzo.properties",
      name: "Johanne CFO",
      oid: "cfo-oid",
    }),
  };
});

jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn() }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../jobPlannerSync", () => ({
  syncJobActionTriggersStandalone: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../email/director-emails", () => ({
  sendDirectorApprovalEmail: jest.fn().mockResolvedValue({
    sentAt: new Date("2026-10-13T00:00:00Z"),
    sentTo: ["carlo@randazzo.properties"],
  }),
}));

const db = require("../db") as { executeQuery: jest.Mock };
const auth = require("../auth") as { rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const limitsDb = require("../approval-limits-db") as { getCachedApprovalLimits: jest.Mock };
const directorEmails = require("../email/director-emails") as { sendDirectorApprovalEmail: jest.Mock };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: unknown }>;
// invoices.ts registers its handlers through app.http() without exporting them;
// the mocked app.http captures them by name.
require("./invoices");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const registered = (name: string): Handler => {
  const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!hit) throw new Error(`handler ${name} not registered`);
  return (hit[1] as { handler: Handler }).handler;
};

const HANDLERS = {
  approveJobInvoice: registered("approveJobInvoice"),
  directorApproveJobInvoice: registered("directorApproveJobInvoice"),
  markJobInvoiceMyobCreated: registered("markJobInvoiceMyobCreated"),
  rejectJobInvoice: registered("rejectJobInvoice"),
  resendDirectorInvoiceEmail: registered("resendDirectorInvoiceEmail"),
};

type SqlRoute = [RegExp, Record<string, unknown>[]];

function routeSql(routes: SqlRoute[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    const hit = routes.find(([re]) => re.test(sql));
    // The atomic send claim (UPDATE ... OUTPUT inserted.X AS Id) succeeds unless a test says otherwise.
    return hit ? hit[1] : /OUTPUT inserted\.\w+ AS Id/.test(sql) ? [{ Id: 1 }] : [];
  });
}

function calls(): { params: Record<string, unknown>; sql: string }[] {
  return db.executeQuery.mock.calls.map((c: unknown[]) => ({
    params: Object.fromEntries(
      ((c[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value]),
    ),
    sql: String(c[1]),
  }));
}

const callMatching = (re: RegExp) => calls().find((c) => re.test(c.sql));

// Nothing a handler writes may carry the forged name from the request body.
function expectNoForgedName(): void {
  const allValues = calls().flatMap((c) => Object.values(c.params));
  expect(allValues).not.toContain("Someone Else");
}

function makeRequest(body: unknown): HttpRequest {
  return {
    headers: { get: () => null },
    json: jest.fn().mockResolvedValue(body),
    query: new URLSearchParams(),
  } as unknown as HttpRequest;
}

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const storedInvoice: SqlRoute = [/JobInvoiceID, JobID, InvoiceNumber, Seq/, [{ JobInvoiceID: 5, Status: "approved" }]];
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

beforeEach(() => {
  jest.clearAllMocks();
  auth.rolesForRequest.mockResolvedValue(["director"]);
  limitsDb.getCachedApprovalLimits.mockResolvedValue([
    { MaxApprovalAmount: 1000, RoleName: "accounts_manager" },
    { MaxApprovalAmount: null, RoleName: "director" },
  ]);
});

describe("approveJobInvoice", () => {
  const invoiceRow: SqlRoute = [
    /SELECT JobID, InvoiceNumber, Amount, Direction/,
    [{ Amount: 500, Direction: "incoming", InvoiceNumber: "IV-9-1", JobID: 9, Status: "pending" }],
  ];

  it("records the token's name and ignores ApprovedBy in the body", async () => {
    routeSql([invoiceRow, storedInvoice]);

    const res = await HANDLERS.approveJobInvoice(makeRequest({ ApprovedBy: "Someone Else", JobInvoiceID: 5 }), ctx);

    expect(res.status).toBe(200);
    expect(callMatching(/UPDATE JobInvoices\s+SET Status = @Status/)?.params.ApprovedBy).toBe("Johanne CFO");
    expect(callMatching(/INSERT INTO JobEvents/)?.params.CreatedBy).toBe("Johanne CFO");
    expectNoForgedName();
  });

  it("stamps the director email trigger and SentBy with the token's name", async () => {
    auth.rolesForRequest.mockResolvedValue(["accounts_manager"]);
    routeSql([
      [/SELECT JobID, InvoiceNumber, Amount, Direction/, [{ Amount: 5000, Direction: "incoming", InvoiceNumber: "IV-9-1", JobID: 9, Status: "pending" }]],
      storedInvoice,
    ]);

    await HANDLERS.approveJobInvoice(makeRequest({ ApprovedBy: "Someone Else", JobInvoiceID: 5 }), ctx);
    await flush();

    expect(directorEmails.sendDirectorApprovalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ triggeredBy: "Johanne CFO" }),
    );
    expect(callMatching(/DirectorEmailSentBy = @SentBy/)?.params.SentBy).toBe("Johanne CFO");
    expectNoForgedName();
  }, 30_000);

  it("401s without touching the database when the token has no verified identity", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await HANDLERS.approveJobInvoice(makeRequest({ ApprovedBy: "Someone Else", JobInvoiceID: 5 }), ctx);

    expect(res.status).toBe(401);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("directorApproveJobInvoice", () => {
  it("records the token's name and ignores ApprovedBy in the body", async () => {
    routeSql([
      [/SELECT JobID, InvoiceNumber, Status/, [{ InvoiceNumber: "IV-9-1", JobID: 9, Status: "approved" }]],
      storedInvoice,
    ]);

    const res = await HANDLERS.directorApproveJobInvoice(makeRequest({ ApprovedBy: "Someone Else", JobInvoiceID: 5 }), ctx);

    expect(res.status).toBe(200);
    expect(callMatching(/DirectorApprovedBy = @ApprovedBy/)?.params.ApprovedBy).toBe("Johanne CFO");
    expect(callMatching(/INSERT INTO JobEvents/)?.params.CreatedBy).toBe("Johanne CFO");
    expectNoForgedName();
  });

  it("401s when the token has no verified identity", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await HANDLERS.directorApproveJobInvoice(makeRequest({ JobInvoiceID: 5 }), ctx);

    expect(res.status).toBe(401);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("rejectJobInvoice", () => {
  it("records the token's name and ignores RejectedBy in the body", async () => {
    routeSql([
      [/SELECT JobID, InvoiceNumber, Status/, [{ InvoiceNumber: "IV-9-1", JobID: 9 }]],
      storedInvoice,
    ]);

    const res = await HANDLERS.rejectJobInvoice(makeRequest({ JobInvoiceID: 5, RejectedBy: "Someone Else" }), ctx);

    expect(res.status).toBe(200);
    expect(callMatching(/INSERT INTO JobEvents/)?.params.CreatedBy).toBe("Johanne CFO");
    expectNoForgedName();
  });

  it("401s when the token has no verified identity", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await HANDLERS.rejectJobInvoice(makeRequest({ JobInvoiceID: 5 }), ctx);

    expect(res.status).toBe(401);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("markJobInvoiceMyobCreated", () => {
  it("records the token's name and ignores CreatedBy in the body", async () => {
    routeSql([
      [/SELECT JobID, InvoiceNumber, Status, Amount/, [{ Amount: 500, InvoiceNumber: "IV-9-1", JobID: 9, Status: "approved" }]],
      storedInvoice,
    ]);

    const res = await HANDLERS.markJobInvoiceMyobCreated(makeRequest({ CreatedBy: "Someone Else", JobInvoiceID: 5 }), ctx);

    expect(res.status).toBe(200);
    expect(callMatching(/MyobCreatedBy = @CreatedBy/)?.params.CreatedBy).toBe("Johanne CFO");
    expect(callMatching(/INSERT INTO JobEvents/)?.params.CreatedBy).toBe("Johanne CFO");
    expectNoForgedName();
  });
});

describe("resendDirectorInvoiceEmail", () => {
  it("uses the token's name for triggeredBy and DirectorEmailSentBy, ignoring TriggeredBy", async () => {
    routeSql([
      [/SELECT JobID, Amount, Status, InvoiceNumber/, [{ Amount: 5000, JobID: 9, Status: "approved" }]],
      storedInvoice,
    ]);

    const res = await HANDLERS.resendDirectorInvoiceEmail(makeRequest({ JobInvoiceID: 5, TriggeredBy: "Someone Else" }), ctx);

    expect(res.status).toBe(200);
    expect(directorEmails.sendDirectorApprovalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ triggeredBy: "Johanne CFO" }),
    );
    expect(callMatching(/DirectorEmailSentBy = @SentBy/)?.params.SentBy).toBe("Johanne CFO");
    expectNoForgedName();
  });

  it("says 'Not sent: test record' (409) for a test job and stamps nothing (D9)", async () => {
    routeSql([[/SELECT JobID, Amount, Status, InvoiceNumber/, [{ Amount: 5000, JobID: 9, Status: "approved" }]]]);
    const { TestDataEgressError } = jest.requireActual("../test-data") as typeof import("../test-data");
    directorEmails.sendDirectorApprovalEmail.mockRejectedValueOnce(new TestDataEgressError("email"));

    const res = await HANDLERS.resendDirectorInvoiceEmail(makeRequest({ JobInvoiceID: 5 }), ctx);

    expect(res).toEqual({ jsonBody: { code: "TEST_RECORD", error: "Not sent: test record" }, status: 409 });
    expect(callMatching(/DirectorEmailSentBy/)).toBeUndefined();
  });
});
