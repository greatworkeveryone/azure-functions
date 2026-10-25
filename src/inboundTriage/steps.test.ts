import type { InvocationContext } from "@azure/functions";
import { syncMailbox } from "../email/mail-sync";
import { runInboundTriage } from "./run";
import { runTriageStep, syncExtraMailboxes, TRIAGE_GRACE_MS } from "./steps";

jest.mock("../db", () => ({ closeConnection: jest.fn(), createServiceRequestConnection: jest.fn(async () => ({ id: "conn" })) }));
jest.mock("../email/mail-sync", () => ({ syncMailbox: jest.fn() }));
jest.mock("../email/mailbox", () => ({ incomingMailbox: jest.fn(() => "ops@randazzo.properties") }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock("./run", () => ({ runInboundTriage: jest.fn() }));

const db = jest.requireMock("../db") as { closeConnection: jest.Mock; createServiceRequestConnection: jest.Mock };
const sentry = (jest.requireMock("../sentry") as { Sentry: { captureException: jest.Mock } }).Sentry;
const sync = jest.mocked(syncMailbox);
const triage = jest.mocked(runInboundTriage);
const context = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const SETTINGS = ["INBOUND_EXTRA_MAILBOXES", "INBOUND_TRIAGE_ENABLED", "INBOUND_TRIAGE_DRY_RUN"];

beforeEach(() => {
  jest.clearAllMocks();
  for (const name of SETTINGS) delete process.env[name];
  sync.mockResolvedValue({ fetched: 3, pages: 1, since: "2026-10-24T00:00:00.000Z" });
  triage.mockResolvedValue({ assigned: 1, dryRun: false, examined: 2, failed: 0, queued: 1, skipped: 0 });
});

afterAll(() => {
  for (const name of SETTINGS) delete process.env[name];
});

describe("syncExtraMailboxes", () => {
  it("reads nothing, and opens no connection, when no extra mailbox is set", async () => {
    await syncExtraMailboxes(context, "graph");
    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });

  it("reads each extra mailbox on its own connection, starting from now when it has never been read", async () => {
    process.env.INBOUND_EXTRA_MAILBOXES = "accounts@randazzo.properties, facilities@randazzo.properties";
    await syncExtraMailboxes(context, "graph");
    expect(sync.mock.calls.map((call) => [call[1], call[2]])).toEqual([
      ["accounts@randazzo.properties", { startFromNow: true }],
      ["facilities@randazzo.properties", { startFromNow: true }],
    ]);
    expect(db.createServiceRequestConnection).toHaveBeenCalledTimes(2);
    expect(db.closeConnection).toHaveBeenCalledTimes(2);
  });

  it("never reads the main mailbox again as an extra one", async () => {
    process.env.INBOUND_EXTRA_MAILBOXES = "OPS@randazzo.properties";
    await syncExtraMailboxes(context, "graph");
    expect(sync).not.toHaveBeenCalled();
  });

  it("carries on past a mailbox that fails, tells Sentry, and never throws into the queue handler", async () => {
    process.env.INBOUND_EXTRA_MAILBOXES = "accounts@randazzo.properties,facilities@randazzo.properties";
    sync.mockRejectedValueOnce(new Error("Graph fetch emails failed: 403"));
    await expect(syncExtraMailboxes(context, "graph")).resolves.toBeUndefined();
    expect(sync).toHaveBeenCalledTimes(2);
    expect(context.error).toHaveBeenCalledWith("processEmailSync extra mailbox accounts@randazzo.properties failed:", "Graph fetch emails failed: 403");
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(db.closeConnection).toHaveBeenCalledTimes(2);
  });

  it("warns about an entry that is not an address, and ignores it", async () => {
    process.env.INBOUND_EXTRA_MAILBOXES = "accounts@randazzo.properties,not-an-address";
    await syncExtraMailboxes(context, "graph");
    expect(context.warn).toHaveBeenCalledWith(expect.stringContaining("not-an-address"));
    expect(sync).toHaveBeenCalledTimes(1);
  });
});

describe("runTriageStep", () => {
  it("does nothing, and opens no connection, unless triage or its dry run is on", async () => {
    await runTriageStep(context, Date.now());
    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
    expect(triage).not.toHaveBeenCalled();
  });

  it("runs the batch on its own connection, within what is left of the invocation, and logs the counts", async () => {
    process.env.INBOUND_TRIAGE_ENABLED = "true";
    const deadline = Date.now() + 1000;
    await runTriageStep(context, deadline);
    expect(triage).toHaveBeenCalledWith({ id: "conn" }, expect.objectContaining({ until: deadline + TRIAGE_GRACE_MS }));
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
    expect(context.log).toHaveBeenCalledWith("inbound triage: examined 2, assigned 1, queued 1, skipped 0, failed 0");
  });

  it("says when it was a dry run", async () => {
    process.env.INBOUND_TRIAGE_DRY_RUN = "true";
    triage.mockResolvedValue({ assigned: 0, dryRun: true, examined: 1, failed: 0, queued: 1, skipped: 0 });
    await runTriageStep(context, Date.now());
    expect(context.log).toHaveBeenCalledWith("inbound triage (dry run): examined 1, assigned 0, queued 1, skipped 0, failed 0");
  });

  it("never throws into the queue handler: a failure is logged and sent to Sentry", async () => {
    process.env.INBOUND_TRIAGE_ENABLED = "true";
    triage.mockRejectedValue(new Error("database is down"));
    await expect(runTriageStep(context, Date.now())).resolves.toBeUndefined();
    expect(context.error).toHaveBeenCalledWith("inbound triage failed:", "database is down");
    expect(sentry.captureException).toHaveBeenCalledTimes(1);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});
