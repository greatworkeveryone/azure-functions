import { readInboundConfig } from "./config";
import { loadPending, runInboundTriage } from "./run";
import { triageEmail } from "./triage";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock("./triage", () => ({ triageEmail: jest.fn() }));
jest.mock("../email/mailbox", () => ({ incomingMailbox: jest.fn(() => "ops@randazzo.properties") }));

const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const triage = jest.mocked(triageEmail);
const connection = {} as never;
const NOW = new Date("2026-10-24T02:00:00Z");

const row = (id: number, over: Record<string, unknown> = {}) => ({
  AIClassification: null, AIFlaggedForReview: false, AIParsedData: null, Body: "b", EmailID: id, FromAddress: "a@b.co", InReplyTo: null,
  IsTest: false, Mailbox: "notices@randazzo.properties", MatchedJobID: null, ReceivedAt: NOW, ReferenceIds: null, Subject: "s", ...over,
});
const on = readInboundConfig({ INBOUND_TRIAGE_ENABLED: "true", INBOUND_TRIAGE_MAILBOXES: "accounts@randazzo.properties" });

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockResolvedValue([row(1), row(2), row(3)]);
  triage.mockResolvedValue({ chosen: null, decision: "queued", emailId: 0, rule: "weak_match", setId: 1 });
});

describe("runInboundTriage", () => {
  it("does nothing, and reads nothing, unless triage or its dry run is on", async () => {
    expect(await runInboundTriage(connection, { config: readInboundConfig({}) })).toBeNull();
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(triage).not.toHaveBeenCalled();
  });

  it("selects positively: triage mailboxes, unassigned, untriaged, recent, not test, not from itself", async () => {
    await runInboundTriage(connection, { config: on, now: NOW });
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toContain("e.Mailbox IN (SELECT [value] FROM OPENJSON(@Mailboxes))");
    expect(sql).toContain("e.AssignedToUserId IS NULL");
    expect(sql).toContain("e.IsTest = 0");
    expect(sql).toContain("e.FromAddress <> e.Mailbox");
    expect(sql).toContain("NOT EXISTS (SELECT 1 FROM dbo.EmailRoutingSets");
    expect(sql).not.toMatch(/\bDELETE\b/i);
    const byName = Object.fromEntries((params as { name: string; value: unknown }[]).map((p) => [p.name, p.value]));
    expect(JSON.parse(String(byName.Mailboxes))).toEqual(["notices@randazzo.properties", "accounts@randazzo.properties"]);
    expect(byName.Max).toBe(25);
    expect((byName.Since as Date).toISOString()).toBe("2026-10-21T02:00:00.000Z");
  });

  it("counts what happened to each email", async () => {
    triage.mockResolvedValueOnce({ chosen: { name: "A", userId: 1 }, decision: "auto", emailId: 1, rule: "clear_leader", setId: 1 });
    triage.mockResolvedValueOnce({ chosen: null, decision: "skipped", emailId: 2, rule: "clear_leader", setId: null });
    const summary = await runInboundTriage(connection, { config: on, now: NOW });
    expect(summary).toEqual({ assigned: 1, dryRun: false, examined: 3, failed: 0, queued: 1, skipped: 1 });
  });

  it("carries on past an email that fails, counts it, and tells Sentry", async () => {
    const log = jest.fn();
    triage.mockRejectedValueOnce(new Error("model fell over"));
    const summary = await runInboundTriage(connection, { config: on, log, now: NOW });
    expect(summary).toMatchObject({ examined: 3, failed: 1, queued: 2 });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("email 1 failed: model fell over"));
    expect((jest.requireMock("../sentry") as { Sentry: { captureException: jest.Mock } }).Sentry.captureException).toHaveBeenCalled();
  });

  it("stops starting new emails once its time is up, leaving the rest for the next run", async () => {
    const summary = await runInboundTriage(connection, { config: on, now: NOW, until: Date.now() - 1 });
    expect(summary).toMatchObject({ examined: 0 });
    expect(triage).not.toHaveBeenCalled();
  });

  it("runs a dry run as a dry run, whatever ENABLED says, and logs a line per email", async () => {
    const log = jest.fn();
    triage.mockResolvedValue({ chosen: { name: "A", userId: 4 }, decision: "auto", emailId: 1, rule: "clear_leader", setId: null });
    const summary = await runInboundTriage(connection, { config: readInboundConfig({ INBOUND_TRIAGE_DRY_RUN: "true", INBOUND_TRIAGE_ENABLED: "true" }), log, now: NOW });
    expect(summary).toMatchObject({ assigned: 3, dryRun: true });
    expect(triage.mock.calls.every((call) => call[2].dryRun === true)).toBe(true);
    expect(log).toHaveBeenCalledWith("inbound triage dry run: email 1 would be assigned to user 4 (clear_leader)");
  });

  it("uses the ranker the setting names, and warns when it names nothing registered", async () => {
    const log = jest.fn();
    const saved = process.env.TRIAGE_RANKER;
    process.env.TRIAGE_RANKER = "learned";
    try {
      await runInboundTriage(connection, { config: on, log, now: NOW });
    } finally {
      if (saved === undefined) delete process.env.TRIAGE_RANKER;
      else process.env.TRIAGE_RANKER = saved;
    }
    expect(log).toHaveBeenCalledWith(expect.stringContaining('TRIAGE_RANKER "learned" is not a registered ranker; using rules@1'));
    expect(triage.mock.calls[0][2].ranker.version).toBe("rules@1");
  });
});

describe("loadPending", () => {
  it("maps rows to emails and takes the config's limits", async () => {
    db.executeQuery.mockResolvedValue([row(7, { AIFlaggedForReview: 1, MatchedJobID: 42, InReplyTo: "p@x" })]);
    const [email] = await loadPending(connection, readInboundConfig({ INBOUND_TRIAGE_MAX_PER_RUN: "5", INBOUND_TRIAGE_MAX_AGE_DAYS: "9" }), NOW);
    expect(email).toMatchObject({ aiFlagged: true, emailId: 7, inReplyTo: "p@x", matchedJobId: 42, receivedAt: NOW });
    const params = Object.fromEntries((db.executeQuery.mock.calls[0][2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value]));
    expect(params.Max).toBe(5);
    expect((params.Since as Date).toISOString()).toBe("2026-10-15T02:00:00.000Z");
  });
});
