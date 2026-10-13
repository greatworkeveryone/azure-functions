/// <reference types="jest" />
// Quote approvals, rejections and director approvals each write one decision-
// ledger row in the decision's own transaction (WP19b, PLAN §3.12). The DB layer
// is mocked and the real ledger and quote-decisions helpers run, so what is
// asserted is the INSERT record() really sends.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  buildUpdateSet: jest.fn(),
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
jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn() }));
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../jobPlannerSync", () => ({ syncJobActionTriggersStandalone: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../email/director-emails", () => ({ sendDirectorApprovalEmail: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

const auth = require("../auth") as {
  requireRole: jest.Mock;
  rolesForRequest: jest.Mock;
  verifiedIdentityFromRequest: jest.Mock;
};
const db = require("../db") as {
  beginTransaction: jest.Mock;
  closeConnection: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const limitsDb = require("../approval-limits-db") as { getCachedApprovalLimits: jest.Mock };
const statusHelpers = require("../jobStatusHelpers") as { advanceJobStatus: jest.Mock };
const planner = require("../planner") as { resolveActivePlannerTasks: jest.Mock };
const plannerSync = require("../jobPlannerSync") as { syncJobActionTriggersStandalone: jest.Mock };
const directorEmails = require("../email/director-emails") as { sendDirectorApprovalEmail: jest.Mock };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
const { directorApproveQuote, rejectQuote } = require("./quotes") as {
  directorApproveQuote: Handler;
  rejectQuote: Handler;
};
// approveQuote is registered, not exported. Capture it before clearAllMocks wipes app.http's calls.
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const approveQuote = (app.http.mock.calls.find((c: unknown[]) => c[0] === "approveQuote")?.[1] as { handler: Handler }).handler;

type Route = { match: RegExp; reject?: Error; rows?: Record<string, unknown>[] };

/** Answers each statement by shape; the first matching route wins, anything else returns no rows. */
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    const hit = routes.find((r) => r.match.test(sql));
    if (hit?.reject) throw hit.reject;
    return hit?.rows ?? [];
  });
}

const sqlCalls = (): { sql: string; order: number }[] =>
  db.executeQuery.mock.calls.map((c: unknown[], i: number) => ({
    order: db.executeQuery.mock.invocationCallOrder[i],
    sql: String(c[1]),
  }));
const orderOf = (re: RegExp): number => sqlCalls().find((c) => re.test(c.sql))?.order ?? -1;
const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

function makeRequest(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const CALLER = { email: "dana@example.com", name: "Dana Director", oid: "director-oid" };
const APP_USER: Route = { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 21 }] };
const JOB_BUILDING: Route = { match: /SELECT BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5 }] };
const LEDGER_FAILS: Route = { match: /INSERT INTO dbo\.DecisionLedger/, reject: new Error("ledger unavailable") };

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  auth.requireRole.mockResolvedValue(null);
  auth.verifiedIdentityFromRequest.mockResolvedValue(CALLER);
  auth.rolesForRequest.mockResolvedValue(["accounts_manager"]);
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  db.createRequestConnection.mockResolvedValue({ id: "connection" });
  limitsDb.getCachedApprovalLimits.mockResolvedValue([
    { MaxApprovalAmount: 100, RoleName: "facilities_manager" },
    { MaxApprovalAmount: 1000, RoleName: "accounts_manager" },
    { MaxApprovalAmount: null, RoleName: "director" },
  ]);
  directorEmails.sendDirectorApprovalEmail.mockResolvedValue({ sentAt: new Date("2026-10-13T00:00:00Z"), sentTo: ["d@example.com"] });
  mockSql([APP_USER, JOB_BUILDING]);
});

afterEach(() => jest.restoreAllMocks());

describe("approveQuote", () => {
  const quoteRow = (over: Record<string, unknown> = {}): Route => ({
    match: /SELECT JobID, QuoteNumber, ContractorName, Amount/,
    rows: [
      {
        Amount: 500,
        ContractorID: 3,
        ContractorName: "Acme",
        Currency: "AUD",
        JobID: 9,
        QuoteNumber: "QT-9-1",
        Status: "pending",
        ...over,
      },
    ],
  });
  const stored: Route = { match: /SELECT QuoteID FROM Quotes|SELECT\s+QuoteID, JobID/, rows: [{ QuoteID: 7 }] };
  const approve = () => approveQuote(makeRequest({ QuoteID: 7 }), ctx);

  it("within the caller's limit: approves, and writes one quote.approve row naming who, what, where and from what", async () => {
    mockSql([APP_USER, JOB_BUILDING, quoteRow(), stored]);

    const res = await approve();

    expect(res.status).toBe(200);
    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "quote.approve",
      actorKind: "user",
      actorName: "Dana Director",
      actorRole: "accounts_manager",
      actorUserId: 21,
      after: { amount: 500, contractorId: 3, contractorName: "Acme", currency: "AUD", quoteNumber: "QT-9-1", status: "approved" },
      attributedName: null,
      before: { status: "pending" },
      buildingId: 5,
      isException: false,
      jobId: 9,
      reason: null,
      ruleApplied: "own_authority",
      subjectId: "7",
      subjectType: "quote",
    });
  });

  it("past every other role's limit: lands awaiting the director, says why, and only then emails the director", async () => {
    mockSql([APP_USER, JOB_BUILDING, quoteRow({ Amount: 5000 }), stored]);

    const res = await approve();
    await flush();

    expect(res.status).toBe(200);
    const [row] = ledgerInserts(db.executeQuery);
    expect(row).toMatchObject({
      action: "quote.approve",
      after: { amount: 5000, status: "awaiting_director" },
      before: { status: "pending" },
      ruleApplied: "director_threshold",
    });
    expect(directorEmails.sendDirectorApprovalEmail).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction.mock.invocationCallOrder[0]).toBeLessThan(
      directorEmails.sendDirectorApprovalEmail.mock.invocationCallOrder[0],
    );
    expect(plannerSync.syncJobActionTriggersStandalone).toHaveBeenCalledWith(9, expect.any(Function));
  });

  it("beyond the caller's own limit but short of the director's: waits for someone senior, as over_limit", async () => {
    auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
    mockSql([APP_USER, JOB_BUILDING, quoteRow({ Amount: 800 }), stored]);

    await approve();

    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({
      after: { status: "awaiting_approval" },
      actorRole: "facilities_manager",
      ruleApplied: "over_limit",
    });
    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
  });

  it("records what the quote was before, when it was approved again", async () => {
    mockSql([APP_USER, JOB_BUILDING, quoteRow({ Status: "rejected" }), stored]);

    await approve();

    expect(ledgerInserts(db.executeQuery)[0].before).toEqual({ status: "rejected" });
  });

  it("does the approval's writes and the ledger row inside one transaction, then commits", async () => {
    mockSql([APP_USER, JOB_BUILDING, quoteRow(), stored]);

    await approve();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    for (const write of [/UPDATE Quotes\s+SET Status = @Status/, /UPDATE Jobs\s+SET ApprovedQuoteID/, /INSERT INTO JobEvents/, /INSERT INTO dbo\.DecisionLedger/]) {
      expect(orderOf(write)).toBeGreaterThan(begun);
      expect(orderOf(write)).toBeLessThan(committed);
    }
    expect(statusHelpers.advanceJobStatus.mock.invocationCallOrder[0]).toBeLessThan(committed);
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(statusHelpers.advanceJobStatus.mock.invocationCallOrder[0]);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("locks the quote row for the transaction, so the status it records as replaced is the one replaced", async () => {
    mockSql([APP_USER, JOB_BUILDING, quoteRow(), stored]);

    await approve();

    expect(sqlCalls().find((c) => /SELECT JobID, QuoteNumber, ContractorName, Amount/.test(c.sql))?.sql).toMatch(
      /FROM Quotes WITH \(UPDLOCK, HOLDLOCK\) WHERE QuoteID = @Id/,
    );
  });

  it("rolls the approval back when the ledger write fails: no ledger row, no decision", async () => {
    mockSql([APP_USER, JOB_BUILDING, quoteRow({ Amount: 5000 }), LEDGER_FAILS]);

    const res = await approve();
    await flush();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    // The writes ran inside the transaction that was rolled back.
    expect(orderOf(/UPDATE Quotes\s+SET Status = @Status/)).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
    expect(orderOf(/UPDATE Quotes\s+SET Status = @Status/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    // Nothing downstream of a decision that didn't happen.
    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
    expect(plannerSync.syncJobActionTriggersStandalone).not.toHaveBeenCalled();
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("rolls back, with no ledger row, when a write fails part-way through", async () => {
    mockSql([APP_USER, JOB_BUILDING, quoteRow(), { match: /INSERT INTO JobEvents/, reject: new Error("deadlock") }]);

    const res = await approve();

    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });

  it("404s an unknown quote, rolling back and writing no row", async () => {
    mockSql([APP_USER, JOB_BUILDING]);

    const res = await approve();

    expect(res.status).toBe(404);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });

  it("answers 401 and writes nothing when the ledger can't name who is approving", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(CALLER).mockResolvedValueOnce(null);
    mockSql([APP_USER, JOB_BUILDING, quoteRow(), stored]);

    const res = await approve();

    expect(res.status).toBe(401);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  describe("when the role gate says no", () => {
    const gate = { jsonBody: { details: "Required role: accounts_manager. Have: facilities", error: "Forbidden" }, status: 403 };

    beforeEach(() => {
      auth.requireRole.mockResolvedValue(gate);
      auth.rolesForRequest.mockResolvedValue(["facilities"]);
      mockSql([APP_USER, JOB_BUILDING, { match: /FROM Quotes s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] }]);
    });

    it("still answers with the gate's own 403, and records the refused attempt as `denied`", async () => {
      const res = await approve();

      expect(res).toBe(gate);
      const rows = ledgerInserts(db.executeQuery);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "denied",
        actorName: "Dana Director",
        actorRole: "facilities",
        before: { attempted: "quote.approve" },
        buildingId: 5,
        isException: true,
        jobId: 9,
        reason: "Required role: accounts_manager. Have: facilities",
        ruleApplied: "role_not_permitted",
        subjectId: "7",
        subjectType: "quote",
      });
      expect(db.commitTransaction).toHaveBeenCalledTimes(1);
      expect(sqlCalls().some((c) => /UPDATE Quotes/.test(c.sql))).toBe(false);
    });

    it("answers the same 403 even if the refusal can't be recorded", async () => {
      mockSql([APP_USER, JOB_BUILDING, { match: /FROM Quotes s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] }, LEDGER_FAILS]);

      const res = await approve();

      expect(res).toBe(gate);
    });
  });
});

describe("rejectQuote", () => {
  const quote = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    Amount: 500,
    ContractorID: 3,
    ContractorName: "Acme",
    Currency: "AUD",
    JobID: 9,
    QuoteID: 7,
    QuoteNumber: "QT-9-1",
    Status: "rejected",
    ...over,
  });
  const routes = (status: string): Route[] => [
    APP_USER,
    JOB_BUILDING,
    { match: /SELECT JobID, QuoteNumber, Status FROM Quotes/, rows: [{ JobID: 9, QuoteNumber: "QT-9-1", Status: status }] },
    { match: /UPDATE Quotes SET Status = 'rejected'/, rows: [{ QuoteID: 7 }] },
    { match: /SELECT\s+QuoteID, JobID/, rows: [quote()] },
  ];
  const reject = () => rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

  it("a plain rejection from pending: one quote.reject row, from pending to rejected", async () => {
    auth.rolesForRequest.mockResolvedValue(["accounts"]);
    mockSql(routes("pending"));

    const res = await reject();

    expect(res.status).toBe(200);
    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "quote.reject",
      actorName: "Dana Director",
      actorRole: "accounts",
      actorUserId: 21,
      after: { amount: 500, contractorName: "Acme", quoteNumber: "QT-9-1", status: "rejected" },
      before: { status: "pending" },
      buildingId: 5,
      isException: false,
      jobId: 9,
      subjectId: "7",
      subjectType: "quote",
    });
  });

  it("a director turning down a quote that was waiting for them: quote.director_reject", async () => {
    auth.rolesForRequest.mockResolvedValue(["director"]);
    mockSql(routes("awaiting_director"));

    await reject();

    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({
      action: "quote.director_reject",
      actorRole: "director",
      before: { status: "awaiting_director" },
    });
  });

  it("anyone else rejecting a quote that was waiting for the director: still a plain quote.reject", async () => {
    auth.rolesForRequest.mockResolvedValue(["accounts"]);
    mockSql(routes("awaiting_director"));

    await reject();

    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "quote.reject", before: { status: "awaiting_director" } });
  });

  it("a director rejecting a pending quote is not the director gate: quote.reject", async () => {
    auth.rolesForRequest.mockResolvedValue(["director"]);
    mockSql(routes("pending"));

    await reject();

    expect(ledgerInserts(db.executeQuery)[0].action).toBe("quote.reject");
  });

  it("writes the rejection and its ledger row in one transaction that commits", async () => {
    auth.rolesForRequest.mockResolvedValue(["accounts"]);
    mockSql(routes("pending"));

    await reject();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    expect(orderOf(/UPDATE Quotes SET Status = 'rejected'/)).toBeGreaterThan(begun);
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(orderOf(/UPDATE Quotes SET Status = 'rejected'/));
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(committed);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("rolls the rejection back when the ledger write fails, and doesn't touch the director's Planner task", async () => {
    auth.rolesForRequest.mockResolvedValue(["director"]);
    mockSql([...routes("awaiting_director"), LEDGER_FAILS]);

    const res = await reject();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(/UPDATE Quotes SET Status = 'rejected'/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    expect(planner.resolveActivePlannerTasks).not.toHaveBeenCalled();
  });

  it("a rejection the helper refuses (409) rolls back and writes no ledger row", async () => {
    auth.rolesForRequest.mockResolvedValue(["accounts"]);
    mockSql(routes("approved"));

    const res = await reject();

    expect(res.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });

  it("records a refused role as `denied` and answers the same 403", async () => {
    const gate = { jsonBody: { details: "Required role: accounts | facilities_manager. Have: user", error: "Forbidden" }, status: 403 };
    auth.requireRole.mockResolvedValue(gate);
    auth.rolesForRequest.mockResolvedValue(["user"]);
    mockSql([APP_USER, JOB_BUILDING, { match: /FROM Quotes s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] }]);

    const res = await reject();

    expect(res).toBe(gate);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: { attempted: "quote.reject" }, ruleApplied: "role_not_permitted", subjectId: "7" }),
    ]);
  });
});

describe("directorApproveQuote", () => {
  const routes = (status: string): Route[] => [
    APP_USER,
    JOB_BUILDING,
    {
      match: /SELECT JobID, QuoteNumber, ContractorName, Status FROM Quotes/,
      rows: [{ ContractorName: "Acme", JobID: 9, QuoteNumber: "QT-9-1", Status: status }],
    },
    { match: /UPDATE Quotes\s+SET Status = 'approved'/, rows: [{ QuoteID: 7 }] },
    {
      match: /SELECT\s+QuoteID, JobID/,
      rows: [{ Amount: 5000, ContractorID: 3, ContractorName: "Acme", Currency: "AUD", JobID: 9, QuoteID: 7, QuoteNumber: "QT-9-1", Status: "approved" }],
    },
  ];
  const approve = () => directorApproveQuote(makeRequest({ QuoteID: 7 }), ctx);

  beforeEach(() => auth.rolesForRequest.mockResolvedValue(["director"]));

  it("writes one quote.director_approve row: awaiting_director to approved, by the director", async () => {
    mockSql(routes("awaiting_director"));

    const res = await approve();

    expect(res.status).toBe(200);
    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "quote.director_approve",
      actorName: "Dana Director",
      actorRole: "director",
      actorUserId: 21,
      after: { amount: 5000, contractorId: 3, contractorName: "Acme", currency: "AUD", quoteNumber: "QT-9-1", status: "approved" },
      attributedName: null,
      before: { status: "awaiting_director" },
      buildingId: 5,
      isException: false,
      jobId: 9,
      reason: null,
      ruleApplied: null,
      subjectId: "7",
      subjectType: "quote",
    });
  });

  it("writes the approval and the ledger row inside one transaction that commits, then closes the Planner task", async () => {
    mockSql(routes("awaiting_director"));

    await approve();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    for (const write of [/UPDATE Quotes\s+SET Status = 'approved'/, /UPDATE Jobs\s+SET ApprovedQuoteID/, /INSERT INTO JobEvents/, /INSERT INTO dbo\.DecisionLedger/]) {
      expect(orderOf(write)).toBeGreaterThan(begun);
      expect(orderOf(write)).toBeLessThan(committed);
    }
    expect(planner.resolveActivePlannerTasks).toHaveBeenCalledWith("job", 9, ["director_approval"]);
  });

  it("rolls the approval back when the ledger write fails", async () => {
    mockSql([...routes("awaiting_director"), LEDGER_FAILS]);

    const res = await approve();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(/UPDATE Quotes\s+SET Status = 'approved'/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    expect(planner.resolveActivePlannerTasks).not.toHaveBeenCalled();
  });

  it("a quote that isn't awaiting the director is a 409, with no ledger row", async () => {
    mockSql(routes("pending"));

    const res = await approve();

    expect(res.status).toBe(409);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });

  describe("refused attempts", () => {
    const quoteScope: Route = { match: /FROM Quotes s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] };

    it("an admin is not a director: still 403 \"Director role required\", recorded as `denied` / director_role_required", async () => {
      auth.rolesForRequest.mockResolvedValue(["admin"]);
      mockSql([APP_USER, quoteScope]);

      const res = await approve();

      expect(res).toEqual({ jsonBody: { error: "Director role required" }, status: 403 });
      const rows = ledgerInserts(db.executeQuery);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        action: "denied",
        actorRole: "admin",
        before: { attempted: "quote.director_approve" },
        buildingId: 5,
        isException: true,
        jobId: 9,
        reason: "Director role required",
        ruleApplied: "director_role_required",
        subjectId: "7",
        subjectType: "quote",
      });
      expect(planner.resolveActivePlannerTasks).not.toHaveBeenCalled();
    });

    it("the role gate refusing is recorded too, as role_not_permitted, and answers as it did", async () => {
      const gate = { jsonBody: { details: "Required role: director. Have: accounts", error: "Forbidden" }, status: 403 };
      auth.requireRole.mockResolvedValue(gate);
      auth.rolesForRequest.mockResolvedValue(["accounts"]);
      mockSql([APP_USER, quoteScope]);

      const res = await approve();

      expect(res).toBe(gate);
      expect(ledgerInserts(db.executeQuery)).toEqual([
        expect.objectContaining({ action: "denied", actorRole: "accounts", ruleApplied: "role_not_permitted" }),
      ]);
    });

    it("records nothing for a quote that doesn't exist", async () => {
      auth.rolesForRequest.mockResolvedValue(["admin"]);
      mockSql([APP_USER, { match: /FROM Quotes s INNER JOIN Jobs j/, rows: [] }]);

      const res = await approve();

      expect(res.status).toBe(403);
      expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    });

    it("still answers 403 when the refusal can't be recorded", async () => {
      auth.rolesForRequest.mockResolvedValue(["admin"]);
      mockSql([APP_USER, quoteScope, LEDGER_FAILS]);

      const res = await approve();

      expect(res).toEqual({ jsonBody: { error: "Director role required" }, status: 403 });
    });
  });
});
