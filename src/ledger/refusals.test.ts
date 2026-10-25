/// <reference types="jest" />
import type { HttpRequest } from "@azure/functions";
import type { Connection } from "tedious";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";
import { _resetRateLimitForTests } from "../rateLimit";
import { recordApart, recordRefusal, recordRefusalForRequest, recordRoleRefusal, underRowLimit } from "./refusals";
import type { LedgerActor } from "./types";

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
  return { ...actual, rolesForRequest: jest.fn(), verifiedIdentityFromRequest: jest.fn() };
});
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

const db = require("../db") as {
  beginTransaction: jest.Mock;
  closeConnection: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const auth = require("../auth") as { rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const sentry = require("../sentry") as { Sentry: { captureException: jest.Mock } };

const connection = { id: "the request connection" } as unknown as Connection;
const fay: LedgerActor = { kind: "user", name: "Fay Staff", role: "facilities", userId: 11 };

type Route = { match: string; reject?: Error; rows?: Record<string, unknown>[] };
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    for (const r of routes) {
      if (sql.includes(r.match)) {
        if (r.reject) throw r.reject;
        return r.rows ?? [];
      }
    }
    return [];
  });
}

const JOB = { match: "SELECT BuildingID FROM Jobs WHERE JobID", rows: [{ BuildingID: 5 }] };

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  db.createRequestConnection.mockResolvedValue(connection);
  mockSql([JOB]);
});

afterEach(() => jest.restoreAllMocks());

describe("recordRefusal", () => {
  // `jobId` is what the handler already knows; "lookup" leaves the job to be found from the record.
  const refuse = (over: Partial<Parameters<typeof recordRefusal>[3]> = {}, known: number | null | "lookup" = 9) =>
    recordRefusal(
      connection,
      fay,
      { id: 7, type: "quote" },
      {
        attempted: "quote.director_approve",
        code: "director_role_required",
        message: "Director role required",
        state: { status: "awaiting_director" },
        ...over,
      },
      known === "lookup" ? undefined : known,
    );

  it("writes one `denied` row: the code as its rule, the sentence as its reason, what was attempted and how the record stood", async () => {
    await refuse();

    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: "denied",
      actorKind: "user",
      actorName: "Fay Staff",
      actorRole: "facilities",
      actorUserId: 11,
      after: null,
      before: { attempted: "quote.director_approve", status: "awaiting_director" },
      buildingId: 5,
      isException: true,
      jobId: 9,
      reason: "Director role required",
      ruleApplied: "director_role_required",
      subjectId: "7",
      subjectType: "quote",
    });
  });

  it("uses a transaction of its own: begin, one INSERT, commit", async () => {
    await refuse();

    const [row] = ledgerInserts(db.executeQuery);
    expect(db.beginTransaction.mock.invocationCallOrder[0]).toBeLessThan(row.order);
    expect(row.order).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("records a self-approval block as `sod_blocked`", async () => {
    await refuse({ action: "sod_blocked", code: "creator" });

    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "sod_blocked", isException: true, ruleApplied: "creator" });
  });

  it("finds the job and building from the record when the handler hasn't loaded them", async () => {
    mockSql([{ match: "FROM Quotes s INNER JOIN Jobs j", rows: [{ BuildingID: 5, JobID: 9 }] }]);

    await refuse({}, "lookup");

    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ buildingId: 5, jobId: 9 });
    const lookup = db.executeQuery.mock.calls[0];
    expect(lookup[1]).toContain("WHERE s.QuoteID = @Id");
    expect(lookup[2]).toEqual([expect.objectContaining({ name: "Id", value: 7 })]);
  });

  it.each([
    ["invoice", "FROM JobInvoices s INNER JOIN Jobs j", "s.JobInvoiceID"],
    ["payment", "FROM Payments s INNER JOIN Jobs j", "s.PaymentID"],
    ["purchase_order", "FROM PurchaseOrders s INNER JOIN Jobs j", "s.PurchaseOrderID"],
    ["job", "FROM Jobs WHERE JobID", "JobID = @Id"],
  ] as const)("looks a %s up in its own table", async (type, from, where) => {
    mockSql([{ match: from, rows: [{ BuildingID: 5, JobID: 9 }] }]);

    await recordRefusal(connection, fay, { id: 3, type }, { attempted: "quote.approve", code: "x" });

    expect(db.executeQuery.mock.calls[0][1]).toContain(where);
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ jobId: 9, subjectType: type });
  });

  it("writes nothing for an account with no role, and doesn't report that as a failure", async () => {
    await recordRefusal(
      connection,
      { kind: "user", name: "New Starter", role: "", userId: 40 },
      { id: 7, type: "quote" },
      { attempted: "quote.approve", code: "role_not_permitted" },
      9,
    );

    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(sentry.Sentry.captureException).not.toHaveBeenCalled();
  });

  it("writes nothing for a record that doesn't exist", async () => {
    mockSql([{ match: "FROM Quotes s INNER JOIN Jobs j", rows: [] }]);

    await refuse({}, "lookup");

    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("scopes a row to no job when the handler says there is none", async () => {
    await refuse({}, null);

    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ buildingId: null, jobId: null });
  });

  describe("never changes the answer the caller was going to get", () => {
    it("swallows a failed ledger write, rolls its own transaction back and tells Sentry", async () => {
      mockSql([JOB, { match: "INSERT INTO dbo.DecisionLedger", reject: new Error("ledger unavailable") }]);

      await expect(refuse()).resolves.toBeUndefined();

      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(sentry.Sentry.captureException).toHaveBeenCalledWith(
        expect.objectContaining({ message: "ledger unavailable" }),
        expect.objectContaining({ tags: { area: "ledger-refusal" } }),
      );
    });

    it("swallows an entry the ledger refuses (a role name it can't hold, say)", async () => {
      await expect(refuse({ code: "x".repeat(65) })).resolves.toBeUndefined();

      expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    });

    it("swallows a failure to even start", async () => {
      db.beginTransaction.mockRejectedValue(new Error("connection reset"));

      await expect(refuse()).resolves.toBeUndefined();
    });

    it("swallows a failing rollback too", async () => {
      mockSql([JOB, { match: "INSERT INTO dbo.DecisionLedger", reject: new Error("ledger unavailable") }]);
      db.rollbackTransaction.mockRejectedValue(new Error("rollback failed"));

      await expect(refuse()).resolves.toBeUndefined();
    });
  });

  it("stops writing after 20 refusals a minute from one person, so a refused endpoint can't fill a table nothing can empty", async () => {
    for (let i = 0; i < 25; i++) await refuse();

    expect(ledgerInserts(db.executeQuery)).toHaveLength(20);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("rate limited"));

    const colleague: LedgerActor = { kind: "user", name: "Mo Manager", role: "facilities_manager", userId: 12 };
    await recordRefusal(connection, colleague, { id: 7, type: "quote" }, { attempted: "quote.approve", code: "x" }, 9);
    expect(ledgerInserts(db.executeQuery)).toHaveLength(21);
  });
});

describe("recordRefusalForRequest", () => {
  const target = { attempted: "quote.director_approve", idField: "QuoteID", subjectType: "quote" } as const;
  const request = (body: unknown): HttpRequest => ({ json: jest.fn().mockResolvedValue(body) }) as unknown as HttpRequest;

  beforeEach(() => {
    auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "fay@example.com", name: "Fay Staff", oid: "oid-fay" });
    auth.rolesForRequest.mockResolvedValue(["facilities"]);
    mockSql([
      { match: "FROM dbo.AppUsers WHERE EntraOid", rows: [{ UserID: 11 }] },
      { match: "FROM Quotes s INNER JOIN Jobs j", rows: [{ BuildingID: 5, JobID: 9 }] },
    ]);
  });

  it("finds the record in the body, the person from the token, and records the refusal on its own connection", async () => {
    await recordRefusalForRequest(request({ QuoteID: 7 }), "the-token", target, { code: "director_role_required", message: "Director role required" });

    expect(db.createRequestConnection).toHaveBeenCalledWith("the-token");
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "denied",
        actorName: "Fay Staff",
        actorRole: "facilities",
        actorUserId: 11,
        before: { attempted: "quote.director_approve" },
        buildingId: 5,
        jobId: 9,
        ruleApplied: "director_role_required",
        subjectId: "7",
      }),
    ]);
    expect(db.closeConnection).toHaveBeenCalledWith(connection);
  });

  it.each([
    ["no body", null],
    ["a body without the id", {}],
    ["a string id", { QuoteID: "7" }],
    ["a fractional id", { QuoteID: 7.5 }],
    ["a zero id", { QuoteID: 0 }],
    ["a negative id", { QuoteID: -3 }],
    ["a body that isn't an object", 12],
  ])("does nothing for %s", async (_label, body) => {
    await recordRefusalForRequest(request(body), "the-token", target, { code: "x" });

    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });

  it("takes what was attempted from the body when the endpoint can do more than one thing", async () => {
    const either = {
      attempted: (body: Record<string, unknown>) => (body.Decision === "rejected" ? "quote.director_reject" : "quote.director_approve"),
      idField: "QuoteID",
      subjectType: "quote",
    } as const;

    await recordRefusalForRequest(request({ Decision: "rejected", QuoteID: 7 }), "the-token", either, { code: "x" });
    await recordRefusalForRequest(request({ Decision: "approved", QuoteID: 7 }), "the-token", either, { code: "x" });

    expect(ledgerInserts(db.executeQuery).map((r) => (r.before as { attempted: string }).attempted)).toEqual([
      "quote.director_reject",
      "quote.director_approve",
    ]);
  });

  it("does nothing when the endpoint says this request isn't a ledgered decision", async () => {
    const editsAreNot = {
      attempted: (body: Record<string, unknown>) => (body.PaymentID === undefined ? "payment.create" : null),
      idField: "JobInvoiceID",
      subjectType: "invoice",
    } as const;

    await recordRefusalForRequest(request({ JobInvoiceID: 5, PaymentID: 11 }), "the-token", editsAreNot, { code: "x" });

    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);

    mockSql([
      { match: "FROM dbo.AppUsers WHERE EntraOid", rows: [{ UserID: 11 }] },
      { match: "FROM JobInvoices s INNER JOIN Jobs j", rows: [{ BuildingID: 5, JobID: 9 }] },
    ]);
    await recordRefusalForRequest(request({ JobInvoiceID: 5 }), "the-token", editsAreNot, { code: "x" });
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({ before: { attempted: "payment.create" }, jobId: 9, subjectId: "5", subjectType: "invoice" }),
    ]);
  });

  describe("an endpoint whose decisions are about different records lists a target for each", () => {
    // Recording a payment is about the invoice it pays; changing its amount is about the payment.
    const create = {
      attempted: (body: Record<string, unknown>) => (body.PaymentID === undefined ? "payment.create" : null),
      idField: "JobInvoiceID",
      subjectType: "invoice",
    } as const;
    const amountChange = {
      attempted: (body: Record<string, unknown>) =>
        body.PaymentID !== undefined && typeof body.Amount === "number" ? "payment.amount_change" : null,
      idField: "PaymentID",
      subjectType: "payment",
    } as const;
    const refuse = (body: unknown) => recordRefusalForRequest(request(body), "the-token", [create, amountChange], { code: "x" });

    beforeEach(() => {
      mockSql([
        { match: "FROM dbo.AppUsers WHERE EntraOid", rows: [{ UserID: 11 }] },
        { match: "FROM JobInvoices s INNER JOIN Jobs j", rows: [{ BuildingID: 5, JobID: 9 }] },
        { match: "FROM Payments s INNER JOIN Jobs j", rows: [{ BuildingID: 6, JobID: 10 }] },
      ]);
    });

    it("records a new payment against its invoice", async () => {
      await refuse({ Amount: 100, JobID: 9, JobInvoiceID: 5 });

      expect(ledgerInserts(db.executeQuery)).toEqual([
        expect.objectContaining({ before: { attempted: "payment.create" }, buildingId: 5, jobId: 9, subjectId: "5", subjectType: "invoice" }),
      ]);
    });

    it("records an amount change against the payment, even though the body also names an invoice", async () => {
      await refuse({ Amount: 150, JobInvoiceID: 5, PaymentID: 11 });

      expect(ledgerInserts(db.executeQuery)).toEqual([
        expect.objectContaining({ before: { attempted: "payment.amount_change" }, buildingId: 6, jobId: 10, subjectId: "11", subjectType: "payment" }),
      ]);
    });

    it("records nothing for an edit that changes no amount: no target takes it", async () => {
      await refuse({ JobInvoiceID: 5, Notes: "typo", PaymentID: 11 });

      expect(db.createRequestConnection).not.toHaveBeenCalled();
      expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    });

    it("skips a target whose id the body doesn't carry and tries the next", async () => {
      await refuse({ Amount: 150, PaymentID: 11 });

      expect(ledgerInserts(db.executeQuery)).toEqual([expect.objectContaining({ subjectId: "11", subjectType: "payment" })]);
    });

    it("is what recordRoleRefusal passes on", async () => {
      await recordRoleRefusal(request({ Amount: 150, PaymentID: 11 }), "the-token", { status: 403 }, [create, amountChange]);

      expect(ledgerInserts(db.executeQuery)).toEqual([
        expect.objectContaining({ before: { attempted: "payment.amount_change" }, ruleApplied: "role_not_permitted", subjectType: "payment" }),
      ]);
    });
  });

  it("does nothing when the body can't be read", async () => {
    const unreadable = { json: jest.fn().mockRejectedValue(new Error("Unexpected end of JSON")) } as unknown as HttpRequest;

    await expect(recordRefusalForRequest(unreadable, "the-token", target, { code: "x" })).resolves.toBeUndefined();

    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("does nothing when the token's identity can't be verified, but still closes its connection", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValue(null);

    await recordRefusalForRequest(request({ QuoteID: 7 }), "the-token", target, { code: "x" });

    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(db.closeConnection).toHaveBeenCalledWith(connection);
  });

  it("does nothing for a record that doesn't exist", async () => {
    mockSql([
      { match: "FROM dbo.AppUsers WHERE EntraOid", rows: [{ UserID: 11 }] },
      { match: "FROM Quotes s INNER JOIN Jobs j", rows: [] },
    ]);

    await recordRefusalForRequest(request({ QuoteID: 123456 }), "the-token", target, { code: "x" });

    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });

  it("never throws, whatever fails: no connection, no role lookup", async () => {
    db.createRequestConnection.mockRejectedValueOnce(new Error("no connection"));
    await expect(recordRefusalForRequest(request({ QuoteID: 7 }), "t", target, { code: "x" })).resolves.toBeUndefined();

    auth.rolesForRequest.mockRejectedValueOnce(new Error("Role lookup failed"));
    await expect(recordRefusalForRequest(request({ QuoteID: 7 }), "t", target, { code: "x" })).resolves.toBeUndefined();
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});

describe("recordRoleRefusal", () => {
  const target = { attempted: "quote.approve", idField: "QuoteID", subjectType: "quote" } as const;
  const request = { json: jest.fn().mockResolvedValue({ QuoteID: 7 }) } as unknown as HttpRequest;

  beforeEach(() => {
    auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "fay@example.com", name: "Fay Staff", oid: "oid-fay" });
    auth.rolesForRequest.mockResolvedValue(["facilities"]);
    mockSql([
      { match: "FROM dbo.AppUsers WHERE EntraOid", rows: [{ UserID: 11 }] },
      { match: "FROM Quotes s INNER JOIN Jobs j", rows: [{ BuildingID: 5, JobID: 9 }] },
    ]);
  });

  it("records a 403 as `role_not_permitted`, with the gate's own explanation as the reason", async () => {
    await recordRoleRefusal(
      request,
      "the-token",
      { status: 403, jsonBody: { details: "Required role: accounts_manager. Have: facilities", error: "Forbidden" } },
      target,
    );

    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "denied",
        before: { attempted: "quote.approve" },
        reason: "Required role: accounts_manager. Have: facilities",
        ruleApplied: "role_not_permitted",
      }),
    ]);
  });

  it("falls back to a plain sentence when the 403 carries no explanation", async () => {
    await recordRoleRefusal(request, "the-token", { status: 403 }, target);

    expect(ledgerInserts(db.executeQuery)[0].reason).toBe("Your role can't make this decision");
  });

  it("records nothing for a 503: the roles couldn't be checked, which is not a refusal", async () => {
    await recordRoleRefusal(request, "the-token", { status: 503, jsonBody: { error: "Service temporarily unavailable" } }, target);

    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });
});

describe("recordApart", () => {
  const entry = {
    action: "quote.director_request_failed",
    actor: fay,
    after: { amount: 5000, currency: "AUD", resend: false },
    buildingId: 5,
    jobId: 9,
    reason: "The director approval email could not be sent",
    ruleApplied: "send_failed",
    subject: { id: 7, type: "quote" },
  } as const;

  it("writes the one row in a transaction of its own: begin, INSERT, commit", async () => {
    await recordApart(connection, entry, "failed quote director request");

    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toEqual([
      expect.objectContaining({
        action: "quote.director_request_failed",
        actorName: "Fay Staff",
        after: { amount: 5000, currency: "AUD", resend: false },
        isException: true,
        ruleApplied: "send_failed",
        subjectId: "7",
      }),
    ]);
    expect(db.beginTransaction.mock.invocationCallOrder[0]).toBeLessThan(rows[0].order);
    expect(rows[0].order).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("never throws: a failed write is rolled back and reported under the area it was given", async () => {
    mockSql([{ match: "INSERT INTO dbo.DecisionLedger", reject: new Error("ledger unavailable") }]);

    await expect(recordApart(connection, entry, "failed quote director request", "ledger-send-failure")).resolves.toBeUndefined();

    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(sentry.Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "ledger unavailable" }),
      expect.objectContaining({ tags: { area: "ledger-send-failure" } }),
    );
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("failed quote director request on quote 7"), "ledger unavailable");
  });

  it("is reported as a refusal unless told otherwise", async () => {
    mockSql([{ match: "INSERT INTO dbo.DecisionLedger", reject: new Error("ledger unavailable") }]);

    await recordApart(connection, entry, "refused quote.approve");

    expect(sentry.Sentry.captureException).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ tags: { area: "ledger-refusal" } }));
  });

  it("swallows an entry the ledger refuses, without sending any SQL for it", async () => {
    await expect(recordApart(connection, { ...entry, ruleApplied: "x".repeat(65) }, "failed quote director request")).resolves.toBeUndefined();

    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
  });
});

describe("underRowLimit", () => {
  const mo: LedgerActor = { kind: "user", name: "Mo Manager", role: "facilities_manager", userId: 12 };

  it("allows 20 rows a minute from one person, then says no and says why", () => {
    const results = Array.from({ length: 22 }, () => underRowLimit(fay, "failed quote director request"));

    expect(results.filter(Boolean)).toHaveLength(20);
    expect(results.slice(20)).toEqual([false, false]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("not recording this failed quote director request"));
  });

  it("counts each person separately", () => {
    for (let i = 0; i < 25; i++) underRowLimit(fay, "x");

    expect(underRowLimit(mo, "x")).toBe(true);
  });

  it("shares one budget between refused attempts and failed sends, since both land in a table nothing can empty", async () => {
    for (let i = 0; i < 20; i++) {
      await recordRefusal(connection, fay, { id: 7, type: "quote" }, { attempted: "quote.approve", code: "x" }, 9);
    }

    expect(underRowLimit(fay, "failed quote director request")).toBe(false);
  });

  it("keys a system actor by its name", () => {
    const system: LedgerActor = { kind: "system", name: "planner-sync" };

    for (let i = 0; i < 20; i++) underRowLimit(system, "x");

    expect(underRowLimit(system, "x")).toBe(false);
    expect(underRowLimit(fay, "x")).toBe(true);
  });
});
