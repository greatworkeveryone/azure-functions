/// <reference types="jest" />
// A director's decision recorded from an email reply is ledgered as the same
// quote.director_approve / quote.director_reject as the in-app buttons, with
// ruleApplied "email_reply" and the email in `after` (WP19b, PLAN §3.12). The DB
// layer is mocked; the real ledger and quote-decisions helpers run.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";
import { moneyShape } from "../__tests__/fixtures/moneyRowShape";

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
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn().mockReturnValue({ allowed: true }) }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn() }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));

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
const planner = require("../planner") as { resolveActivePlannerTasks: jest.Mock };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
const { recordEmailQuoteDecision } = require("./emails") as { recordEmailQuoteDecision: Handler };

type Route = { match: RegExp; reject?: Error; rows?: Record<string, unknown>[] };

function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    const hit = routes.find((r) => r.match.test(sql));
    if (hit?.reject) throw hit.reject;
    return hit?.rows ?? [];
  });
}

const orderOf = (re: RegExp): number => {
  const i = db.executeQuery.mock.calls.findIndex((c: unknown[]) => re.test(String(c[1])));
  return i < 0 ? -1 : db.executeQuery.mock.invocationCallOrder[i];
};

function makeRequest(body: unknown): HttpRequest {
  return { headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() } as unknown as HttpRequest;
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const OPERATOR = { email: "ops@co.com", name: "Ops User", oid: "ops-oid" };
const APP_USER: Route = { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 21 }] };
const JOB_BUILDING: Route = { match: /SELECT BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5 }] };
const LEDGER_FAILS: Route = { match: /INSERT INTO dbo\.DecisionLedger/, reject: new Error("ledger unavailable") };

const EMAIL: Route = {
  match: /SELECT EmailID, FromAddress, Status/,
  rows: [
    {
      Body: "Approved, go ahead.",
      EmailID: 42,
      FromAddress: " Dana@Example.com ",
      MatchedJobID: 9,
      ReceivedAt: new Date("2026-10-02T00:00:00Z"),
      SenderAuthenticated: true,
      Source: "graph",
      Status: "new",
    },
  ],
};
const QUOTE: Route = {
  match: /SELECT Status, JobID, DirectorEmailSentTo, DirectorEmailSentAt FROM Quotes/,
  rows: [
    {
      DirectorEmailSentAt: new Date("2026-10-01T00:00:00Z"),
      DirectorEmailSentTo: JSON.stringify(["dana@example.com"]),
      JobID: 9,
      Status: "awaiting_director",
    },
  ],
};
const DIRECTOR: Route = { match: /FROM AppUsers/, rows: [{ DisplayName: "Dana Director", UserID: 31 }] };
const FLIP: Route = { match: /UPDATE Emails/, rows: [{ EmailID: 42 }] };
// The shared helpers' own statements.
const HELPER_QUOTE: Route = {
  match: /SELECT JobID, QuoteNumber/,
  rows: [{ ContractorName: "Acme", JobID: 9, QuoteNumber: "QT-9-1", Status: "awaiting_director" }],
};
const HELPER_WRITES: Route[] = [
  { match: /UPDATE Quotes/, rows: [{ QuoteID: 7 }] },
  {
    match: /SELECT\s+QuoteID, JobID/,
    rows: [{ Amount: 5000, ContractorID: 3, ContractorName: "Acme", Currency: "AUD", JobID: 9, QuoteID: 7, QuoteNumber: "QT-9-1", Status: "approved" }],
  },
];
const HAPPY: Route[] = [APP_USER, JOB_BUILDING, EMAIL, QUOTE, DIRECTOR, FLIP, HELPER_QUOTE, ...HELPER_WRITES];

// A route whose first row is the given one with some columns changed. Prepend
// it to override the happy path: the first matching route wins.
const withRow = (route: Route, over: Record<string, unknown>): Route => ({
  ...route,
  rows: [{ ...(route.rows as Record<string, unknown>[])[0], ...over }],
});

const decide = (over: Record<string, unknown> = {}) =>
  recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7, ...over }), ctx);

beforeEach(() => {
  jest.clearAllMocks();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  // These cases exercise reply-to-approve itself, which is off by default.
  process.env.EMAIL_REPLY_DECISIONS_ENABLED = "true";
  auth.requireRole.mockResolvedValue(null);
  auth.verifiedIdentityFromRequest.mockResolvedValue(OPERATOR);
  auth.rolesForRequest.mockResolvedValue(["accounts_manager"]);
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  db.createRequestConnection.mockResolvedValue({ id: "connection" });
  mockSql(HAPPY);
});

// Every money row any test here writes has the shape trend reports read (see the fixture).
afterEach(() => moneyShape.check(ledgerInserts(db.executeQuery)));
afterEach(() => jest.restoreAllMocks());

describe("a director's emailed approval", () => {
  it("is ledgered as quote.director_approve, by email_reply, with the email in `after`", async () => {
    const res = await decide();

    expect(res.status).toBe(200);
    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "quote.director_approve",
      after: { amount: 5000, contractorName: "Acme", quoteNumber: "QT-9-1", sourceEmailId: 42, status: "approved" },
      before: { status: "awaiting_director" },
      buildingId: 5,
      isException: false,
      jobId: 9,
      ruleApplied: "email_reply",
      subjectId: "7",
      subjectType: "quote",
    });
  });

  it("names the director who replied as the actor, as Quotes.DirectorApprovedBy does", async () => {
    await decide();

    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({
      actorKind: "user",
      actorName: "Dana Director",
      actorRole: "director",
      actorUserId: 31,
    });
  });

  it("puts the signed-in operator who recorded the reply in `after.recordedBy`, and attributes the decision to nobody", async () => {
    await decide();

    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({
      after: { recordedBy: { name: "Ops User", userId: 21 }, sourceEmailId: 42 },
      attributedName: null,
      attributedRole: null,
      attributedUserId: null,
    });
  });

  it("is the same person twice when the director recorded their own reply", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "dana@example.com", name: "Dana Director", oid: "director-oid" });
    mockSql([{ match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 31 }] }, ...HAPPY]);

    const res = await decide();

    expect(res.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({
      actorName: "Dana Director",
      actorUserId: 31,
      after: { recordedBy: { name: "Dana Director", userId: 31 } },
      attributedName: null,
    });
  });

  it("takes the actor from the sender's AppUsers row, never from the signed-in caller or the body", async () => {
    await decide({ ActorName: "Mallory", RecordedBy: "Mallory" });

    const [row] = ledgerInserts(db.executeQuery);
    expect(row.actorName).toBe("Dana Director");
    expect(JSON.stringify(row)).not.toContain("Mallory");
  });

  it("carries the director's note as the reason", async () => {
    await decide({ Note: "  Subject to council sign-off " });

    expect(ledgerInserts(db.executeQuery)[0].reason).toBe("Subject to council sign-off");
  });

  it("clips a note the endpoint accepts but the ledger can't hold, and still records the decision", async () => {
    const res = await decide({ Note: "a".repeat(3900) });

    expect(res.status).toBe(200);
    expect(String(ledgerInserts(db.executeQuery)[0].reason)).toHaveLength(2000);
  });

  it("keeps a long display name inside the ledger's limit", async () => {
    mockSql([withRow(DIRECTOR, { DisplayName: "C".repeat(250) }), ...HAPPY]);

    const res = await decide();

    expect(res.status).toBe(200);
    expect(String(ledgerInserts(db.executeQuery)[0].actorName)).toHaveLength(200);
  });

  it("writes the helper's changes, the email flip and the ledger row inside one transaction that commits", async () => {
    await decide();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    for (const write of [/UPDATE Quotes/, /UPDATE Jobs/, /INSERT INTO JobEvents/, /UPDATE Emails/, /INSERT INTO dbo\.DecisionLedger/]) {
      expect(orderOf(write)).toBeGreaterThan(begun);
      expect(orderOf(write)).toBeLessThan(committed);
    }
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(orderOf(/UPDATE Emails/));
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
    expect(planner.resolveActivePlannerTasks).toHaveBeenCalledWith("job", 9, ["director_approval"]);
  });

  it("is rolled back when the ledger write fails: the quote stays awaiting the director and the email unhandled", async () => {
    mockSql([LEDGER_FAILS, ...HAPPY]);

    const res = await decide();

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(orderOf(/UPDATE Quotes/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    expect(orderOf(/UPDATE Emails/)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    expect(planner.resolveActivePlannerTasks).not.toHaveBeenCalled();
  });

  it("writes no ledger row when the email was handled concurrently", async () => {
    mockSql([{ match: /UPDATE Emails/, rows: [] }, ...HAPPY]);

    const res = await decide();

    expect(res.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });

  it("a job that is done or already has an approved quote refuses the emailed approval: one `denied` row, nothing written", async () => {
    const cases: [Record<string, unknown>, string][] = [[{ Status: "Done" }, "job_done"], [{ HasApprovedQuote: 1 }, "quote_already_approved"]];
    for (const [over, code] of cases) {
      db.executeQuery.mockClear();
      mockSql([
        {
          match: /SELECT j\.JobID, j\.Status, j\.IsInternal, j\.IsArchived/,
          rows: [{ BuildingID: 5, HasApprovedQuote: 0, IsArchived: false, IsContract: false, IsInternal: false, JobID: 9, Status: "Awaiting Approval", ...over }],
        },
        { match: /FROM Quotes s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] },
        ...HAPPY,
      ]);

      const res = await decide();

      expect(res).toMatchObject({ jsonBody: { code }, status: 409 });
      expect(db.executeQuery.mock.calls.some((c: unknown[]) => /UPDATE (Quotes|Jobs|Emails)/.test(String(c[1])))).toBe(false);
      expect(ledgerInserts(db.executeQuery)).toEqual([
        expect.objectContaining({ action: "denied", before: expect.objectContaining({ attempted: "quote.director_approve" }), ruleApplied: code }),
      ]);
    }
  });

  it("writes no ledger row when the helper refuses", async () => {
    mockSql([withRow(HELPER_QUOTE, { Status: "approved" }), ...HAPPY]);

    const res = await decide();

    expect(res.status).toBe(409);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });
});

describe("a director's emailed rejection", () => {
  const rejectRoutes: Route[] = [
    { match: /UPDATE Quotes SET Status = 'rejected'/, rows: [{ QuoteID: 7 }] },
    withRow(HELPER_WRITES[1], { Status: "rejected" }),
    withRow(EMAIL, { Body: "Rejected, too expensive." }),
    ...HAPPY,
  ];

  it("is ledgered as quote.director_reject with the reason they gave", async () => {
    mockSql(rejectRoutes);

    const res = await decide({ Decision: "rejected", Note: "Too expensive" });

    expect(res.status).toBe(200);
    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "quote.director_reject",
      actorName: "Dana Director",
      actorRole: "director",
      after: { recordedBy: { name: "Ops User", userId: 21 }, sourceEmailId: 42, status: "rejected" },
      attributedName: null,
      before: { status: "awaiting_director" },
      jobId: 9,
      reason: "Too expensive",
      ruleApplied: "email_reply",
      subjectId: "7",
    });
  });

  it("is rolled back when the ledger write fails", async () => {
    mockSql([LEDGER_FAILS, ...rejectRoutes]);

    const res = await decide({ Decision: "rejected" });

    expect(res.status).toBe(500);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("a reply that can't stand as the director's decision", () => {
  const refusalRows = () => ledgerInserts(db.executeQuery);

  it("not from a recipient of the packet: 422 as before, one `denied` row naming what was attempted", async () => {
    mockSql([withRow(QUOTE, { DirectorEmailSentTo: JSON.stringify(["pat@example.com"]) }), ...HAPPY]);

    const res = await decide();

    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: string }).error).toBe("Sender was not a recipient of the director approval email");
    expect(refusalRows()).toHaveLength(1);
    expect(refusalRows()[0]).toMatchObject({
      action: "denied",
      actorName: "Ops User",
      actorRole: "accounts_manager",
      before: { attempted: "quote.director_approve" },
      buildingId: 5,
      isException: true,
      jobId: 9,
      reason: "Sender was not a recipient of the director approval email",
      ruleApplied: "sender_not_recipient",
      subjectId: "7",
      subjectType: "quote",
    });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("a rejection that is refused is recorded as a refused quote.director_reject", async () => {
    mockSql([{ match: /FROM AppUsers/, rows: [] }, ...HAPPY]);

    const res = await decide({ Decision: "rejected" });

    expect(res.status).toBe(422);
    expect(refusalRows()).toEqual([
      expect.objectContaining({ before: { attempted: "quote.director_reject" }, ruleApplied: "sender_not_director" }),
    ]);
  });

  it("not authenticated: recorded against the job the email was matched to", async () => {
    mockSql([withRow(EMAIL, { SenderAuthenticated: false }), ...HAPPY]);

    const res = await decide();

    expect(res.status).toBe(422);
    expect(refusalRows()).toEqual([expect.objectContaining({ buildingId: 5, jobId: 9, ruleApplied: "sender_not_authenticated" })]);
  });

  it("an unmatched email is recorded with no job", async () => {
    mockSql([withRow(EMAIL, { MatchedJobID: null, Source: "ingest" }), ...HAPPY]);

    const res = await decide();

    expect(res.status).toBe(422);
    expect(refusalRows()).toEqual([expect.objectContaining({ buildingId: null, jobId: null, ruleApplied: "email_not_from_mailbox" })]);
  });

  it("answers the same 422 even when the refusal can't be recorded", async () => {
    mockSql([LEDGER_FAILS, { match: /FROM AppUsers/, rows: [] }, ...HAPPY]);

    const res = await decide();

    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: string }).error).toBe("Sender is not an active director");
  });

  it("a quote that is no longer awaiting the director is a conflict, not a refused attempt: nothing is recorded", async () => {
    mockSql([withRow(QUOTE, { Status: "approved" }), ...HAPPY]);

    const res = await decide();

    expect(res.status).toBe(409);
    expect(refusalRows()).toHaveLength(0);
  });

  it("the role gate refusing is recorded as role_not_permitted, and answers as before", async () => {
    const gate = { jsonBody: { details: "Required role: accounts_manager | facilities_manager. Have: user", error: "Forbidden" }, status: 403 };
    auth.requireRole.mockResolvedValue(gate);
    auth.rolesForRequest.mockResolvedValue(["user"]);
    mockSql([APP_USER, JOB_BUILDING, { match: /FROM Quotes s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] }]);

    const res = await decide();

    expect(res).toBe(gate);
    expect(refusalRows()).toEqual([
      expect.objectContaining({ actorRole: "user", before: { attempted: "quote.director_approve" }, ruleApplied: "role_not_permitted", subjectId: "7" }),
    ]);
  });

  it("the role gate refusing a rejection is recorded as a refused quote.director_reject", async () => {
    auth.requireRole.mockResolvedValue({ jsonBody: { details: "Required role: x. Have: user" }, status: 403 });
    auth.rolesForRequest.mockResolvedValue(["user"]);
    mockSql([APP_USER, JOB_BUILDING, { match: /FROM Quotes s INNER JOIN Jobs j/, rows: [{ BuildingID: 5, JobID: 9 }] }]);

    await decide({ Decision: "rejected" });

    expect(refusalRows()).toEqual([expect.objectContaining({ before: { attempted: "quote.director_reject" } })]);
  });

  it("switching email decisions off is a policy, not a refused attempt: no ledger row", async () => {
    process.env.EMAIL_REPLY_DECISIONS_ENABLED = "false";

    const res = await decide();

    expect(res.status).toBe(403);
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBe(-1);
  });
});
