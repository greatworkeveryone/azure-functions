import { record } from "../ledger";
import { appendEvent } from "./events";
import { settleJob, sqlQueueStore } from "./queueStore";
import * as store from "./store";
import type { JobRow } from "./types";

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  executeQuery: jest.fn().mockResolvedValue([]),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../ledger", () => ({ record: jest.fn() }));
jest.mock("./events", () => ({ appendEvent: jest.fn() }));
jest.mock("./store");

const s = jest.mocked(store);
const conn = {} as never;
const job = (status: JobRow["status"]) => ({ correspondenceId: 41, status }) as JobRow;
const tally = (over: Partial<store.JobTally> = {}): store.JobTally => ({ blocked: 0, failed: 0, pending: 0, recipients: 3, sent: 3, ...over });

beforeEach(() => {
  jest.clearAllMocks();
  s.completeJob.mockResolvedValue(true);
  s.readJob.mockResolvedValue(job("sending"));
});

describe("settleJob", () => {
  it("completes a job with nothing waiting as sent when anything went, with an event and a ledger row", async () => {
    s.refreshCounts.mockResolvedValue(tally({ failed: 1, sent: 2 }));
    await settleJob(conn, 41);
    expect(s.completeJob).toHaveBeenCalledWith(conn, 41, "sent");
    expect(jest.mocked(appendEvent)).toHaveBeenCalledWith(conn, expect.objectContaining({ actor: { kind: "system", name: "commsSendTimer" }, fromStatus: "sending", toStatus: "sent", type: "job" }));
    expect(jest.mocked(record)).toHaveBeenCalledWith(conn, expect.objectContaining({ action: "correspondence.sent", actor: { kind: "system", name: "commsSendTimer" }, subject: { id: 41, type: "correspondence" } }));
  });

  it("completes it as failed when nothing went", async () => {
    s.refreshCounts.mockResolvedValue(tally({ failed: 2, sent: 0 }));
    await settleJob(conn, 41);
    expect(s.completeJob).toHaveBeenCalledWith(conn, 41, "failed");
  });

  it("leaves a job alone while a recipient is queued, sending or would-send", async () => {
    s.refreshCounts.mockResolvedValue(tally({ pending: 1 }));
    await settleJob(conn, 41);
    expect(s.completeJob).not.toHaveBeenCalled();
    expect(jest.mocked(record)).not.toHaveBeenCalled();
  });

  it("leaves alone a job that is cancelled, awaiting approval, or already complete, and one with no recipients", async () => {
    s.refreshCounts.mockResolvedValue(tally());
    for (const status of ["cancelled", "awaiting_approval", "sent", "failed"] as const) {
      s.readJob.mockResolvedValueOnce(job(status));
      await settleJob(conn, 41);
    }
    s.refreshCounts.mockResolvedValue(tally({ recipients: 0 }));
    await settleJob(conn, 41);
    expect(s.completeJob).not.toHaveBeenCalled();
  });

  it("writes no event or ledger row when someone else completed it first", async () => {
    s.refreshCounts.mockResolvedValue(tally());
    s.completeJob.mockResolvedValue(false);
    await settleJob(conn, 41);
    expect(jest.mocked(appendEvent)).not.toHaveBeenCalled();
    expect(jest.mocked(record)).not.toHaveBeenCalled();
  });
});

describe("sqlQueueStore", () => {
  const item = { job: { correspondenceId: 41 }, recipient: { recipientId: 9 } } as never;

  it("records an outcome and its event together, and no event if the recipient had moved on", async () => {
    s.setRecipientOutcome.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const queue = sqlQueueStore(conn);
    expect(await queue.outcome(item, "sending", { errorCode: "graph_rejected", status: "failed" })).toBe(true);
    expect(jest.mocked(appendEvent)).toHaveBeenCalledWith(conn, expect.objectContaining({ correspondenceId: 41, errorCode: "graph_rejected", fromStatus: "sending", recipientId: 9, toStatus: "failed", type: "recipient" }));
    jest.mocked(appendEvent).mockClear();
    expect(await queue.outcome(item, "sending", { status: "sent" })).toBe(false);
    expect(jest.mocked(appendEvent)).not.toHaveBeenCalled();
  });

  it("writes the job's sending event once, only when it moved", async () => {
    s.moveJob.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const queue = sqlQueueStore(conn);
    await queue.markJobSending(41);
    await queue.markJobSending(41);
    expect(jest.mocked(appendEvent)).toHaveBeenCalledTimes(1);
    expect(jest.mocked(appendEvent)).toHaveBeenCalledWith(conn, expect.objectContaining({ fromStatus: "queued", toStatus: "sending" }));
  });

  it("writes an event for each recovered recipient and returns the jobs to settle", async () => {
    s.recoverStale.mockResolvedValue({ failed: [{ correspondenceId: 41, recipientId: 1 }], requeued: [{ correspondenceId: 42, recipientId: 2 }, { correspondenceId: 41, recipientId: 3 }] });
    const jobs = await sqlQueueStore(conn).recoverStale(10);
    expect(jobs.sort()).toEqual([41, 42]);
    expect(jest.mocked(appendEvent).mock.calls.map((call) => [call[1].recipientId, call[1].toStatus, call[1].errorCode])).toEqual([[1, "failed", "send_unconfirmed"], [2, "queued", "interrupted"], [3, "queued", "interrupted"]]);
  });
});
