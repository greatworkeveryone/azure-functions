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
  executeQuery: jest.fn().mockResolvedValue([]),
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
      email: "carlo@randazzo.properties",
      name: "Carlo Randazzo",
      oid: "director-oid",
    }),
  };
});

jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn() }));
jest.mock("../jobStatusHelpers", () => ({ advanceJobStatus: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../jobPlannerSync", () => ({
  syncJobActionTriggersStandalone: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../email/director-emails", () => ({
  sendDirectorApprovalEmail: jest.fn().mockResolvedValue({
    sentAt: new Date("2026-10-13T00:00:00Z"),
    sentTo: ["carlo@randazzo.properties"],
  }),
}));
jest.mock("../quote-decisions", () => ({
  QUOTE_COLUMNS: "QuoteID",
  approveDirectorQuote: jest.fn(),
  rejectQuote: jest.fn(),
}));

const auth = require("../auth") as { rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const limitsDb = require("../approval-limits-db") as { getCachedApprovalLimits: jest.Mock };
const statusHelpers = require("../jobStatusHelpers") as { advanceJobStatus: jest.Mock };
const directorEmails = require("../email/director-emails") as { sendDirectorApprovalEmail: jest.Mock };
const planner = require("../planner") as { resolveActivePlannerTasks: jest.Mock };
const decisions = require("../quote-decisions") as { approveDirectorQuote: jest.Mock; rejectQuote: jest.Mock };

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: unknown }>;
const { directorApproveQuote, rejectQuote } = require("./quotes") as {
  directorApproveQuote: Handler;
  rejectQuote: Handler;
};

// approveQuote / resendDirectorQuoteEmail are registered, not exported. Capture
// them now: beforeEach's clearAllMocks wipes app.http's recorded calls.
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const registered = (name: string): Handler => {
  const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === name);
  if (!hit) throw new Error(`handler ${name} not registered`);
  return (hit[1] as { handler: Handler }).handler;
};
const approveQuote = registered("approveQuote");
const resendDirectorQuoteEmail = registered("resendDirectorQuoteEmail");
const bodyActorHandlers: [string, string][] = [
  ["upsertQuote", "CreatedBy"],
  ["unapproveQuote", "UnapprovedBy"],
  ["completeQuote", "CompletedBy"],
  ["uncompleteQuote", "UncompletedBy"],
  ["validateQuote", "ValidatedBy"],
];
const bodyActorHandler = Object.fromEntries(bodyActorHandlers.map(([name]) => [name, registered(name)]));

function makeRequest(body: unknown): HttpRequest {
  return {
    headers: { get: () => null },
    json: jest.fn().mockResolvedValue(body),
    query: new URLSearchParams(),
  } as unknown as HttpRequest;
}

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const storedQuote = { QuoteID: 7, Status: "rejected" };

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset().mockResolvedValue([]);
  decisions.rejectQuote.mockResolvedValue({ jobId: 9, ok: true, previousStatus: "pending", quote: storedQuote });
  decisions.approveDirectorQuote.mockResolvedValue({ jobId: 9, ok: true, quote: { ...storedQuote, Status: "approved" } });
});

describe("rejectQuote (in-app)", () => {
  it("takes the actor from the verified token and ignores RejectedBy in the body", async () => {
    const res = await rejectQuote(makeRequest({ QuoteID: 7, RejectedBy: "Mallory" }), ctx);

    expect(res.status).toBe(200);
    expect(decisions.rejectQuote).toHaveBeenCalledWith({}, {
      expectedStatuses: ["pending", "awaiting_director"],
      quoteId: 7,
      rejectedBy: "Carlo Randazzo",
    });
  });

  it("surfaces the helper's 409 when the quote is not rejectable", async () => {
    decisions.rejectQuote.mockResolvedValue({
      error: "Quote is approved — it can only be rejected while pending or awaiting_director",
      ok: false,
      status: 409,
    });

    const res = await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(409);
  });

  it("commits the transaction on success", async () => {
    await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(db.beginTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).toHaveBeenCalled();
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("rolls back and does not commit when the helper is not ok", async () => {
    decisions.rejectQuote.mockResolvedValue({ error: "x", ok: false, status: 409 });

    const res = await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("rolls back and 500s when the helper throws, even if rollback fails", async () => {
    decisions.rejectQuote.mockRejectedValue(new Error("boom"));
    db.rollbackTransaction.mockRejectedValueOnce(new Error("rollback failed"));

    const res = await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("resolves the director Planner task after rejecting from awaiting_director", async () => {
    decisions.rejectQuote.mockResolvedValue({ jobId: 9, ok: true, previousStatus: "awaiting_director", quote: storedQuote });

    const res = await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(200);
    expect(planner.resolveActivePlannerTasks).toHaveBeenCalledWith("job", 9, ["director_approval"]);
  });

  it("does not resolve the Planner task when rejecting from pending", async () => {
    await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(planner.resolveActivePlannerTasks).not.toHaveBeenCalled();
  });

  it("still 200s when the Planner resolve throws", async () => {
    decisions.rejectQuote.mockResolvedValue({ jobId: 9, ok: true, previousStatus: "awaiting_director", quote: storedQuote });
    planner.resolveActivePlannerTasks.mockRejectedValueOnce(new Error("graph down"));

    const res = await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(200);
  });

  it("401s and writes nothing when the token identity cannot be verified", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await rejectQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(401);
    expect(decisions.rejectQuote).not.toHaveBeenCalled();
  });
});

describe("directorApproveQuote", () => {
  it("403s an admin without the literal director role — director-only by policy", async () => {
    auth.rolesForRequest.mockResolvedValueOnce(["admin"]);

    const res = await directorApproveQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(403);
    expect(decisions.approveDirectorQuote).not.toHaveBeenCalled();
  });

  it("stamps the verified director, not ApprovedBy from the body", async () => {
    const res = await directorApproveQuote(makeRequest({ ApprovedBy: "Mallory", QuoteID: 7 }), ctx);

    expect(res.status).toBe(200);
    expect(decisions.approveDirectorQuote).toHaveBeenCalledWith({}, { approvedBy: "Carlo Randazzo", quoteId: 7 });
  });

  it("commits the transaction on success", async () => {
    await directorApproveQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(db.beginTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).toHaveBeenCalled();
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("rolls back and does not commit when the helper is not ok", async () => {
    decisions.approveDirectorQuote.mockResolvedValue({ error: "x", ok: false, status: 409 });

    const res = await directorApproveQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(409);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("rolls back and 500s when the helper throws", async () => {
    decisions.approveDirectorQuote.mockRejectedValue(new Error("boom"));

    const res = await directorApproveQuote(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });
});

type SqlRoute = [RegExp, Record<string, unknown>[]];

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

const flush = async () => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
};

describe("approveQuote", () => {
  const quoteRow = (amount: number): SqlRoute => [
    /SELECT JobID, QuoteNumber, ContractorName, Amount/,
    [{ Amount: amount, ContractorName: "Acme", Currency: "AUD", JobID: 9, QuoteNumber: "QT-9-1", Status: "pending" }],
  ];
  const stored: SqlRoute = [/SELECT QuoteID FROM Quotes/, [{ QuoteID: 7, Status: "approved" }]];

  beforeEach(() => {
    auth.rolesForRequest.mockResolvedValue(["accounts_manager"]);
    limitsDb.getCachedApprovalLimits.mockResolvedValue([
      { MaxApprovalAmount: 1000, RoleName: "accounts_manager" },
      { MaxApprovalAmount: null, RoleName: "director" },
    ]);
  });

  it("records the token's name on the quote, job, event and status transition, ignoring ApprovedBy", async () => {
    routeSql([quoteRow(500), stored]);

    const res = await approveQuote(makeRequest({ ApprovedBy: "Someone Else", QuoteID: 7 }), ctx);

    expect(res.status).toBe(200);
    const calls = sqlCalls();
    expect(calls.find((c) => /UPDATE Quotes\s+SET Status = @Status/.test(c.sql))?.params.ApprovedBy).toBe("Carlo Randazzo");
    expect(calls.find((c) => /UPDATE Jobs\s+SET ApprovedQuoteID/.test(c.sql))?.params.ApprovedBy).toBe("Carlo Randazzo");
    expect(calls.find((c) => /INSERT INTO JobEvents/.test(c.sql))?.params.CreatedBy).toBe("Carlo Randazzo");
    expect(statusHelpers.advanceJobStatus).toHaveBeenCalledWith(
      expect.anything(),
      9,
      expect.anything(),
      expect.objectContaining({ actor: "Carlo Randazzo" }),
    );
    expect(calls.flatMap((c) => Object.values(c.params))).not.toContain("Someone Else");
  });

  it("stamps the director email trigger and SentBy with the token's name", async () => {
    routeSql([quoteRow(5000), stored]);

    await approveQuote(makeRequest({ ApprovedBy: "Someone Else", QuoteID: 7 }), ctx);
    await flush();

    expect(directorEmails.sendDirectorApprovalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ triggeredBy: "Carlo Randazzo" }),
    );
    expect(sqlCalls().find((c) => /DirectorEmailSentBy = @SentBy/.test(c.sql))?.params.SentBy).toBe("Carlo Randazzo");
  }, 30_000);

  it("401s without touching the database when the token has no verified identity", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await approveQuote(makeRequest({ ApprovedBy: "Someone Else", QuoteID: 7 }), ctx);

    expect(res.status).toBe(401);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("resendDirectorQuoteEmail", () => {
  it("uses the token's name for triggeredBy and DirectorEmailSentBy, ignoring TriggeredBy", async () => {
    routeSql([
      [/SELECT JobID, Amount, ISNULL\(Currency/, [{ Amount: 5000, Currency: "AUD", JobID: 9, Status: "awaiting_director" }]],
      [/SELECT QuoteID FROM Quotes/, [{ QuoteID: 7 }]],
    ]);

    const res = await resendDirectorQuoteEmail(makeRequest({ QuoteID: 7, TriggeredBy: "Someone Else" }), ctx);

    expect(res.status).toBe(200);
    expect(directorEmails.sendDirectorApprovalEmail).toHaveBeenCalledWith(
      expect.objectContaining({ triggeredBy: "Carlo Randazzo" }),
    );
    expect(sqlCalls().find((c) => /DirectorEmailSentBy = @SentBy/.test(c.sql))?.params.SentBy).toBe("Carlo Randazzo");
  });

  it("401s when the token has no verified identity", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await resendDirectorQuoteEmail(makeRequest({ QuoteID: 7 }), ctx);

    expect(res.status).toBe(401);
  });
});

describe("quote handlers that used to read the actor from the body", () => {
  const anyQuote = {
    Amount: 100, ApprovedAt: null, ContractorName: "Acme", JobID: 9, QuoteID: 7,
    QuoteNumber: "QT-9-1", Status: "approved",
  };

  it.each(bodyActorHandlers)("%s records the token's name and ignores body %s", async (name, field) => {
    const row = { ...anyQuote, NextSeq: 1, Status: name === "uncompleteQuote" ? "completed" : "approved" };
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      /OUTPUT INSERTED|^\s*SELECT/i.test(sql) ? [row] : [],
    );

    // upsertQuote without a QuoteID takes the create path, which stamps CreatedBy
    // (and, since J3, needs an amount above $0).
    const ids = name === "upsertQuote" ? { Amount: 100, JobID: 9 } : { JobID: 9, QuoteID: 7 };
    await bodyActorHandler[name](makeRequest({ ...ids, [field]: "Someone Else" }), ctx);

    const values = sqlCalls().flatMap((c) => Object.values(c.params));
    expect(values).not.toContain("Someone Else");
    expect(values).toContain("Carlo Randazzo");
  });

  it.each(bodyActorHandlers)("%s 401s without a verified identity", async (name) => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await bodyActorHandler[name](makeRequest({ JobID: 9, QuoteID: 7 }), ctx);

    expect(res.status).toBe(401);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("upsertQuote: editing an approved quote's amount (J2, N2)", () => {
  const upsertQuote = registered("upsertQuote");
  const dbWithUpdate = require("../db") as { buildUpdateSet: jest.Mock };

  it("clears the approval and records why, but never moves the job", async () => {
    dbWithUpdate.buildUpdateSet.mockReturnValue({ params: [{ name: "Amount", type: undefined, value: 9000 }], setClause: "Amount = @Amount" });
    routeSql([
      [/FROM Quotes WITH \(UPDLOCK, HOLDLOCK\) WHERE QuoteID = @Id/, [
        { Amount: 4000, ApprovedAt: new Date("2026-10-10T00:00:00Z"), ContractorName: "Acme", JobID: 9, QuoteID: 7, QuoteNumber: "QT-9-1", Status: "approved" },
      ]],
      [/SELECT QuoteID FROM Quotes/, [{ QuoteID: 7 }]],
    ]);

    const res = await upsertQuote(makeRequest({ Amount: 9000, QuoteID: 7 }), ctx);

    expect(res.status).toBe(200);
    expect(sqlCalls().some((c) => /SET Status = 'pending'/.test(c.sql))).toBe(true);
    const jobWrites = sqlCalls().filter((c) => /UPDATE Jobs/.test(c.sql));
    expect(jobWrites.length).toBeGreaterThan(0);
    for (const write of jobWrites) expect(write.sql).not.toMatch(/\bStatus\b|\bAwaitingRole\b/);
    const cleared = sqlCalls().find((c) => /INSERT INTO JobEvents/.test(c.sql) && c.params.EventType === "quote_approval_cleared");
    expect(cleared?.params.Text).toBe("Quote QT-9-1 amount changed — approval cleared. The job keeps its status until a quote is approved again.");
    expect(sqlCalls().some((c) => /'status_change'/.test(c.sql))).toBe(false);
  });
});
