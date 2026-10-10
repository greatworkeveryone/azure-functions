/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
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
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({
      email: "ops@co.com",
      name: "Ops User",
      oid: "caller-oid-123",
    }),
  };
});

jest.mock("../blob-storage", () => ({
  generateReadSasUrl: jest.fn().mockReturnValue("https://acct.blob.core.windows.net/x?sig=1"),
}));
jest.mock("../graph", () => ({ graphFetchEmails: jest.fn() }));
jest.mock("../rateLimit", () => ({
  checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }),
}));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn() }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../quote-decisions", () => ({
  approveDirectorQuote: jest.fn(),
  rejectQuote: jest.fn(),
}));

const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const statusHelpers = require("../jobStatusHelpers") as { advanceJobStatus: jest.Mock };
const quoteDecisions = require("../quote-decisions") as {
  approveDirectorQuote: jest.Mock;
  rejectQuote: jest.Mock;
};
const planner = require("../planner") as { resolveActivePlannerTasks: jest.Mock };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: unknown }>;
const { ingestEmail, promoteEmailToJobUpdate, recordEmailQuoteDecision } = require("./emails") as {
  ingestEmail: Handler;
  promoteEmailToJobUpdate: Handler;
  recordEmailQuoteDecision: Handler;
};

type SqlRoute = [RegExp, Record<string, unknown>[]];

// Answer each SQL statement by shape; anything unrouted returns no rows.
function routeSql(routes: SqlRoute[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    const hit = routes.find(([re]) => re.test(sql));
    return hit ? hit[1] : [];
  });
}

function sqlCalls(): { params: Record<string, unknown>; sql: string }[] {
  return db.executeQuery.mock.calls.map((c: unknown[]) => ({
    params: Object.fromEntries(
      ((c[2] as { name: string; value: unknown }[] | undefined) ?? []).map((p) => [p.name, p.value]),
    ),
    sql: String(c[1]),
  }));
}

function makeRequest(body: unknown): HttpRequest {
  return {
    headers: { get: () => null },
    json: jest.fn().mockResolvedValue(body),
    query: new URLSearchParams(),
  } as unknown as HttpRequest;
}

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

beforeEach(() => {
  jest.clearAllMocks();
});

describe("promoteEmailToJobUpdate", () => {
  const emailRow = (status = "new", matchedJobId: number | null = null): SqlRoute => [
    /SELECT Status, MatchedJobID FROM Emails/,
    [{ MatchedJobID: matchedJobId, Status: status }],
  ];
  const emailExists: SqlRoute = emailRow();
  const flipOk: SqlRoute = [/UPDATE Emails/, [{ EmailID: 42 }]];
  const insertedEvent: SqlRoute = [/INSERT INTO JobEvents/, [{ JobEventID: 501 }]];
  const jobIn = (status: string, role = "facilities"): SqlRoute => [
    /SELECT Status, AwaitingRole FROM Jobs/,
    [{ AwaitingRole: role, Status: status }],
  ];

  it("writes the note with SourceEmailID, flips the email and commits", async () => {
    routeSql([emailExists, jobIn("Quote"), insertedEvent, flipOk]);

    const res = await promoteEmailToJobUpdate(
      makeRequest({ EmailID: 42, JobID: 7, Text: "  Scheduled for Tuesday  " }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ eventId: 501, jobId: 7, newStatus: null });
    const insert = sqlCalls().find((c) => /INSERT INTO JobEvents/.test(c.sql));
    expect(insert?.sql).toContain("'email_update'");
    expect(insert?.params).toMatchObject({ CreatedBy: "Ops User", EmailID: 42, JobID: 7, Text: "Scheduled for Tuesday" });
    const flip = sqlCalls().find((c) => /UPDATE Emails/.test(c.sql));
    expect(flip?.sql).toMatch(/Status = 'promoted'/);
    expect(flip?.sql).toMatch(/MatchedJobID = @JobID/);
    expect(flip?.sql).not.toMatch(/COALESCE/);
    expect(flip?.sql).toMatch(/OUTPUT inserted\.EmailID/);
    expect(flip?.sql).toMatch(/Status NOT IN \('promoted', 'archived'\)/);
    expect(flip?.params).toMatchObject({ Id: 42, JobID: 7 });
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
    expect(statusHelpers.advanceJobStatus).not.toHaveBeenCalled();
  });

  it("fires WORK_COMPLETED through advanceJobStatus when MarkWorkCompleted is true from Work", async () => {
    routeSql([emailExists, jobIn("Work"), insertedEvent, flipOk]);
    statusHelpers.advanceJobStatus.mockResolvedValue({
      advanced: true,
      from: { awaitingRole: "facilities", status: "Work" },
      to: { awaitingRole: "accounts", status: "Awaiting Approval" },
    });

    const res = await promoteEmailToJobUpdate(
      makeRequest({ EmailID: 42, JobID: 7, MarkWorkCompleted: true, Text: "All done" }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ eventId: 501, jobId: 7, newStatus: "Awaiting Approval" });
    expect(statusHelpers.advanceJobStatus).toHaveBeenCalledWith({}, 7, "WORK_COMPLETED", { actor: "Ops User" });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("returns 422 and writes nothing when MarkWorkCompleted is illegal from the job's state", async () => {
    routeSql([emailExists, jobIn("New"), insertedEvent]);

    const res = await promoteEmailToJobUpdate(
      makeRequest({ EmailID: 42, JobID: 7, MarkWorkCompleted: true, Text: "All done" }),
      ctx,
    );

    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: string }).error).toMatch(/Cannot mark work completed/);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(sqlCalls().some((c) => /INSERT|UPDATE/i.test(c.sql))).toBe(false);
    expect(statusHelpers.advanceJobStatus).not.toHaveBeenCalled();
  });

  it("rolls back with 409 when the status write loses a race", async () => {
    routeSql([emailExists, jobIn("Work"), insertedEvent, flipOk]);
    statusHelpers.advanceJobStatus.mockResolvedValue({
      advanced: false,
      from: { awaitingRole: "facilities", status: "Work" },
      to: null,
    });

    const res = await promoteEmailToJobUpdate(
      makeRequest({ EmailID: 42, JobID: 7, MarkWorkCompleted: true, Text: "All done" }),
      ctx,
    );

    expect(res.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 when Text is empty", async () => {
    const res = await promoteEmailToJobUpdate(makeRequest({ EmailID: 42, JobID: 7, Text: "   " }), ctx);

    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("returns 404 when the job does not exist", async () => {
    routeSql([emailExists]);

    const res = await promoteEmailToJobUpdate(makeRequest({ EmailID: 42, JobID: 7, Text: "hi" }), ctx);

    expect(res.status).toBe(404);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it.each(["promoted", "archived"])("returns 422 when the email is already %s", async (status) => {
    routeSql([emailRow(status), jobIn("Quote"), insertedEvent, flipOk]);

    const res = await promoteEmailToJobUpdate(makeRequest({ EmailID: 42, JobID: 7, Text: "hi" }), ctx);

    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: string }).error).toMatch(new RegExp(status));
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("rolls back with 409 when the email flip matches no row (promoted concurrently)", async () => {
    routeSql([emailExists, jobIn("Quote"), insertedEvent, [/UPDATE Emails/, []]]);

    const res = await promoteEmailToJobUpdate(makeRequest({ EmailID: 42, JobID: 7, Text: "hi" }), ctx);

    expect(res.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("overwrites a mismatched MatchedJobID with the operator's job and logs it", async () => {
    routeSql([emailRow("new", 3), jobIn("Quote"), insertedEvent, flipOk]);

    const res = await promoteEmailToJobUpdate(makeRequest({ EmailID: 42, JobID: 7, Text: "hi" }), ctx);

    expect(res.status).toBe(200);
    const insert = sqlCalls().find((c) => /INSERT INTO JobEvents/.test(c.sql));
    expect(insert?.params).toMatchObject({ JobID: 7 });
    const flip = sqlCalls().find((c) => /UPDATE Emails/.test(c.sql));
    expect(flip?.params).toMatchObject({ Id: 42, JobID: 7 });
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("3"));
    expect(ctx.log).toHaveBeenCalledWith(expect.stringContaining("7"));
  });

  it("does not log an override when the email was already matched to the same job", async () => {
    routeSql([emailRow("new", 7), jobIn("Quote"), insertedEvent, flipOk]);

    await promoteEmailToJobUpdate(makeRequest({ EmailID: 42, JobID: 7, Text: "hi" }), ctx);

    expect(ctx.log).not.toHaveBeenCalled();
  });

  it("returns 404 when the email does not exist", async () => {
    routeSql([]);

    const res = await promoteEmailToJobUpdate(makeRequest({ EmailID: 42, JobID: 7, Text: "hi" }), ctx);

    expect(res.status).toBe(404);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("returns 400 when MarkWorkCompleted is not a boolean", async () => {
    const res = await promoteEmailToJobUpdate(
      makeRequest({ EmailID: 42, JobID: 7, MarkWorkCompleted: "yes", Text: "hi" }),
      ctx,
    );

    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it.each([1.5, -1, 0, 2147483648, "7", null])("returns 400 for invalid JobID %p", async (bad) => {
    const res = await promoteEmailToJobUpdate(makeRequest({ EmailID: 42, JobID: bad, Text: "hi" }), ctx);

    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it.each([1.5, -1, 0, 2147483648])("returns 400 for invalid EmailID %p", async (bad) => {
    const res = await promoteEmailToJobUpdate(makeRequest({ EmailID: bad, JobID: 7, Text: "hi" }), ctx);

    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("returns 400 when Text exceeds 4,000 characters, and accepts exactly 4,000", async () => {
    const tooLong = await promoteEmailToJobUpdate(makeRequest({ EmailID: 42, JobID: 7, Text: "a".repeat(4001) }), ctx);
    expect(tooLong.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();

    routeSql([emailExists, jobIn("Quote"), insertedEvent, flipOk]);
    const ok = await promoteEmailToJobUpdate(makeRequest({ EmailID: 42, JobID: 7, Text: "a".repeat(4000) }), ctx);
    expect(ok.status).toBe(200);
  });
});

describe("recordEmailQuoteDecision", () => {
  const emailWith = (over: Record<string, unknown> = {}): SqlRoute => [
    /SELECT EmailID, FromAddress, Status, MatchedJobID, ReceivedAt, Source, SenderAuthenticated FROM Emails/,
    [
      {
        EmailID: 42,
        FromAddress: " Carlo@Randazzo.properties ",
        MatchedJobID: 9,
        ReceivedAt: new Date("2026-10-02T00:00:00Z"),
        SenderAuthenticated: true,
        Source: "graph",
        Status: "new",
        ...over,
      },
    ],
  ];
  const email: SqlRoute = emailWith();
  const quote = (
    status: string,
    sentTo: string | null = JSON.stringify(["carlo@randazzo.properties", "paolo@randazzo.properties"]),
    over: Record<string, unknown> = {},
  ): SqlRoute => [
    /SELECT Status, JobID, DirectorEmailSentTo, DirectorEmailSentAt FROM Quotes/,
    [
      {
        DirectorEmailSentAt: new Date("2026-10-01T00:00:00Z"),
        DirectorEmailSentTo: sentTo,
        JobID: 9,
        Status: status,
        ...over,
      },
    ],
  ];
  const director: SqlRoute = [/FROM AppUsers/, [{ DisplayName: "Carlo Randazzo" }]];
  const flipOk: SqlRoute = [/UPDATE Emails/, [{ EmailID: 42 }]];
  const storedQuote = { QuoteID: 7, Status: "approved" };

  beforeEach(() => {
    quoteDecisions.approveDirectorQuote.mockResolvedValue({ jobId: 9, ok: true, quote: storedQuote });
    quoteDecisions.rejectQuote.mockResolvedValue({
      jobId: 9,
      ok: true,
      previousStatus: "awaiting_director",
      quote: { ...storedQuote, Status: "rejected" },
    });
    planner.resolveActivePlannerTasks.mockResolvedValue(undefined);
  });

  const NOT_MAILBOX = "Only emails received through the mailbox can record a director decision";
  const NOT_AUTHENTICATED =
    "The sender of this email couldn't be authenticated (DMARC/internal check failed) — ask the director to approve in-app";

  it.each([
    ["ingest", "ingest", true, NOT_MAILBOX],
    ["unknown (NULL) source", null, true, NOT_MAILBOX],
    ["unauthenticated graph", "graph", false, NOT_AUTHENTICATED],
    ["graph with NULL SenderAuthenticated", "graph", null, NOT_AUTHENTICATED],
  ])("422 for an %s email, before any director check", async (_label, source, authenticated, message) => {
    routeSql([
      emailWith({ SenderAuthenticated: authenticated, Source: source }),
      quote("awaiting_director"),
      director,
      flipOk,
    ]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: string }).error).toBe(message);
    expect(sqlCalls().some((c) => /FROM AppUsers/.test(c.sql))).toBe(false);
    expect(sqlCalls().some((c) => /FROM Quotes/.test(c.sql))).toBe(false);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("accepts a BIT returned as 1", async () => {
    routeSql([emailWith({ SenderAuthenticated: 1 }), quote("awaiting_director"), director, flipOk]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(200);
  });

  it("409 when the quote is not awaiting the director", async () => {
    routeSql([email, quote("pending"), director]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(409);
    expect((res.jsonBody as { error: string }).error).toBe("Quote must be in awaiting_director state");
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("422 when the sender was not a recipient of the director email", async () => {
    routeSql([email, quote("awaiting_director", JSON.stringify(["paolo@randazzo.properties"])), director]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: string }).error).toBe("Sender was not a recipient of the director approval email");
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("422 when the sender is not an active AppUsers director", async () => {
    routeSql([email, quote("awaiting_director")]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: string }).error).toBe("Sender is not an active director");
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("422 when the sender is an admin, not a director — admins are excluded by policy", async () => {
    // The lookup is the literal Role = 'director'; an admin row never matches.
    routeSql([email, quote("awaiting_director")]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(422);
    const lookup = sqlCalls().find((c) => /FROM AppUsers/.test(c.sql));
    expect(lookup?.sql).toMatch(/Role = 'director'/);
    expect(lookup?.sql).not.toMatch(/admin/i);
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("approves through the shared director helper with the sender's display name and flips the email", async () => {
    routeSql([email, quote("awaiting_director"), director, flipOk]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ quote: storedQuote });
    expect(quoteDecisions.approveDirectorQuote).toHaveBeenCalledWith({}, {
      approvedBy: "Carlo Randazzo",
      note: null,
      quoteId: 7,
      sourceEmailId: 42,
    });
    const lookup = sqlCalls().find((c) => /FROM AppUsers/.test(c.sql));
    expect(lookup?.params).toMatchObject({ Email: "carlo@randazzo.properties" });
    expect(lookup?.sql).toMatch(/Role = 'director'/);
    expect(lookup?.sql).toMatch(/IsActive = 1/);
    const flip = sqlCalls().find((c) => /UPDATE Emails/.test(c.sql));
    expect(flip?.sql).toMatch(/Status = 'promoted'/);
    expect(flip?.sql).toMatch(/OUTPUT inserted\.EmailID/);
    expect(flip?.sql).toMatch(/Status NOT IN \('promoted', 'archived'\)/);
    expect(flip?.params).toMatchObject({ Id: 42 });
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(quoteDecisions.rejectQuote).not.toHaveBeenCalled();
    expect(planner.resolveActivePlannerTasks).toHaveBeenCalledWith("job", 9, ["director_approval"]);
  });

  it("passes the optional Note through to the approve helper", async () => {
    routeSql([email, quote("awaiting_director"), director, flipOk]);

    const res = await recordEmailQuoteDecision(
      makeRequest({ Decision: "approved", EmailID: 42, Note: "Subject to council sign-off", QuoteID: 7 }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(quoteDecisions.approveDirectorQuote).toHaveBeenCalledWith({}, {
      approvedBy: "Carlo Randazzo",
      note: "Subject to council sign-off",
      quoteId: 7,
      sourceEmailId: 42,
    });
  });

  it("rejects through the shared helper with the note; the actor is server-derived, never the body", async () => {
    routeSql([email, quote("awaiting_director"), director, flipOk]);

    const res = await recordEmailQuoteDecision(
      makeRequest({ Decision: "rejected", EmailID: 42, Note: "Too expensive", QuoteID: 7, RejectedBy: "Mallory" }),
      ctx,
    );

    expect(res.status).toBe(200);
    expect(quoteDecisions.rejectQuote).toHaveBeenCalledWith({}, {
      expectedStatuses: ["awaiting_director"],
      note: "Too expensive",
      quoteId: 7,
      rejectedBy: "Carlo Randazzo",
      sourceEmailId: 42,
    });
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("reject from awaiting_director resolves the director Planner task", async () => {
    routeSql([email, quote("awaiting_director"), director, flipOk]);

    await recordEmailQuoteDecision(makeRequest({ Decision: "rejected", EmailID: 42, QuoteID: 7 }), ctx);

    expect(planner.resolveActivePlannerTasks).toHaveBeenCalledWith("job", 9, ["director_approval"]);
  });

  it("still returns 200 when the Planner resolve throws", async () => {
    routeSql([email, quote("awaiting_director"), director, flipOk]);
    planner.resolveActivePlannerTasks.mockRejectedValue(new Error("graph down"));

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "rejected", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ quote: { ...storedQuote, Status: "rejected" } });
    expect(ctx.warn).toHaveBeenCalled();
  });

  it("rolls back and surfaces the helper's refusal", async () => {
    routeSql([email, quote("awaiting_director"), director, flipOk]);
    quoteDecisions.approveDirectorQuote.mockResolvedValue({
      error: "Quote is already fully approved",
      ok: false,
      status: 409,
    });

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(sqlCalls().some((c) => /UPDATE Emails/.test(c.sql))).toBe(false);
    expect(planner.resolveActivePlannerTasks).not.toHaveBeenCalled();
  });

  it.each(["promoted", "archived"])("422 when the email is already %s", async (status) => {
    routeSql([emailWith({ Status: status }), quote("awaiting_director"), director, flipOk]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(422);
    expect((res.jsonBody as { error: string }).error).toMatch(new RegExp(status));
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("422 when the email is not matched to any job", async () => {
    routeSql([emailWith({ MatchedJobID: null }), quote("awaiting_director"), director, flipOk]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(422);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("422 when the email is matched to a different job than the quote", async () => {
    routeSql([emailWith({ MatchedJobID: 3 }), quote("awaiting_director"), director, flipOk]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(422);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("422 when the email was received before the director packet was sent", async () => {
    routeSql([
      emailWith({ ReceivedAt: new Date("2026-09-30T00:00:00Z") }),
      quote("awaiting_director"),
      director,
      flipOk,
    ]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(422);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("422 when no director packet was ever sent (DirectorEmailSentAt is null)", async () => {
    routeSql([email, quote("awaiting_director", undefined, { DirectorEmailSentAt: null }), director, flipOk]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(422);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(quoteDecisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("rolls back with 409 when the email flip matches no row (decided concurrently)", async () => {
    routeSql([email, quote("awaiting_director"), director, [/UPDATE Emails/, []]]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(planner.resolveActivePlannerTasks).not.toHaveBeenCalled();
  });

  it("falls back to the sender address when the director has no DisplayName", async () => {
    routeSql([email, quote("awaiting_director"), [/FROM AppUsers/, [{ DisplayName: null }]], flipOk]);

    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(200);
    expect(quoteDecisions.approveDirectorQuote).toHaveBeenCalledWith({}, {
      approvedBy: "carlo@randazzo.properties",
      note: null,
      quoteId: 7,
      sourceEmailId: 42,
    });
  });

  it.each([
    ["QuoteID", 1.5],
    ["QuoteID", -1],
    ["QuoteID", 2147483648],
    ["EmailID", 1.5],
    ["EmailID", 0],
    ["EmailID", 2147483648],
  ])("400 for invalid %s %p", async (field, bad) => {
    const res = await recordEmailQuoteDecision(
      makeRequest({ Decision: "approved", EmailID: 42, QuoteID: 7, [field]: bad }),
      ctx,
    );

    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("400 when Note exceeds 4,000 characters", async () => {
    const res = await recordEmailQuoteDecision(
      makeRequest({ Decision: "rejected", EmailID: 42, Note: "a".repeat(4001), QuoteID: 7 }),
      ctx,
    );

    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("400 on an unknown Decision", async () => {
    const res = await recordEmailQuoteDecision(makeRequest({ Decision: "maybe", EmailID: 42, QuoteID: 7 }), ctx);

    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("ingestEmail", () => {
  it("stamps Source = 'ingest' and ignores provenance fields in the body", async () => {
    routeSql([[/SELECT .* FROM Emails WHERE MessageID/s, [{ EmailID: 1 }]]]);

    const res = await ingestEmail(
      makeRequest({
        AuthenticationResults: "dmarc=pass",
        FromAddress: "carlo@randazzo.properties",
        MessageID: "<forged@x>",
        SenderAuthenticated: true,
        Source: "graph",
        Subject: "Approved",
      }),
      ctx,
    );

    expect(res.status).toBe(200);
    const insert = sqlCalls().find((c) => /INSERT INTO Emails/.test(c.sql));
    expect(insert?.sql).toMatch(/INSERT INTO Emails\s*\([^)]*Source\)/);
    expect(insert?.sql).toMatch(/VALUES\s*\([^)]*'ingest'\)/);
    expect(insert?.sql).not.toMatch(/SenderAuthenticated|AuthenticationResults/);
    expect(Object.keys(insert?.params ?? {})).not.toContain("Source");
    expect(Object.keys(insert?.params ?? {})).not.toContain("SenderAuthenticated");
  });
});
