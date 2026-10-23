/// <reference types="jest" />
// Quote approvals, rejections and director approvals each write one decision-
// ledger row in the decision's own transaction (WP19b, PLAN §3.12). The DB layer
// is mocked and the real ledger and quote-decisions helpers run, so what is
// asserted is the INSERT record() really sends.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";
import { moneyShape } from "../__tests__/fixtures/moneyRowShape";

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
jest.mock("../escalation/engine", () => ({
  ...jest.requireActual("../escalation/engine"),
  raiseWithin: jest.fn().mockResolvedValue({ announce: jest.fn().mockResolvedValue({}), created: true, escalation: {} }),
  resolveWithin: jest.fn().mockResolvedValue({}),
}));
jest.mock("../escalation/store", () => ({ ...jest.requireActual("../escalation/store"), findLiveEscalation: jest.fn().mockResolvedValue(null) }));
jest.mock("../quoteAttributionColumn", () => ({ quoteAttributionColumnExists: jest.fn().mockResolvedValue(true) }));
jest.mock("../approvalAttributionNotice", () => ({ raiseAttributionNotice: jest.fn().mockResolvedValue(undefined) }));

const auth = require("../auth") as {
  requireRole: jest.Mock;
  rolesForRequest: jest.Mock;
  verifiedIdentityFromRequest: jest.Mock;
};
const db = require("../db") as {
  beginTransaction: jest.Mock;
  buildUpdateSet: jest.Mock;
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
const columnProbe = require("../quoteAttributionColumn") as { quoteAttributionColumnExists: jest.Mock };
const notices = require("../approvalAttributionNotice") as { raiseAttributionNotice: jest.Mock };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
const { directorApproveQuote, rejectQuote } = require("./quotes") as {
  directorApproveQuote: Handler;
  rejectQuote: Handler;
};
// approveQuote is registered, not exported. Capture it before clearAllMocks wipes app.http's calls.
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const registered = (name: string): Handler => {
  const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!hit) throw new Error(`handler ${name} not registered`);
  return (hit[1] as { handler: Handler }).handler;
};
const approveQuote = registered("approveQuote");
const upsertQuote = registered("upsertQuote");
const resendDirectorQuoteEmail = registered("resendDirectorQuoteEmail");
const { answerApprovalAttribution } = require("./answerApprovalAttribution") as { answerApprovalAttribution: Handler };
const unapproveQuote = registered("unapproveQuote");
const completeQuote = registered("completeQuote");
const uncompleteQuote = registered("uncompleteQuote");
const deleteQuote = registered("deleteQuote");

type Route = { match: RegExp; reject?: Error; rows?: Record<string, unknown>[] };

/** Answers each statement by shape; the first matching route wins, anything else returns no rows. */
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    const hit = routes.find((r) => r.match.test(sql));
    if (hit?.reject) throw hit.reject;
    return hit?.rows ?? (/OUTPUT inserted\.\w+ AS Id/.test(sql) ? [{ Id: 1 }] : []); // send claim succeeds by default
  });
}

const sqlCalls = (): { sql: string; order: number }[] =>
  db.executeQuery.mock.calls.map((c: unknown[], i: number) => ({
    order: db.executeQuery.mock.invocationCallOrder[i],
    sql: String(c[1]),
  }));
const calledWith = (re: RegExp): { params: Record<string, unknown>; sql: string } | undefined =>
  db.executeQuery.mock.calls
    .map((c: unknown[]) => ({
      params: Object.fromEntries(((c[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value])),
      sql: String(c[1]),
    }))
    .find((c: { sql: string }) => re.test(c.sql));
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

// Every money row any test here writes has the shape trend reports read (see the fixture).
afterEach(() => moneyShape.check(ledgerInserts(db.executeQuery)));
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

  it("records what the quote was before it was approved", async () => {
    mockSql([APP_USER, JOB_BUILDING, quoteRow({ Status: "awaiting_approval" }), stored]);

    await approve();

    expect(ledgerInserts(db.executeQuery)[0].before).toEqual({ contractorId: 3, contractorName: "Acme", status: "awaiting_approval" });
  });

  it("a rejected quote is not approved again (J3): 409, a `denied` row, nothing written", async () => {
    mockSql([APP_USER, JOB_BUILDING, quoteRow({ Status: "rejected" }), stored, { match: /FROM Quotes s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] }]);

    const res = await approve();

    expect(res.status).toBe(409);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: { attempted: "quote.approve", status: "rejected" }, ruleApplied: "not_approvable" }),
    ]);
    expect(sqlCalls().some((c) => /UPDATE Quotes/.test(c.sql))).toBe(false);
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
  const decline = (Reason: unknown = "Too dear for a like-for-like swap") => rejectQuote(makeRequest({ QuoteID: 7, Reason }), ctx);

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

  it("a director declining a quote that was waiting for them: quote.director_reject, with the reason (J6)", async () => {
    auth.rolesForRequest.mockResolvedValue(["director"]);
    mockSql(routes("awaiting_director"));

    const res = await decline();

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({
      action: "quote.director_reject",
      actorRole: "director",
      before: { status: "awaiting_director" },
      reason: "Too dear for a like-for-like swap",
    });
    const event = db.executeQuery.mock.calls.find((c: unknown[]) => /INSERT INTO JobEvents/.test(String(c[1])));
    expect(event?.[2]).toEqual(expect.arrayContaining([{ name: "Text", type: expect.anything(), value: "Director declined quote QT-9-1 — Too dear for a like-for-like swap" }]));
  });

  it.each([{}, { Reason: "" }, { Reason: "   " }, { Reason: 42 }])("declining a quote that waits on a director without a reason (%p) is refused, ledgered, and changes nothing (J6)", async (extra) => {
    auth.rolesForRequest.mockResolvedValue(["director"]);
    mockSql(routes("awaiting_director"));

    const res = await rejectQuote(makeRequest({ QuoteID: 7, ...extra }), ctx);

    expect(res).toEqual({
      jsonBody: { code: "reason_required", error: "Say why you're declining this quote. The reason is recorded on the job for whoever raised it." },
      status: 422,
    });
    expect(orderOf(/UPDATE Quotes SET Status = 'rejected'/)).toBe(-1);
    expect(orderOf(/INSERT INTO JobEvents/)).toBe(-1);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: { attempted: "quote.director_reject" }, ruleApplied: "reason_required" }),
    ]);
  });

  it("anyone else rejecting a quote that was waiting for the director: a plain quote.reject, and the reason is still required", async () => {
    auth.rolesForRequest.mockResolvedValue(["accounts"]);
    mockSql(routes("awaiting_director"));

    expect((await reject()).status).toBe(422);
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "denied", before: { attempted: "quote.reject" } });

    jest.clearAllMocks();
    auth.verifiedIdentityFromRequest.mockResolvedValue(CALLER);
    auth.rolesForRequest.mockResolvedValue(["accounts"]);
    mockSql(routes("awaiting_director"));
    await decline();

    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "quote.reject", before: { status: "awaiting_director" }, reason: "Too dear for a like-for-like swap" });
  });

  it("someone other than a director turning it down reads as a rejection on the job, not a director's decline (J6b)", async () => {
    auth.rolesForRequest.mockResolvedValue(["accounts"]);
    mockSql(routes("awaiting_director"));

    await decline();

    const event = db.executeQuery.mock.calls.find((c: unknown[]) => /INSERT INTO JobEvents/.test(String(c[1])));
    expect(event?.[2]).toEqual(expect.arrayContaining([{ name: "Text", type: expect.anything(), value: "Rejected quote QT-9-1 — Too dear for a like-for-like swap" }]));
  });

  it("a rejection from pending may carry a reason, and records it", async () => {
    auth.rolesForRequest.mockResolvedValue(["accounts"]);
    mockSql(routes("pending"));

    await decline("Missing the asbestos survey");

    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "quote.reject", reason: "Missing the asbestos survey" });
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

    const res = await decline();

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

// ── Reversals and deletions ─────────────────────────────────────────────────

describe("quote reversals and deletions", () => {
  const FIRST_SELECT = /FROM Quotes WITH \(UPDLOCK, HOLDLOCK\) WHERE QuoteID = @Id/;
  const quoteScope: Route = { match: /FROM Quotes s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] };
  const stored: Route = { match: /SELECT\s+QuoteID, JobID/, rows: [{ QuoteID: 7 }] };
  const noPayments: Route = { match: /SELECT COUNT\(\*\) AS N FROM Payments/, rows: [{ N: 0 }] };
  const quote = (over: Record<string, unknown> = {}): Route => ({
    match: FIRST_SELECT,
    rows: [
      {
        Amount: 500,
        ApprovedAt: null,
        ApprovedBy: null,
        ContractorID: 3,
        ContractorName: "Acme",
        Currency: "AUD",
        DirectorApprovedAt: null,
        DirectorApprovedBy: null,
        JobID: 9,
        QuoteNumber: "QT-9-1",
        QuotePDFBlobName: "quotes/7.pdf",
        Status: "pending",
        ...over,
      },
    ],
  });
  const FACTS = { amount: 500, contractorId: 3, contractorName: "Acme", currency: "AUD", quoteNumber: "QT-9-1" };
  const gate = { jsonBody: { details: "Required role: accounts_manager. Have: facilities", error: "Forbidden" }, status: 403 };
  const refuseRole = () => {
    auth.requireRole.mockResolvedValue(gate);
    auth.rolesForRequest.mockResolvedValue(["facilities"]);
    mockSql([APP_USER, quoteScope]);
  };
  const call = (handler: Handler) => handler(makeRequest({ QuoteID: 7 }), ctx);
  const rows = () => ledgerInserts(db.executeQuery);

  describe("unapproveQuote", () => {
    const approvedOnce = (over: Record<string, unknown> = {}) =>
      quote({ ApprovedAt: new Date("2026-10-01T02:03:04Z"), ApprovedBy: "Pat Approver", Status: "approved", ...over });

    it("writes one quote.unapprove exception row, keeping who approved it and when", async () => {
      mockSql([APP_USER, JOB_BUILDING, approvedOnce(), noPayments, stored]);

      const res = await call(unapproveQuote);

      expect(res.status).toBe(200);
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        action: "quote.unapprove",
        actorKind: "user",
        actorName: "Dana Director",
        actorRole: "accounts_manager",
        actorUserId: 21,
        after: { ...FACTS, status: "pending" },
        before: {
          ...FACTS,
          approvedAt: "2026-10-01T02:03:04.000Z",
          approvedBy: "Pat Approver",
          pdfBlobName: "quotes/7.pdf",
          status: "approved",
        },
        buildingId: 5,
        isException: true,
        jobId: 9,
        subjectId: "7",
        subjectType: "quote",
      });
    });

    it("clears an attribution that belonged to the approval being undone", async () => {
      mockSql([APP_USER, JOB_BUILDING, approvedOnce(), noPayments, stored]);
      await call(unapproveQuote);
      expect(calledWith(/UPDATE Quotes/)?.sql).toMatch(/ApprovalAttributedToUserID = NULL, ApprovalAttributionDeclaredAt = NULL, AttributionAnsweredAt = NULL/);
    });

    it("says the amount did not move, and what the approval being undone covered", async () => {
      mockSql([APP_USER, JOB_BUILDING, approvedOnce(), noPayments, stored]);

      await call(unapproveQuote);

      expect(rows()[0].after).toMatchObject({
        amount: 500,
        delta: 0,
        deltaPercent: 0,
        newAmount: 500,
        originalApprovedAmount: 500,
        previousAmount: 500,
      });
    });

    it("clears the approval and writes the ledger row inside one transaction that commits", async () => {
      mockSql([APP_USER, JOB_BUILDING, approvedOnce(), noPayments, stored]);

      await call(unapproveQuote);

      const begun = db.beginTransaction.mock.invocationCallOrder[0];
      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      for (const write of [FIRST_SELECT, /UPDATE Quotes\s+SET Status = 'pending'/, /UPDATE Jobs\s+SET ApprovedQuoteID = NULL/, /INSERT INTO JobEvents/, /INSERT INTO dbo\.DecisionLedger/]) {
        expect(orderOf(write)).toBeGreaterThan(begun);
        expect(orderOf(write)).toBeLessThan(committed);
      }
      expect(db.rollbackTransaction).not.toHaveBeenCalled();
    });

    it("is rolled back when the ledger write fails: the approval is not undone without its record", async () => {
      mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, approvedOnce(), noPayments, stored]);

      const res = await call(unapproveQuote);

      expect(res.status).toBe(500);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(orderOf(/UPDATE Quotes\s+SET Status = 'pending'/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    });

    it("a payment already recorded: the same 400, recorded as a refused attempt", async () => {
      mockSql([APP_USER, JOB_BUILDING, approvedOnce(), { match: /SELECT COUNT\(\*\) AS N FROM Payments/, rows: [{ N: 2 }] }, stored]);

      const res = await call(unapproveQuote);

      expect(res).toEqual({ jsonBody: { error: "Cannot unapprove — a payment has already been recorded against this quote." }, status: 400 });
      expect(rows()).toEqual([
        expect.objectContaining({
          action: "denied",
          before: { attempted: "quote.unapprove", status: "approved" },
          buildingId: 5,
          jobId: 9,
          ruleApplied: "payment_recorded",
          subjectId: "7",
        }),
      ]);
      expect(orderOf(/UPDATE Quotes/)).toBe(-1);
    });

    it("a quote that isn't approved is a 400 with no ledger row", async () => {
      mockSql([APP_USER, JOB_BUILDING, quote({ Status: "pending" }), noPayments]);

      const res = await call(unapproveQuote);

      expect(res.status).toBe(400);
      expect(rows()).toHaveLength(0);
    });

    it("404s an unknown quote, writing nothing", async () => {
      mockSql([APP_USER, JOB_BUILDING]);

      const res = await call(unapproveQuote);

      expect(res.status).toBe(404);
      expect(rows()).toHaveLength(0);
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    });

    it("records a refused role as `denied` and answers with the gate's own 403", async () => {
      refuseRole();

      const res = await call(unapproveQuote);

      expect(res).toBe(gate);
      expect(rows()).toEqual([
        expect.objectContaining({ action: "denied", before: { attempted: "quote.unapprove" }, ruleApplied: "role_not_permitted", subjectId: "7" }),
      ]);
    });
  });

  describe("completeQuote", () => {
    it("writes one quote.complete row: approved to completed", async () => {
      mockSql([APP_USER, JOB_BUILDING, quote({ Status: "approved" }), stored]);

      const res = await call(completeQuote);

      expect(res.status).toBe(200);
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        action: "quote.complete",
        actorName: "Dana Director",
        actorUserId: 21,
        after: { ...FACTS, status: "completed" },
        before: { status: "approved" },
        buildingId: 5,
        isException: false,
        jobId: 9,
        subjectId: "7",
        subjectType: "quote",
      });
    });

    it("writes the status and the ledger row inside one transaction that commits", async () => {
      mockSql([APP_USER, JOB_BUILDING, quote({ Status: "approved" }), stored]);

      await call(completeQuote);

      const begun = db.beginTransaction.mock.invocationCallOrder[0];
      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      for (const write of [/UPDATE Quotes SET Status = 'completed'/, /INSERT INTO JobEvents/, /INSERT INTO dbo\.DecisionLedger/]) {
        expect(orderOf(write)).toBeGreaterThan(begun);
        expect(orderOf(write)).toBeLessThan(committed);
      }
    });

    it("is rolled back when the ledger write fails", async () => {
      mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, quote({ Status: "approved" }), stored]);

      const res = await call(completeQuote);

      expect(res.status).toBe(500);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(orderOf(/UPDATE Quotes SET Status = 'completed'/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    });

    it("a quote that isn't approved is a 400 with no ledger row", async () => {
      mockSql([APP_USER, JOB_BUILDING, quote({ Status: "pending" })]);

      const res = await call(completeQuote);

      expect(res.status).toBe(400);
      expect(rows()).toHaveLength(0);
    });

    it("records a refused role as `denied`", async () => {
      refuseRole();

      const res = await call(completeQuote);

      expect(res).toBe(gate);
      expect(rows()).toEqual([expect.objectContaining({ before: { attempted: "quote.complete" }, ruleApplied: "role_not_permitted" })]);
    });
  });

  describe("uncompleteQuote", () => {
    it("writes one quote.uncomplete exception row: completed back to approved", async () => {
      mockSql([APP_USER, JOB_BUILDING, quote({ Status: "completed" }), stored]);

      const res = await call(uncompleteQuote);

      expect(res.status).toBe(200);
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        action: "quote.uncomplete",
        after: { ...FACTS, status: "approved" },
        before: { status: "completed" },
        buildingId: 5,
        isException: true,
        jobId: 9,
        subjectId: "7",
      });
    });

    it("says the amount did not move, measured against the approval the quote had", async () => {
      mockSql([APP_USER, JOB_BUILDING, quote({ ApprovedAt: new Date("2026-10-01T02:03:04Z"), Status: "completed" }), stored]);

      await call(uncompleteQuote);

      expect(rows()[0].before).toMatchObject({ contractorId: 3, contractorName: "Acme", status: "completed" });
      expect(rows()[0].after).toMatchObject({
        amount: 500,
        delta: 0,
        deltaPercent: 0,
        newAmount: 500,
        originalApprovedAmount: 500,
        previousAmount: 500,
      });
    });

    it("is rolled back when the ledger write fails", async () => {
      mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, quote({ Status: "completed" }), stored]);

      const res = await call(uncompleteQuote);

      expect(res.status).toBe(500);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(orderOf(/UPDATE Quotes SET Status = 'approved'/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    });

    it("a quote that isn't completed is a 400 with no ledger row", async () => {
      mockSql([APP_USER, JOB_BUILDING, quote({ Status: "approved" })]);

      const res = await call(uncompleteQuote);

      expect(res.status).toBe(400);
      expect(rows()).toHaveLength(0);
    });
  });

  describe("deleteQuote", () => {
    it("writes one quote.delete exception row whose `before` is a snapshot of what was deleted", async () => {
      mockSql([APP_USER, JOB_BUILDING, quote({ ApprovedAt: new Date("2026-10-01T02:03:04Z"), ApprovedBy: "Pat Approver", Status: "awaiting_director" })]);

      const res = await call(deleteQuote);

      expect(res).toEqual({ jsonBody: { deleted: true, quoteId: 7 }, status: 200 });
      expect(rows()).toHaveLength(1);
      expect(rows()[0]).toMatchObject({
        action: "quote.delete",
        actorName: "Dana Director",
        actorRole: "accounts_manager",
        actorUserId: 21,
        after: {
          amount: 0,
          contractorId: 3,
          contractorName: "Acme",
          deleted: true,
          delta: -500,
          deltaPercent: -100,
          newAmount: 0,
          originalApprovedAmount: 500,
          previousAmount: 500,
        },
        before: {
          ...FACTS,
          approvedAt: "2026-10-01T02:03:04.000Z",
          approvedBy: "Pat Approver",
          pdfBlobName: "quotes/7.pdf",
          status: "awaiting_director",
        },
        buildingId: 5,
        isException: true,
        jobId: 9,
        subjectId: "7",
        subjectType: "quote",
      });
    });

    it("a quote nobody approved has no approval to measure the deletion against", async () => {
      mockSql([APP_USER, JOB_BUILDING, quote()]);

      await call(deleteQuote);

      expect(rows()[0].after).toMatchObject({ amount: 0, delta: -500, deltaPercent: -100, originalApprovedAmount: null, previousAmount: 500 });
    });

    it("deletes the quote and writes the ledger row inside one transaction that commits", async () => {
      mockSql([APP_USER, JOB_BUILDING, quote()]);

      await call(deleteQuote);

      const begun = db.beginTransaction.mock.invocationCallOrder[0];
      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      expect(orderOf(FIRST_SELECT)).toBeGreaterThan(begun);
      expect(orderOf(/DELETE FROM Quotes WHERE QuoteID = @Id/)).toBeGreaterThan(orderOf(FIRST_SELECT));
      expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(orderOf(/DELETE FROM Quotes/));
      expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(committed);
      expect(db.rollbackTransaction).not.toHaveBeenCalled();
    });

    it("is rolled back when the ledger write fails: the quote is not deleted without its record", async () => {
      mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, quote()]);

      const res = await call(deleteQuote);

      expect(res.status).toBe(500);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      // The DELETE ran inside the transaction that was rolled back.
      expect(orderOf(/DELETE FROM Quotes/)).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
      expect(orderOf(/DELETE FROM Quotes/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    });

    it("is rolled back when the delete itself fails (a payment still points at the quote), writing no row", async () => {
      mockSql([{ match: /DELETE FROM Quotes/, reject: new Error("The DELETE statement conflicted with the REFERENCE constraint") }, APP_USER, JOB_BUILDING, quote()]);

      const res = await call(deleteQuote);

      expect(res.status).toBe(500);
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(rows()).toHaveLength(0);
    });

    it.each(["approved", "completed"])("a %s quote is protected: the same 400, recorded as a refused attempt", async (status) => {
      mockSql([APP_USER, JOB_BUILDING, quote({ Status: status })]);

      const res = await call(deleteQuote);

      expect(res).toEqual({ jsonBody: { error: "Cannot delete an approved quote. Reject it first if needed." }, status: 400 });
      expect(rows()).toEqual([
        expect.objectContaining({
          action: "denied",
          before: { attempted: "quote.delete", status },
          jobId: 9,
          ruleApplied: "approved_quote_protected",
          subjectId: "7",
        }),
      ]);
      expect(orderOf(/DELETE FROM Quotes/)).toBe(-1);
    });

    it("404s an unknown quote, writing nothing", async () => {
      mockSql([APP_USER, JOB_BUILDING]);

      const res = await call(deleteQuote);

      expect(res.status).toBe(404);
      expect(rows()).toHaveLength(0);
    });

    it("answers 401 and deletes nothing when the ledger can't name who is deleting", async () => {
      auth.verifiedIdentityFromRequest.mockResolvedValue(null);
      mockSql([APP_USER, JOB_BUILDING, quote()]);

      const res = await call(deleteQuote);

      expect(res.status).toBe(401);
      expect(orderOf(/DELETE FROM Quotes/)).toBe(-1);
      expect(db.beginTransaction).not.toHaveBeenCalled();
    });

    it("records a refused role as `denied`, deleting nothing", async () => {
      refuseRole();

      const res = await call(deleteQuote);

      expect(res).toBe(gate);
      expect(rows()).toEqual([expect.objectContaining({ before: { attempted: "quote.delete" }, ruleApplied: "role_not_permitted" })]);
      expect(orderOf(/DELETE FROM Quotes/)).toBe(-1);
    });
  });
});

// ── Approval resets and director requests ───────────────────────────────────

describe("upsertQuote: an amount edit that tears down an approval", () => {
  const LOCKED_READ = /FROM Quotes WITH \(UPDLOCK, HOLDLOCK\) WHERE QuoteID = @Id/;
  const APPROVED_AT = new Date("2026-10-01T02:03:04Z");
  const DIRECTOR_AT = new Date("2026-10-02T05:06:07Z");
  const quote = (over: Record<string, unknown> = {}): Route => ({
    match: LOCKED_READ,
    rows: [
      {
        Amount: 500,
        ApprovedAt: APPROVED_AT,
        ApprovedBy: "Pat Approver",
        ContractorID: 3,
        ContractorName: "Acme",
        Currency: "AUD",
        DirectorApprovedAt: DIRECTOR_AT,
        DirectorApprovedBy: "Dana Director",
        JobID: 9,
        QuoteNumber: "QT-9-1",
        QuotePDFBlobName: "quotes/7.pdf",
        Status: "approved",
        ...over,
      },
    ],
  });
  const stored: Route = { match: /SELECT\s+QuoteID, JobID/, rows: [{ QuoteID: 7 }] };
  const edit = (body: Record<string, unknown> = {}) => upsertQuote(makeRequest({ Amount: 9000, QuoteID: 7, ...body }), ctx);
  const resets = () => ledgerInserts(db.executeQuery).filter((r) => r.action === "quote.approval_reset");
  const CLEAR = /UPDATE Quotes\s+SET Status = 'pending'/;

  beforeEach(() => {
    db.buildUpdateSet.mockReturnValue({ params: [], setClause: "Amount = @Amount" });
    mockSql([APP_USER, JOB_BUILDING, quote(), stored]);
  });

  it("clears an attribution with the approval it belonged to", async () => {
    await edit();
    expect(db.executeQuery.mock.calls.some((c: unknown[]) => /SET Status = 'pending'/.test(String(c[1])) && /ApprovalAttributedToUserID = NULL, ApprovalAttributionDeclaredAt = NULL, AttributionAnsweredAt = NULL/.test(String(c[1])))).toBe(true);
  });

  it("writes one quote.approval_reset exception: the old amount, status and approval stamps before, the new amount after", async () => {
    const res = await edit();

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(1);
    const [row] = resets();
    expect(row).toMatchObject({
      action: "quote.approval_reset",
      actorKind: "user",
      actorName: "Dana Director",
      actorRole: "accounts_manager",
      actorUserId: 21,
      buildingId: 5,
      isException: true,
      jobId: 9,
      subjectId: "7",
      subjectType: "quote",
    });
    expect(row.before).toEqual({
      amount: 500,
      approvedAt: "2026-10-01T02:03:04.000Z",
      approvedBy: "Pat Approver",
      contractorId: 3,
      contractorName: "Acme",
      directorApprovedAt: "2026-10-02T05:06:07.000Z",
      directorApprovedBy: "Dana Director",
      status: "approved",
    });
    expect(row.after).toEqual({
      amount: 9000,
      contractorId: 3,
      contractorName: "Acme",
      currency: "AUD",
      delta: 8500,
      deltaPercent: 1700,
      newAmount: 9000,
      originalApprovedAmount: 500,
      previousAmount: 500,
      quoteNumber: "QT-9-1",
      status: "pending",
    });
  });

  it("says how far an edit moved the amount, down as well as up, measured against what was approved", async () => {
    await edit({ Amount: 380 });

    expect(resets()[0].after).toMatchObject({
      amount: 380,
      delta: -120,
      deltaPercent: -24,
      newAmount: 380,
      originalApprovedAmount: 500,
      previousAmount: 500,
    });
  });

  it("a contractor swapped in the same edit: `before` names the one the approval was for, `after` the new one", async () => {
    await edit({ ContractorID: 8, ContractorName: "Beta Pty" });

    expect(resets()[0].before).toMatchObject({ contractorId: 3, contractorName: "Acme" });
    expect(resets()[0].after).toMatchObject({ contractorId: 8, contractorName: "Beta Pty" });
  });

  it("a quote that was waiting for the director shows that status, and no director stamps", async () => {
    mockSql([APP_USER, JOB_BUILDING, quote({ DirectorApprovedAt: null, DirectorApprovedBy: null, Status: "awaiting_director" }), stored]);

    await edit();

    expect(resets()[0].before).toMatchObject({
      directorApprovedAt: null,
      directorApprovedBy: null,
      status: "awaiting_director",
    });
  });

  it("shows the edit as a whole in `after`: the new contractor and currency come with the new amount", async () => {
    await edit({ ContractorName: "Beta Pty", Currency: "NZD" });

    expect(resets()[0].after).toMatchObject({ amount: 9000, contractorName: "Beta Pty", currency: "NZD", status: "pending" });
    expect(resets()[0].before).toMatchObject({ amount: 500 });
  });

  it("writes no row for a quote that was never approved: there was no approval to tear down", async () => {
    mockSql([
      APP_USER,
      JOB_BUILDING,
      quote({ ApprovedAt: null, ApprovedBy: null, DirectorApprovedAt: null, DirectorApprovedBy: null, Status: "pending" }),
      stored,
    ]);

    const res = await edit();

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(orderOf(CLEAR)).toBe(-1);
  });

  it("writes no row when the amount is sent back unchanged", async () => {
    const res = await edit({ Amount: 500 });

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(orderOf(CLEAR)).toBe(-1);
  });

  it("a contractor-only edit is a payee change (J3): it clears the approval and is ledgered as payee_changed", async () => {
    const res = await edit({ Amount: undefined, ContractorName: "Beta Pty" });

    expect(res.status).toBe(200);
    expect(orderOf(CLEAR)).toBeGreaterThan(-1);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "quote.approval_reset",
        after: expect.objectContaining({ contractorName: "Beta Pty", delta: 0, status: "pending" }),
        ruleApplied: "payee_changed",
      }),
    ]);
  });

  it("a notes-only edit leaves the approval alone, writes no row and doesn't look up who is editing", async () => {
    const res = await edit({ Amount: undefined, Notes: "Called them" });

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(orderOf(/FROM dbo\.AppUsers WHERE EntraOid/)).toBe(-1);
    expect(orderOf(CLEAR)).toBe(-1);
  });

  it("clears the approval and writes the ledger row inside one transaction that commits", async () => {
    await edit();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    expect(orderOf(LOCKED_READ)).toBeGreaterThan(begun);
    for (const write of [/UPDATE Quotes SET Amount/, CLEAR, /UPDATE Jobs\s+SET ApprovedQuoteID = NULL/, /INSERT INTO dbo\.DecisionLedger/]) {
      expect(orderOf(write)).toBeGreaterThan(orderOf(LOCKED_READ));
      expect(orderOf(write)).toBeLessThan(committed);
    }
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(orderOf(CLEAR));
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("finds who is editing before anything is written", async () => {
    await edit();

    expect(orderOf(/FROM dbo\.AppUsers WHERE EntraOid/)).toBeLessThan(db.beginTransaction.mock.invocationCallOrder[0]);
  });

  it("rolls the edit back when the ledger write fails: the approval is not torn down without its record", async () => {
    mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, quote(), stored]);

    const res = await edit();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(CLEAR)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("answers 401 and starts nothing when the ledger can't name who is editing", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(CALLER).mockResolvedValueOnce(null);

    const res = await edit();

    expect(res.status).toBe(401);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(orderOf(/UPDATE Quotes/)).toBe(-1);
  });

  it("404s an unknown quote inside the transaction, writing nothing", async () => {
    mockSql([APP_USER, JOB_BUILDING]);

    const res = await edit();

    expect(res.status).toBe(404);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });
});

describe("the director request that follows a quote approval", () => {
  const SENT_AT = new Date("2026-10-13T00:00:00Z");
  const PACKET = { attachments: 2, sections: ["job summary", "quote QT-9-1"], separateFiles: 1 };
  const overEveryLimit: Route = {
    match: /SELECT JobID, QuoteNumber, ContractorName, Amount/,
    rows: [{ Amount: 5000, ContractorID: 3, ContractorName: "Acme", Currency: "AUD", JobID: 9, QuoteNumber: "QT-9-1", Status: "pending" }],
  };
  const stored: Route = { match: /SELECT QuoteID FROM Quotes|SELECT\s+QuoteID, JobID/, rows: [{ QuoteID: 7 }] };
  const NAMES: Route = { match: /SELECT DisplayName FROM dbo\.AppUsers WHERE Email IN/, rows: [{ DisplayName: "Dana Director" }, { DisplayName: "Bo Boss" }] };
  const STAMP = /UPDATE Quotes\s+SET DirectorEmailSentAt/;
  const approve = async () => {
    const res = await approveQuote(makeRequest({ QuoteID: 7 }), ctx);
    await flush();
    return res;
  };
  const byAction = (action: string) => ledgerInserts(db.executeQuery).filter((r) => r.action === action);

  beforeEach(() => {
    directorEmails.sendDirectorApprovalEmail.mockResolvedValue({
      packet: PACKET,
      sentAt: SENT_AT,
      sentTo: ["dana@example.com", "boss@example.com"],
    });
    mockSql([APP_USER, JOB_BUILDING, overEveryLimit, stored, NAMES]);
  });

  it("writes one quote.director_request_sent row once the mail has gone: who it went to, that it was not a resend, what the packet held", async () => {
    const res = await approve();

    expect(res.status).toBe(200);
    expect(byAction("quote.director_request_sent")).toHaveLength(1);
    const [row] = byAction("quote.director_request_sent");
    expect(row).toMatchObject({
      actorKind: "user",
      actorName: "Dana Director",
      actorRole: "accounts_manager",
      actorUserId: 21,
      before: null,
      buildingId: 5,
      isException: false,
      jobId: 9,
      subjectId: "7",
      subjectType: "quote",
    });
    expect(row.after).toEqual({
      amount: 5000,
      contractorId: 3,
      contractorName: "Acme",
      currency: "AUD",
      packet: PACKET,
      quoteNumber: "QT-9-1",
      recipients: ["Bo Boss", "Dana Director"],
      resend: false,
      unnamedRecipients: 0,
    });
  });

  it("counts an address that has no name behind it instead of showing it", async () => {
    mockSql([APP_USER, JOB_BUILDING, overEveryLimit, stored, { ...NAMES, rows: [{ DisplayName: "Dana Director" }] }]);

    await approve();

    expect(byAction("quote.director_request_sent")[0].after).toMatchObject({ recipients: ["Dana Director"], unnamedRecipients: 1 });
  });

  it("keeps every email address out of every row it writes", async () => {
    await approve();

    expect(JSON.stringify(ledgerInserts(db.executeQuery))).not.toMatch(/@example\.com/);
  });

  it("shares one correlation id with the approval that triggered it", async () => {
    await approve();

    const [approval] = byAction("quote.approve");
    const [request] = byAction("quote.director_request_sent");
    expect(approval.correlationId).toBeTruthy();
    expect(request.correlationId).toBe(approval.correlationId);
  });

  it("stamps the quote and writes the row in one transaction of its own that commits, after the mail has gone", async () => {
    await approve();

    const mailed = directorEmails.sendDirectorApprovalEmail.mock.invocationCallOrder[0];
    const begun = db.beginTransaction.mock.invocationCallOrder[1];
    const committed = db.commitTransaction.mock.invocationCallOrder[1];
    expect(db.beginTransaction).toHaveBeenCalledTimes(2);
    expect(begun).toBeGreaterThan(mailed);
    expect(orderOf(STAMP)).toBeGreaterThan(begun);
    const requestRow = byAction("quote.director_request_sent")[0];
    expect(requestRow.order).toBeGreaterThan(orderOf(STAMP));
    expect(requestRow.order).toBeLessThan(committed);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("still stamps who it went to and who sent it, as the e-mail decision check expects", async () => {
    await approve();

    const stamp = db.executeQuery.mock.calls.find((c: unknown[]) => STAMP.test(String(c[1])));
    const params = Object.fromEntries((stamp?.[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value]));
    expect(params).toMatchObject({
      Id: 7,
      SentAt: SENT_AT,
      SentBy: "Dana Director",
      SentTo: JSON.stringify(["dana@example.com", "boss@example.com"]),
    });
  });

  it("finds the job's building before the mail goes, so the row can't be missed afterwards", async () => {
    await approve();

    const scopes = sqlCalls().filter((c) => /SELECT BuildingID FROM Jobs WHERE JobID/.test(c.sql));
    expect(scopes).toHaveLength(2);
    expect(scopes[1].order).toBeLessThan(directorEmails.sendDirectorApprovalEmail.mock.invocationCallOrder[0]);
  });

  it("a send that fails leaves the quote unstamped and writes a quote.director_request_failed exception row of its own", async () => {
    directorEmails.sendDirectorApprovalEmail.mockRejectedValue(new Error("Graph is down for dana@example.com"));

    const res = await approve();

    expect(res.status).toBe(200);
    expect(byAction("quote.director_request_sent")).toHaveLength(0);
    expect(orderOf(STAMP)).toBe(-1);
    const [row] = byAction("quote.director_request_failed");
    expect(row).toMatchObject({
      actorName: "Dana Director",
      actorRole: "accounts_manager",
      after: { amount: 5000, contractorId: 3, contractorName: "Acme", currency: "AUD", quoteNumber: "QT-9-1", resend: false },
      buildingId: 5,
      isException: true,
      jobId: 9,
      reason: "The director approval email could not be sent",
      ruleApplied: "send_failed",
      subjectId: "7",
      subjectType: "quote",
    });
    expect(row.correlationId).toBe(byAction("quote.approve")[0].correlationId);
    // The approval itself stands, and the error text (which can name addresses) stays in the logs.
    expect(byAction("quote.approve")).toHaveLength(1);
    expect(JSON.stringify(ledgerInserts(db.executeQuery))).not.toMatch(/Graph is down|@example\.com/);
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringContaining("Director email failed for quote 7"));
  });

  it("writes the failure row in a transaction that commits after the approval's own", async () => {
    directorEmails.sendDirectorApprovalEmail.mockRejectedValue(new Error("Graph is down"));

    await approve();

    expect(db.beginTransaction).toHaveBeenCalledTimes(2);
    expect(db.commitTransaction).toHaveBeenCalledTimes(2);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
    expect(byAction("quote.director_request_failed")[0].order).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[1]);
  });

  it("rolls the stamp back when the row for the send can't be written: never a stamp without its record", async () => {
    let inserts = 0;
    const routes = [APP_USER, JOB_BUILDING, overEveryLimit, stored, NAMES];
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/INSERT INTO dbo\.DecisionLedger/.test(sql) && ++inserts >= 2) throw new Error("ledger unavailable");
      return routes.find((r) => r.match.test(sql))?.rows ?? (/OUTPUT inserted\.\w+ AS Id/.test(sql) ? [{ Id: 1 }] : []);
    });

    const res = await approve();

    expect(res.status).toBe(200);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(STAMP)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringContaining("Director email failed for quote 7"));
  });

  it("sends before answering, and flags directorEmailFailed (still 200) when the mail fails, with the failed row written", async () => {
    directorEmails.sendDirectorApprovalEmail.mockRejectedValue(new Error("Graph 503"));
    mockSql([APP_USER, JOB_BUILDING, overEveryLimit, stored, NAMES]);

    const res = await approve();

    expect(res).toMatchObject({ status: 200, jsonBody: { directorEmailFailed: true } });
    expect(byAction("quote.director_request_failed")).toHaveLength(1);
  });

  it("answers without the flag when the mail went", async () => {
    mockSql([APP_USER, JOB_BUILDING, overEveryLimit, stored, NAMES]);

    const res = await approve();

    expect(directorEmails.sendDirectorApprovalEmail).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.jsonBody).not.toHaveProperty("directorEmailFailed");
  });

  it("sends nothing and records no request for a quote the caller's own limit covers", async () => {
    mockSql([APP_USER, JOB_BUILDING, { ...overEveryLimit, rows: [{ ...overEveryLimit.rows![0], Amount: 500 }] }, stored, NAMES]);

    await approve();

    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
    expect(byAction("quote.director_request_sent")).toHaveLength(0);
    expect(byAction("quote.director_request_failed")).toHaveLength(0);
  });
});

describe("resendDirectorQuoteEmail", () => {
  const SENT_AT = new Date("2026-10-13T00:00:00Z");
  const awaiting = (over: Record<string, unknown> = {}): Route => ({
    match: /SELECT JobID, Amount, ISNULL\(Currency, 'AUD'\) AS Currency, Status, QuoteNumber/,
    rows: [
      {
        Amount: 5000,
        ContractorID: 3,
        ContractorName: "Acme",
        Currency: "AUD",
        JobID: 9,
        QuoteNumber: "QT-9-1",
        Status: "awaiting_director",
        ...over,
      },
    ],
  });
  const stored: Route = { match: /SELECT\s+QuoteID, JobID/, rows: [{ QuoteID: 7 }] };
  const NAMES: Route = { match: /SELECT DisplayName FROM dbo\.AppUsers WHERE Email IN/, rows: [{ DisplayName: "Dana Director" }] };
  const STAMP = /UPDATE Quotes\s+SET DirectorEmailSentAt/;
  const resend = () => resendDirectorQuoteEmail(makeRequest({ QuoteID: 7 }), ctx);
  const rows = () => ledgerInserts(db.executeQuery);

  beforeEach(() => {
    auth.rolesForRequest.mockResolvedValue(["facilities"]);
    directorEmails.sendDirectorApprovalEmail.mockResolvedValue({
      packet: { attachments: 0, sections: ["job summary", "quote QT-9-1"], separateFiles: 0 },
      sentAt: SENT_AT,
      sentTo: ["dana@example.com"],
    });
    mockSql([APP_USER, JOB_BUILDING, awaiting(), stored, NAMES]);
  });

  it("writes one quote.director_request_sent row marked as a resend, by whoever pressed the button", async () => {
    const res = await resend();

    expect(res.status).toBe(200);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      action: "quote.director_request_sent",
      actorName: "Dana Director",
      actorRole: "facilities",
      after: {
        amount: 5000,
        contractorId: 3,
        contractorName: "Acme",
        currency: "AUD",
        packet: { attachments: 0, sections: ["job summary", "quote QT-9-1"], separateFiles: 0 },
        quoteNumber: "QT-9-1",
        recipients: ["Dana Director"],
        resend: true,
        unnamedRecipients: 0,
      },
      buildingId: 5,
      isException: false,
      jobId: 9,
      subjectId: "7",
      subjectType: "quote",
    });
    expect(JSON.stringify(rows())).not.toContain("dana@example.com");
  });

  it("stamps the quote and writes the row in one transaction that commits, after the mail has gone", async () => {
    await resend();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    expect(begun).toBeGreaterThan(directorEmails.sendDirectorApprovalEmail.mock.invocationCallOrder[0]);
    expect(orderOf(STAMP)).toBeGreaterThan(begun);
    expect(rows()[0].order).toBeGreaterThan(orderOf(STAMP));
    expect(rows()[0].order).toBeLessThan(committed);
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
  });

  it("a send that fails writes a quote.director_request_failed row marked as a resend, and answers as it always did", async () => {
    directorEmails.sendDirectorApprovalEmail.mockRejectedValue(new Error("Graph is down"));

    const res = await resend();

    expect(res.status).toBe(500);
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      action: "quote.director_request_failed",
      after: { amount: 5000, contractorId: 3, contractorName: "Acme", currency: "AUD", resend: true },
      isException: true,
      ruleApplied: "send_failed",
      subjectId: "7",
    });
    expect(orderOf(STAMP)).toBe(-1);
  });

  it("answers the same 500 when the failure can't be recorded either", async () => {
    directorEmails.sendDirectorApprovalEmail.mockRejectedValue(new Error("Graph is down"));
    mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, awaiting(), stored, NAMES]);

    const res = await resend();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("rolls the stamp back when the row for the send can't be written", async () => {
    mockSql([LEDGER_FAILS, APP_USER, JOB_BUILDING, awaiting(), stored, NAMES]);

    const res = await resend();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(STAMP)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
  });

  it("answers 409 and sends nothing when an earlier send left its claim", async () => {
    mockSql([
      APP_USER, JOB_BUILDING, awaiting(), stored, NAMES,
      { match: /UPDATE Quotes SET DirectorEmailAttemptedAt = SYSUTCDATETIME\(\)/, rows: [] },
      { match: /SELECT DirectorEmailAttemptedAt FROM Quotes/, rows: [{ DirectorEmailAttemptedAt: new Date("2026-10-23T01:02:03Z") }] },
    ]);

    const res = await resend();

    expect(res.status).toBe(409);
    expect((res.jsonBody as { error: string }).error).toContain("check with the director");
    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
  });

  it("a quote that isn't awaiting the director is the same 400: nothing sent, nothing recorded", async () => {
    mockSql([APP_USER, JOB_BUILDING, awaiting({ Status: "approved" }), stored]);

    const res = await resend();

    expect(res).toEqual({ jsonBody: { error: "Quote is not in awaiting_director state" }, status: 400 });
    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
    expect(rows()).toHaveLength(0);
  });

  it("404s an unknown quote, sending nothing", async () => {
    mockSql([APP_USER, JOB_BUILDING]);

    const res = await resend();

    expect(res.status).toBe(404);
    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
  });

  it("answers 401 and sends nothing when the ledger can't name who pressed resend", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(CALLER).mockResolvedValueOnce(null);

    const res = await resend();

    expect(res.status).toBe(401);
    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("records a refused role as `denied`, answers with the gate's own 403 and sends nothing", async () => {
    const gate = { jsonBody: { details: "Required role: accounts | director | facilities. Have: user", error: "Forbidden" }, status: 403 };
    auth.requireRole.mockResolvedValue(gate);
    auth.rolesForRequest.mockResolvedValue(["user"]);
    mockSql([APP_USER, { match: /FROM Quotes s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] }]);

    const res = await resend();

    expect(res).toBe(gate);
    expect(rows()).toEqual([
      expect.objectContaining({
        action: "denied",
        actorRole: "user",
        before: { attempted: "quote.director_request_sent" },
        buildingId: 5,
        isException: true,
        jobId: 9,
        ruleApplied: "role_not_permitted",
        subjectId: "7",
        subjectType: "quote",
      }),
    ]);
    expect(directorEmails.sendDirectorApprovalEmail).not.toHaveBeenCalled();
  });
});

describe("migration 117 still pending (review 117 R2)", () => {
  const quoteRow: Route = {
    match: /SELECT JobID, QuoteNumber, ContractorName, Amount/,
    rows: [{ Amount: 500, ContractorID: 3, ContractorName: "Acme", Currency: "AUD", JobID: 9, QuoteNumber: "QT-9-1", Status: "pending" }],
  };
  afterEach(() => columnProbe.quoteAttributionColumnExists.mockResolvedValue(true));

  it("approves without naming the attribution columns, so the write doesn't fail", async () => {
    columnProbe.quoteAttributionColumnExists.mockResolvedValue(false);
    mockSql([APP_USER, JOB_BUILDING, quoteRow, { match: /SELECT\s+QuoteID, JobID/, rows: [{ QuoteID: 7 }] }]);
    expect((await approveQuote(makeRequest({ QuoteID: 7 }), ctx)).status).toBe(200);
    const writes = db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1])).filter((sql: string) => /UPDATE Quotes/.test(sql));
    expect(writes.length).toBeGreaterThan(0);
    for (const sql of writes) expect(sql).not.toMatch(/ApprovalAttributedToUserID|AttributionAnsweredAt/);
  });
});

describe("approveQuote: attributed approval by plain facilities (R2, Connor 13 Oct)", () => {
  const quoteRow: Route = {
    match: /SELECT JobID, QuoteNumber, ContractorName, Amount/,
    rows: [{ Amount: 4500, ContractorID: 3, ContractorName: "Acme", Currency: "AUD", JobID: 9, QuoteNumber: "QT-9-1", Status: "pending" }],
  };
  const stored: Route = { match: /SELECT\s+QuoteID, JobID/, rows: [{ QuoteID: 7 }] };
  const QUOTE_SCOPE: Route = { match: /FROM Quotes s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] };
  const named = (over: Record<string, unknown> = {}): Route => ({
    match: /FROM dbo\.AppUsers WHERE UserID = @UserID/,
    rows: [{ DisplayName: "Mo Manager", Email: "mo@example.com", Role: "facilities_manager", UserID: 30, ...over }],
  });
  const approve = (body: Record<string, unknown>) => approveQuote(makeRequest({ QuoteID: 7, ...body }), ctx);
  const updates = () => sqlCalls().filter((c) => /UPDATE Quotes/.test(c.sql));

  beforeEach(() => {
    process.env.ATTRIBUTED_APPROVAL_ENABLED = "true";
    auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "fi@example.com", name: "Fi Facilities", oid: "fi-oid" });
    auth.rolesForRequest.mockResolvedValue(["facilities"]);
    limitsDb.getCachedApprovalLimits.mockResolvedValue([
      { MaxApprovalAmount: 5000, RoleName: "facilities" },
      { MaxApprovalAmount: 20000, RoleName: "facilities_manager" },
      { MaxApprovalAmount: null, RoleName: "director" },
    ]);
  });

  afterEach(() => {
    delete process.env.ATTRIBUTED_APPROVAL_ENABLED;
  });

  it("is held off unless ATTRIBUTED_APPROVAL_ENABLED is \"true\": facilities isn't let through, and a manager named is ignored", async () => {
    for (const value of [undefined, "1", "TRUE"]) {
      if (value === undefined) delete process.env.ATTRIBUTED_APPROVAL_ENABLED;
      else process.env.ATTRIBUTED_APPROVAL_ENABLED = value;
      auth.requireRole.mockClear();
      mockSql([APP_USER, JOB_BUILDING, quoteRow, named(), stored, QUOTE_SCOPE]);
      const res = await approve({ attributedToUserId: 30, declared: true });
      expect(auth.requireRole.mock.calls[0][1]).not.toContain("facilities");
      expect(res.jsonBody).toMatchObject({ code: "attribution_required" });
      expect(notices.raiseAttributionNotice).not.toHaveBeenCalled();
    }
  });

  it.each([
    ["an admin (decision 4)", { Role: "admin", UserID: 40 }, 40],
    ["an accounts clerk, whose own $5,000 row would cover it", { Role: "accounts", UserID: 41 }, 41],
  ])("refuses %s as the manager who agreed (422), approving nothing", async (_label, over, id) => {
    mockSql([APP_USER, JOB_BUILDING, quoteRow, named(over), stored, QUOTE_SCOPE]);
    limitsDb.getCachedApprovalLimits.mockResolvedValue([
      { MaxApprovalAmount: 5000, RoleName: "facilities" },
      { MaxApprovalAmount: 5000, RoleName: "accounts" },
      { MaxApprovalAmount: 50000, RoleName: "admin" },
      { MaxApprovalAmount: 20000, RoleName: "facilities_manager" },
      { MaxApprovalAmount: null, RoleName: "director" },
    ]);

    const res = await approve({ attributedToUserId: id, declared: true });

    expect(res.status).toBe(422);
    expect(res.jsonBody).toMatchObject({ code: "attribution_invalid" });
    expect(updates()).toEqual([]);
  });

  it("refuses the manager who added the quote as the one who agreed to it (J3, no self-approval by proxy)", async () => {
    mockSql([APP_USER, JOB_BUILDING, { ...quoteRow, rows: [{ ...quoteRow.rows![0], CreatedBy: "Mo Manager" }] }, named(), stored, QUOTE_SCOPE]);

    const res = await approve({ attributedToUserId: 30, declared: true });

    expect(res).toEqual({
      jsonBody: { code: "attribution_invalid", error: "Mo Manager added this quote, so they can't be the manager who agreed to it. Name someone else." },
      status: 422,
    });
    expect(updates()).toEqual([]);
    expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ action: "denied", ruleApplied: "attribution_invalid" })]);
  });

  it("lets plain facilities through the role gate", async () => {
    mockSql([APP_USER, JOB_BUILDING, quoteRow, named(), stored]);
    await approve({ attributedToUserId: 30, declared: true });
    expect(auth.requireRole).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(["facilities"]));
  });

  it("within the officer's row, declared and naming a manager who could approve it: approved, stored, ledgered and noticed", async () => {
    mockSql([APP_USER, JOB_BUILDING, quoteRow, named(), stored]);

    const res = await approve({ attributedToUserId: 30, declared: true });

    expect(res.status).toBe(200);
    const update = calledWith(/UPDATE Quotes/);
    expect(update?.sql).toMatch(/ApprovalAttributedToUserID = @AttributedTo/);
    expect(update?.sql).toMatch(/ApprovalAttributionDeclaredAt = SYSUTCDATETIME\(\)/);
    expect(update?.params).toMatchObject({ AttributedTo: 30, Status: "approved" });
    expect(calledWith(/INSERT INTO JobEvents/)?.params.Text).toBe("Approved by Fi Facilities, agreed with Mo Manager — QT-9-1 from Acme");
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "quote.approve_attributed",
        actorName: "Fi Facilities",
        actorRole: "facilities",
        attributedName: "Mo Manager",
        attributedRole: "facilities_manager",
        attributedUserId: 30,
        isException: false,
        ruleApplied: "attributed",
      }),
    ]);
    expect(notices.raiseAttributionNotice).toHaveBeenCalledWith(expect.anything(), {
      actor: expect.objectContaining({ name: "Fi Facilities" }),
      managerUserId: 30,
      ref: { id: 7, jobId: 9, kind: "quote" },
    });
    expect(db.commitTransaction.mock.invocationCallOrder[0]).toBeLessThan(notices.raiseAttributionNotice.mock.invocationCallOrder[0]);
  });

  it.each([
    ["no manager named", {}],
    ["a manager named but nothing declared", { attributedToUserId: 30 }],
    ["declared without a manager", { declared: true }],
  ])("refuses with attribution_required (422) when %s: a `denied` row, nothing written", async (_label, body) => {
    mockSql([APP_USER, JOB_BUILDING, quoteRow, named(), stored, QUOTE_SCOPE]);

    const res = await approve(body);

    expect(res).toEqual({
      jsonBody: { code: "attribution_required", error: "To approve this quote yourself, tick that you discussed it with a manager and name them." },
      status: 422,
    });
    expect(updates()).toEqual([]);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "denied", before: expect.objectContaining({ attempted: "quote.approve" }), ruleApplied: "attribution_required" }),
    ]);
    expect(notices.raiseAttributionNotice).not.toHaveBeenCalled();
  });

  it.each([
    ["someone who couldn't approve it themselves", named({ Role: "facilities", UserID: 31 }), 31],
    ["someone who isn't an active user", { match: /FROM dbo\.AppUsers WHERE UserID = @UserID/, rows: [] }, 32],
    ["the officer themselves", named({ UserID: 21 }), 21],
  ])("refuses with attribution_invalid (422) when the person named is %s", async (_label, who, id) => {
    mockSql([APP_USER, JOB_BUILDING, quoteRow, who as Route, stored, QUOTE_SCOPE]);

    const res = await approve({ attributedToUserId: id, declared: true });

    expect(res.status).toBe(422);
    expect(res.jsonBody).toMatchObject({ code: "attribution_invalid" });
    expect(updates()).toEqual([]);
    expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ action: "denied", ruleApplied: "attribution_invalid" })]);
  });

  it("a malformed manager id is a 400 before anything is read", async () => {
    mockSql([APP_USER, JOB_BUILDING, quoteRow, named(), stored]);
    expect((await approve({ attributedToUserId: "30", declared: true })).status).toBe(400);
    expect((await approve({ attributedToUserId: 30, declared: "yes" })).status).toBe(400);
    expect(updates()).toEqual([]);
  });

  it("above the officer's own row it waits for a manager as before, and records no attribution", async () => {
    mockSql([APP_USER, JOB_BUILDING, { ...quoteRow, rows: [{ ...quoteRow.rows![0], Amount: 6000 }] }, named(), stored]);

    const res = await approve({ attributedToUserId: 30, declared: true });

    expect(res.status).toBe(200);
    expect(calledWith(/UPDATE Quotes/)?.sql).not.toMatch(/ApprovalAttributedToUserID = @AttributedTo/);
    expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ action: "quote.approve", ruleApplied: "over_limit" })]);
    expect(notices.raiseAttributionNotice).not.toHaveBeenCalled();
  });

  it("a caller with authority of their own approves outright; a manager they name is not recorded", async () => {
    auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
    mockSql([APP_USER, JOB_BUILDING, quoteRow, named(), stored]);

    await approve({ attributedToUserId: 30, declared: true });

    expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ action: "quote.approve", ruleApplied: "own_authority" })]);
    // An earlier attribution on this quote no longer applies.
    expect(calledWith(/UPDATE Quotes/)?.sql).toMatch(/ApprovalAttributedToUserID = NULL, ApprovalAttributionDeclaredAt = NULL, AttributionAnsweredAt = NULL/);
    expect(notices.raiseAttributionNotice).not.toHaveBeenCalled();
  });
  it("the named manager's \"I didn't agree to this\" is ledgered against the quote with its money facts", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "mo@example.com", name: "Mo Manager", oid: "mo-oid" });
    auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
    mockSql([
      { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 30 }] },
      {
        match: /FROM Quotes q WITH \(UPDLOCK, HOLDLOCK\)/,
        rows: [{ Amount: 4500, ApprovalAttributedToUserID: 30, ApprovedBy: "Fi Facilities", AttributedToName: "Mo Manager", BuildingID: 5, ContractorID: 3, ContractorName: "Acme", JobID: 9, QuoteNumber: "QT-9-1" }],
      },
    ]);

    const res = await answerApprovalAttribution(makeRequest({ agreed: false, id: 7, kind: "quote", reason: "Never discussed" }), ctx);

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ action: "quote.attribution_disputed", actorName: "Mo Manager", isException: true, reason: "Never discussed" }),
    ]);
  });
});

it("wrote every quote money code in this file, each checked against the shape trend reports read", () => {
  moneyShape.expectEveryCodeWritten("quote.");
});
