/// <reference types="jest" />
// EB3: where processEmailSync reads the extra mailboxes and triages. The main mailbox is synced
// first and exactly as before; the extra mailboxes follow; the parse worker runs; triage comes last
// (after the parse, so it can use what the parse worker found).
import type { InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
}));
jest.mock("../auth", () => ({ ...jest.requireActual("../auth"), extractToken: jest.fn().mockReturnValue("tok"), requireRole: jest.fn().mockResolvedValue(null) }));
jest.mock("../blob-storage", () => ({ generateReadSasUrl: jest.fn() }));
jest.mock("../rateLimit", () => ({ checkRateLimit: jest.fn().mockReturnValue({ allowed: true, retryAfterMs: 0 }) }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), flush: jest.fn().mockResolvedValue(true) } }));
jest.mock("../email/mail-sync", () => ({ syncMailbox: jest.fn().mockResolvedValue({ fetched: 0, pages: 0, since: null }) }));
jest.mock("../inboundTriage/steps", () => ({ runTriageStep: jest.fn().mockResolvedValue(undefined), syncExtraMailboxes: jest.fn().mockResolvedValue(undefined) }));

const mailSync = jest.requireMock("../email/mail-sync") as { syncMailbox: jest.Mock };
const steps = jest.requireMock("../inboundTriage/steps") as { runTriageStep: jest.Mock; syncExtraMailboxes: jest.Mock };
const { processEmailSync } = require("./parseEmails") as typeof import("./parseEmails");
const context = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const message = { requestedAt: "2026-10-24T00:00:00.000Z", source: "graph" };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GRAPH_MAILBOX_ACTIVE = "dev";
  process.env.GRAPH_MAILBOX_DEV = "inbox@example.test";
});

describe("processEmailSync and the inbound steps", () => {
  it("syncs the main mailbox with the arguments it always had, then the extras, and triages last", async () => {
    await processEmailSync(message, context);
    expect(mailSync.syncMailbox).toHaveBeenCalledTimes(1);
    expect(mailSync.syncMailbox).toHaveBeenCalledWith({}, "inbox@example.test");
    const order = (mock: jest.Mock) => mock.mock.invocationCallOrder[0];
    expect(order(mailSync.syncMailbox)).toBeLessThan(order(steps.syncExtraMailboxes));
    expect(order(steps.syncExtraMailboxes)).toBeLessThan(order(steps.runTriageStep));
    expect(steps.syncExtraMailboxes).toHaveBeenCalledWith(context, "graph");
  });

  it("gives triage the parse's own deadline, so it cannot outlast the invocation", async () => {
    const before = Date.now();
    await processEmailSync(message, context);
    const deadline = steps.runTriageStep.mock.calls[0][1] as number;
    expect(deadline).toBeGreaterThanOrEqual(before + 540_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 540_000);
  });

  it("a failed main sync still throws so the queue retries, and neither the extras nor triage run", async () => {
    mailSync.syncMailbox.mockRejectedValueOnce(new Error("Graph fetch emails failed: 503"));
    await expect(processEmailSync(message, context)).rejects.toThrow("503");
    expect(steps.syncExtraMailboxes).not.toHaveBeenCalled();
    expect(steps.runTriageStep).not.toHaveBeenCalled();
  });
});
