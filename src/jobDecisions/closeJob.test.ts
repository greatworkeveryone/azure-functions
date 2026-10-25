/// <reference types="jest" />
// Closing an Admin / Accounts job from its decision's last step (jobs plan A2). The machine and the
// transition guard are the real ones, because what is proved here is that the guard has the last word:
// a move it refuses writes nothing, whatever the machine would have allowed. Reading the job and writing
// its history are replaced, because they have their own tests.
import type { Connection } from "tedious";
import { executeQuery } from "../db";
import { loadJobForTransition, type LockedJob } from "../jobTransitionFacts";
import { closeInternalJobWithin, type CloseInput } from "./closeJob";
import { insertJobEvent } from "./decisionsStore";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../jobTransitionFacts", () => ({ loadJobForTransition: jest.fn() }));
jest.mock("./decisionsStore", () => ({ insertJobEvent: jest.fn() }));

const query = jest.mocked(executeQuery);
const load = jest.mocked(loadJobForTransition);
const event = jest.mocked(insertJobEvent);

const conn = {} as Connection;

const FACTS: LockedJob["facts"] = {
  allInvoicesPaid: false,
  approvedInvoicesNotInMyob: 0,
  hasApprovedQuote: false,
  hasQuote: false,
  incomingInvoices: 0,
  incomingInvoicesAwaitingApproval: 0,
  isContract: false,
  isInternal: true,
};

const locked = (over: Partial<LockedJob> = {}, facts: Partial<LockedJob["facts"]> = {}): LockedJob => ({
  buildingId: 5,
  current: { awaitingRole: "facilities", status: "Work" },
  facts: { ...FACTS, ...facts },
  hasMoneyRecords: false,
  preBlock: null,
  ...over,
});

const input = (over: Partial<CloseInput> = {}): CloseInput => ({
  actorName: "Alana",
  jobId: 12,
  roles: ["accounts"],
  text: "Next step done: Pay the invoice",
  ...over,
});

/** Nothing was written: no UPDATE, no history line. */
const nothingWritten = () => {
  expect(query).not.toHaveBeenCalled();
  expect(event).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.clearAllMocks();
  load.mockResolvedValue(locked());
  query.mockResolvedValue([{ JobID: 12 }]);
});

describe("closing a job in-house", () => {
  it("moves an internal job to Done, the update predicated on the state the guard decided on, and writes the history line", async () => {
    expect(await closeInternalJobWithin(conn, input())).toEqual({ closed: true });

    expect(query).toHaveBeenCalledTimes(1);
    const [, sql, params] = query.mock.calls[0];
    expect(sql).toMatch(/UPDATE dbo\.Jobs\s+SET Status = @Status/);
    expect(sql).toMatch(/WHERE JobID = @JobID AND Status = @ExpectedStatus/);
    expect(params).toEqual([
      expect.objectContaining({ name: "JobID", value: 12 }),
      expect.objectContaining({ name: "Status", value: "Done" }),
      expect.objectContaining({ name: "AwaitingRole", value: "facilities" }),
      expect.objectContaining({ name: "ExpectedStatus", value: "Work" }),
      expect.objectContaining({ name: "ExpectedAwaitingRole", value: "facilities" }),
    ]);
    expect(event).toHaveBeenCalledWith(conn, {
      createdBy: "Alana",
      eventType: "status_change",
      jobId: 12,
      newAwaitingRole: "facilities",
      newStatus: "Done",
      text: "Next step done: Pay the invoice",
    });
  });

  it("takes a job held with the tenant out of the hold as it closes it", async () => {
    load.mockResolvedValue(locked({ current: { awaitingRole: "facilities", status: "Tenant" } }));

    expect(await closeInternalJobWithin(conn, input())).toEqual({ closed: true });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[1][1]).toMatch(/SET PreBlockStatus = NULL, PreBlockAwaitingRole = NULL/);
    expect(event).toHaveBeenCalledTimes(1);
  });

  it("says there is no such job, and writes nothing", async () => {
    load.mockResolvedValue(null);

    expect(await closeInternalJobWithin(conn, input())).toEqual({ closed: false, code: "job_not_found", reason: "That job doesn't exist." });
    nothingWritten();
  });

  it("says the job changed when the update finds the state it decided on gone, and writes no history line", async () => {
    query.mockResolvedValue([]);

    expect(await closeInternalJobWithin(conn, input())).toEqual({
      closed: false,
      code: "job_changed",
      reason: "This job changed while it was being closed. Reload it and try again.",
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(event).not.toHaveBeenCalled();
  });
});

describe("the transition guard has the last word", () => {
  it("a role the guard refuses does not close a job the machine would let close: its sentence comes back, nothing is written", async () => {
    // An internal job in Work is a legal move for the machine; only the role stops it.
    const result = await closeInternalJobWithin(conn, input({ roles: ["user"] }));

    expect(result).toEqual({ closed: false, code: "role_not_permitted", reason: "Your role can't make this change." });
    nothingWritten();
  });

  it("no role at all is refused the same", async () => {
    expect(await closeInternalJobWithin(conn, input({ roles: [] }))).toMatchObject({ closed: false, code: "role_not_permitted" });
    nothingWritten();
  });

  it("a job whose machine move is not allowed (not internal, so no direct close) is not closed: the guard's sentence, nothing written", async () => {
    load.mockResolvedValue(locked({}, { isInternal: false }));

    const result = await closeInternalJobWithin(conn, input());

    expect(result).toEqual({ closed: false, code: "illegal", reason: "A job can't move there from where it is now." });
    nothingWritten();
  });

  it("a job that is already done is not closed again", async () => {
    load.mockResolvedValue(locked({ current: { awaitingRole: "facilities", status: "Done" } }));

    expect(await closeInternalJobWithin(conn, input())).toEqual({
      closed: false,
      code: "done_is_final",
      reason: "This job is done. A manager can reopen it, with a reason.",
    });
    nothingWritten();
  });
});
