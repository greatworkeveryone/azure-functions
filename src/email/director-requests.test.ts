/// <reference types="jest" />
// Sending the director's approval request and recording that it went (WP19b,
// PLAN §3.12). The DB layer and the mail are mocked and the real ledger runs, so
// what is asserted is the INSERT record() really sends.
import type { Connection } from "tedious";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";
import { moneyShape } from "../__tests__/fixtures/moneyRowShape";
import type { LedgerActor } from "../ledger/types";
import { _resetRateLimitForTests } from "../rateLimit";
import { sendDirectorRequest, type DirectorRequest } from "./director-requests";

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("./director-emails", () => ({ sendDirectorApprovalEmail: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const mail = require("./director-emails") as { sendDirectorApprovalEmail: jest.Mock };
const sentry = require("../sentry") as { Sentry: { captureException: jest.Mock } };

const connection = { id: "the background connection" } as unknown as Connection;
const casey: LedgerActor = { kind: "user", name: "Casey Controller", role: "accounts_manager", userId: 21 };
const SENT_AT = new Date("2026-10-13T00:00:00Z");
const PACKET = { attachments: 2, sections: ["job summary", "quote QT-9-1"], separateFiles: 1 };
const CORRELATION = "0c2b7a54-2f6e-4bd5-9a43-0f4f5b0c3a11";

type Route = { match: RegExp; reject?: Error; rows?: Record<string, unknown>[] };
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    const hit = routes.find((r) => r.match.test(sql));
    if (hit?.reject) throw hit.reject;
    return hit?.rows ?? [];
  });
}
const JOB: Route = { match: /SELECT BuildingID FROM Jobs WHERE JobID/, rows: [{ BuildingID: 5 }] };
const NAMES: Route = { match: /SELECT DisplayName FROM dbo\.AppUsers/, rows: [{ DisplayName: "Dana Director" }, { DisplayName: "Bo Boss" }] };
const LEDGER_FAILS: Route = { match: /INSERT INTO dbo\.DecisionLedger/, reject: new Error("ledger unavailable") };
const orderOf = (re: RegExp): number => {
  const i = db.executeQuery.mock.calls.findIndex((c: unknown[]) => re.test(String(c[1])));
  return i < 0 ? -1 : db.executeQuery.mock.invocationCallOrder[i];
};
const callsTo = (re: RegExp): unknown[][] => db.executeQuery.mock.calls.filter((c: unknown[]) => re.test(String(c[1])));
const paramsOf = (call: unknown[]): Record<string, unknown> =>
  Object.fromEntries((call[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value]));

// What a quote or invoice is, as its handler hands it over.
const FACTS = { amount: 5000, contractorId: 3, contractorName: "Acme", currency: "AUD", quoteNumber: "QT-9-1" };

const request = (over: Partial<DirectorRequest> = {}): DirectorRequest => ({
  actor: casey,
  amount: 5000,
  connection,
  correlationId: CORRELATION,
  currency: "AUD",
  facts: FACTS,
  jobId: 9,
  resend: false,
  stage: "quote",
  subjectId: 7,
  triggeredBy: "Casey Controller",
  ...over,
});
const STAMP_QUOTE = /UPDATE Quotes\s+SET DirectorEmailSentAt/;
const STAMP_INVOICE = /UPDATE JobInvoices\s+SET DirectorEmailSentAt/;

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  jest.spyOn(console, "error").mockImplementation(() => undefined);
  jest.spyOn(console, "warn").mockImplementation(() => undefined);
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  mail.sendDirectorApprovalEmail.mockResolvedValue({ packet: PACKET, sentAt: SENT_AT, sentTo: ["dana@example.com", "boss@example.com"] });
  mockSql([JOB, NAMES]);
});

// Every money row any test here writes has the shape trend reports read (see the fixture).
afterEach(() => moneyShape.check(ledgerInserts(db.executeQuery)));
afterEach(() => jest.restoreAllMocks());

describe("sendDirectorRequest: when the mail goes", () => {
  it("asks for the mail with what the callers always asked for, plus the record so the link names it (J6)", async () => {
    await sendDirectorRequest(request({ stage: "invoice", subjectId: 5 }));

    expect(mail.sendDirectorApprovalEmail).toHaveBeenCalledWith({
      amount: 5000,
      connection,
      currency: "AUD",
      jobId: 9,
      stage: "invoice",
      subjectId: 5,
      triggeredBy: "Casey Controller",
    });
  });

  it("hands back what the mail returned", async () => {
    const result = await sendDirectorRequest(request());

    expect(result).toEqual({ packet: PACKET, sentAt: SENT_AT, sentTo: ["dana@example.com", "boss@example.com"] });
  });

  it("writes one `*.director_request_sent` row: the recipients by name, the packet, and whether it was a resend", async () => {
    await sendDirectorRequest(request({ resend: true }));

    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "quote.director_request_sent",
        actorKind: "user",
        actorName: "Casey Controller",
        actorRole: "accounts_manager",
        actorUserId: 21,
        after: {
          amount: 5000,
          contractorId: 3,
          contractorName: "Acme",
          currency: "AUD",
          packet: PACKET,
          quoteNumber: "QT-9-1",
          recipients: ["Bo Boss", "Dana Director"],
          resend: true,
          unnamedRecipients: 0,
        },
        before: null,
        buildingId: 5,
        correlationId: CORRELATION,
        isException: false,
        jobId: 9,
        subjectId: "7",
        subjectType: "quote",
      }),
    ]);
  });

  it("does the same for an invoice, under its own codes and its own table", async () => {
    await sendDirectorRequest(request({ stage: "invoice", subjectId: 5 }));

    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "invoice.director_request_sent", subjectId: "5", subjectType: "invoice" });
    expect(orderOf(STAMP_INVOICE)).toBeGreaterThan(-1);
    expect(orderOf(STAMP_QUOTE)).toBe(-1);
  });

  it("leads the row with what the record is, in the keys every money row carries: who it is for and its number", async () => {
    await sendDirectorRequest(
      request({ facts: { amount: 5000, contractorId: 8, contractorName: "Beta Pty", direction: "incoming", invoiceNumber: "IV-9-1" }, stage: "invoice" }),
    );

    expect(ledgerInserts(db.executeQuery)[0].after).toMatchObject({
      amount: 5000,
      contractorId: 8,
      contractorName: "Beta Pty",
      direction: "incoming",
      invoiceNumber: "IV-9-1",
    });
  });

  it("records the amount that was emailed, whatever the facts say", async () => {
    await sendDirectorRequest(request({ amount: 5100, facts: { ...FACTS, amount: 4900 } }));

    expect(ledgerInserts(db.executeQuery)[0].after).toMatchObject({ amount: 5100 });
  });

  it("gives the row a correlation id of its own when the caller has none to share", async () => {
    await sendDirectorRequest(request({ correlationId: undefined }));

    expect(String(ledgerInserts(db.executeQuery)[0].correlationId)).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("stamps what the e-mail decision check reads: when, to whom (addresses), and by the name the caller gave, which can differ from the ledger's", async () => {
    await sendDirectorRequest(request({ triggeredBy: "C. Controller (from the token)" }));

    const [stamp] = callsTo(STAMP_QUOTE);
    expect(paramsOf(stamp)).toMatchObject({
      Id: 7,
      SentAt: SENT_AT,
      SentBy: "C. Controller (from the token)",
      SentTo: JSON.stringify(["dana@example.com", "boss@example.com"]),
    });
    expect(mail.sendDirectorApprovalEmail).toHaveBeenCalledWith(expect.objectContaining({ triggeredBy: "C. Controller (from the token)" }));
    expect(ledgerInserts(db.executeQuery)[0].actorName).toBe("Casey Controller");
  });

  it("finds the job's building before the mail goes, then stamps and records in one transaction that commits", async () => {
    await sendDirectorRequest(request());

    const mailed = mail.sendDirectorApprovalEmail.mock.invocationCallOrder[0];
    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    expect(orderOf(/SELECT BuildingID FROM Jobs WHERE JobID/)).toBeLessThan(mailed);
    expect(begun).toBeGreaterThan(mailed);
    expect(orderOf(STAMP_QUOTE)).toBeGreaterThan(begun);
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeGreaterThan(orderOf(STAMP_QUOTE));
    expect(orderOf(/INSERT INTO dbo\.DecisionLedger/)).toBeLessThan(committed);
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
  });

  it("sends nothing at all when the job can't even be looked up", async () => {
    mockSql([{ match: /SELECT BuildingID FROM Jobs WHERE JobID/, reject: new Error("connection reset") }]);

    await expect(sendDirectorRequest(request())).rejects.toThrow("connection reset");

    expect(mail.sendDirectorApprovalEmail).not.toHaveBeenCalled();
    expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  });

  describe("naming the recipients", () => {
    it("looks each address up once, lower-cased, among active users", async () => {
      mail.sendDirectorApprovalEmail.mockResolvedValue({ sentAt: SENT_AT, sentTo: [" Dana@Example.com ", "dana@example.com", "boss@example.com"] });

      await sendDirectorRequest(request());

      const [lookup] = callsTo(/SELECT DisplayName FROM dbo\.AppUsers/);
      expect(String(lookup[1])).toMatch(/WHERE Email IN \(@Email0, @Email1\) AND IsActive = 1/);
      expect(paramsOf(lookup)).toEqual({ Email0: "dana@example.com", Email1: "boss@example.com" });
    });

    it("counts an address nobody is named for, instead of showing it", async () => {
      mockSql([JOB, { match: /SELECT DisplayName FROM dbo\.AppUsers/, rows: [{ DisplayName: "Dana Director" }] }]);

      await sendDirectorRequest(request());

      expect(ledgerInserts(db.executeQuery)[0].after).toMatchObject({ recipients: ["Dana Director"], unnamedRecipients: 1 });
    });

    it("does not take a display name that is just an address for a name", async () => {
      mockSql([JOB, { match: /SELECT DisplayName FROM dbo\.AppUsers/, rows: [{ DisplayName: "boss@example.com" }, { DisplayName: "  " }, { DisplayName: null }] }]);

      await sendDirectorRequest(request());

      expect(ledgerInserts(db.executeQuery)[0].after).toMatchObject({ recipients: [], unnamedRecipients: 2 });
      expect(JSON.stringify(ledgerInserts(db.executeQuery))).not.toContain("@example.com");
    });

    it("still records the send, with the names unknown, when the lookup fails", async () => {
      mockSql([JOB, { match: /SELECT DisplayName FROM dbo\.AppUsers/, reject: new Error("timeout") }]);

      const result = await sendDirectorRequest(request());

      expect(result.sentTo).toHaveLength(2);
      expect(ledgerInserts(db.executeQuery)[0].after).toMatchObject({ recipients: [], unnamedRecipients: 2 });
      expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it("looks nobody up when the mail went to nobody", async () => {
      mail.sendDirectorApprovalEmail.mockResolvedValue({ sentAt: SENT_AT, sentTo: [] });

      await sendDirectorRequest(request());

      expect(callsTo(/FROM dbo\.AppUsers/)).toHaveLength(0);
      expect(ledgerInserts(db.executeQuery)[0].after).toMatchObject({ recipients: [], unnamedRecipients: 0 });
    });

    it("records no packet when the mail module gave no summary", async () => {
      mail.sendDirectorApprovalEmail.mockResolvedValue({ sentAt: SENT_AT, sentTo: ["dana@example.com"] });

      await sendDirectorRequest(request());

      expect(ledgerInserts(db.executeQuery)[0].after).toMatchObject({ packet: null });
    });

    it("keeps every address out of everything it writes", async () => {
      await sendDirectorRequest(request());

      expect(JSON.stringify(ledgerInserts(db.executeQuery))).not.toContain("@example.com");
    });
  });

  describe("when the stamp or its row can't be written", () => {
    it("rolls both back and tells the caller; the mail is not sent a second time", async () => {
      mockSql([JOB, NAMES, LEDGER_FAILS]);

      await expect(sendDirectorRequest(request())).rejects.toThrow("ledger unavailable");

      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(orderOf(STAMP_QUOTE)).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
      expect(mail.sendDirectorApprovalEmail).toHaveBeenCalledTimes(1);
    });

    it("rolls back when the stamp itself fails, writing no row", async () => {
      mockSql([JOB, NAMES, { match: STAMP_QUOTE, reject: new Error("deadlock") }]);

      await expect(sendDirectorRequest(request())).rejects.toThrow("deadlock");

      expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    });

    it("rolls back on an entry the ledger refuses (an actor name it can't hold)", async () => {
      await expect(sendDirectorRequest(request({ actor: { ...casey, name: "x".repeat(201) } }))).rejects.toThrow();

      expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    });
  });
});

describe("sendDirectorRequest: when the mail does not go", () => {
  const SEND_ERROR = new Error("Graph sendMail 503 for dana@example.com");
  beforeEach(() => mail.sendDirectorApprovalEmail.mockRejectedValue(SEND_ERROR));

  it("hands the very error back to the caller", async () => {
    await expect(sendDirectorRequest(request())).rejects.toBe(SEND_ERROR);
  });

  it("stamps nothing and writes one `*.director_request_failed` exception row in a transaction of its own", async () => {
    await expect(sendDirectorRequest(request({ resend: true }))).rejects.toBe(SEND_ERROR);

    expect(orderOf(STAMP_QUOTE)).toBe(-1);
    const rows = ledgerInserts(db.executeQuery);
    expect(rows).toEqual([
      expect.objectContaining({
        action: "quote.director_request_failed",
        actorName: "Casey Controller",
        actorRole: "accounts_manager",
        after: { amount: 5000, contractorId: 3, contractorName: "Acme", currency: "AUD", quoteNumber: "QT-9-1", resend: true },
        buildingId: 5,
        correlationId: CORRELATION,
        isException: true,
        jobId: 9,
        reason: "The director approval email could not be sent",
        ruleApplied: "send_failed",
        subjectId: "7",
        subjectType: "quote",
      }),
    ]);
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.beginTransaction.mock.invocationCallOrder[0]).toBeGreaterThan(mail.sendDirectorApprovalEmail.mock.invocationCallOrder[0]);
    expect(rows[0].order).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
  });

  it("does the same for an invoice", async () => {
    await expect(sendDirectorRequest(request({ stage: "invoice", subjectId: 5 }))).rejects.toBe(SEND_ERROR);

    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "invoice.director_request_failed", subjectId: "5", subjectType: "invoice" });
  });

  it("keeps the error text, which can carry addresses, out of the row; the logs have it", async () => {
    await expect(sendDirectorRequest(request())).rejects.toBe(SEND_ERROR);

    expect(JSON.stringify(ledgerInserts(db.executeQuery))).not.toMatch(/Graph|503|@example\.com/);
  });

  it("looks nobody's name up for a mail that went to nobody", async () => {
    await expect(sendDirectorRequest(request())).rejects.toBe(SEND_ERROR);

    expect(callsTo(/FROM dbo\.AppUsers/)).toHaveLength(0);
  });

  it("still hands back the send's error, not the ledger's, when the failure can't be recorded", async () => {
    mockSql([JOB, LEDGER_FAILS]);

    await expect(sendDirectorRequest(request())).rejects.toBe(SEND_ERROR);

    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(sentry.Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: "ledger unavailable" }),
      expect.objectContaining({ tags: { area: "ledger-send-failure" } }),
    );
  });

  it("stops writing failure rows after 20 a minute from one person, so a mail server that is down can't fill a table nothing can empty", async () => {
    for (let i = 0; i < 25; i++) await expect(sendDirectorRequest(request())).rejects.toBe(SEND_ERROR);

    expect(ledgerInserts(db.executeQuery)).toHaveLength(20);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining("not recording this failed quote director request"));
  });
});
