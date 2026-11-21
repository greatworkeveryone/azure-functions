import { AwaitingRole, JobEvent, JobStatus } from "../jobStatusMachine";
import { advanceJobStatus } from "../jobStatusHelpers";

jest.mock("../db", () => ({
  executeQuery: jest.fn(),
}));

import { executeQuery } from "../db";

const mockExecuteQuery = executeQuery as jest.MockedFunction<typeof executeQuery>;

interface Call {
  sql: string;
  paramsByName: Record<string, unknown>;
}

function collectCalls(): Call[] {
  return mockExecuteQuery.mock.calls.map(([, sql, params]) => ({
    sql,
    paramsByName: Object.fromEntries((params ?? []).map((p) => [p.name, p.value])),
  }));
}

/** `rowChanges` false = the predicated UPDATE matched no row (the job moved since it was read). */
function stubRead(status: JobStatus | null, role: AwaitingRole = AwaitingRole.FACILITIES, rowChanges = true) {
  mockExecuteQuery.mockImplementation(async (_conn, sql) => {
    if (/SELECT Status, AwaitingRole FROM Jobs/i.test(sql)) {
      return status == null ? [] : [{ Status: status, AwaitingRole: role }];
    }
    if (/UPDATE Jobs[\s\S]*SET Status\s*=\s*@Status/i.test(sql)) return rowChanges ? [{ JobID: 1 }] : [];
    return [];
  });
}

describe("advanceJobStatus", () => {
  const connection = {} as never;

  beforeEach(() => {
    mockExecuteQuery.mockReset();
  });

  it("advances (Work, facilities) → (Awaiting Approval, accounts) on WORK_COMPLETED and logs the event", async () => {
    stubRead(JobStatus.WORK, AwaitingRole.FACILITIES);

    const result = await advanceJobStatus(connection, 42, JobEvent.WORK_COMPLETED, {
      actor: "alice",
      purchaseOrderId: 7,
    });

    expect(result).toEqual({
      advanced: true,
      from: { status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES },
      to: { status: JobStatus.AWAITING_APPROVAL, awaitingRole: AwaitingRole.ACCOUNTS },
    });

    const calls = collectCalls();
    const update = calls.find((c) => /UPDATE Jobs/i.test(c.sql) && /SET Status\s*=\s*@Status/i.test(c.sql));
    expect(update).toBeDefined();
    expect(update!.paramsByName).toMatchObject({
      JobID: 42,
      Status: JobStatus.AWAITING_APPROVAL,
      AwaitingRole: AwaitingRole.ACCOUNTS,
      ExpectedFromStatus: JobStatus.WORK,
      ExpectedFromRole: AwaitingRole.FACILITIES,
    });

    const event = calls.find((c) => /INSERT INTO JobEvents/i.test(c.sql));
    expect(event).toBeDefined();
    expect(event!.paramsByName).toMatchObject({
      JobID: 42,
      CreatedBy: "alice",
      NewStatus: JobStatus.AWAITING_APPROVAL,
      NewAwaitingRole: AwaitingRole.ACCOUNTS,
      PurchaseOrderID: 7,
    });
  });

  it("no-ops on an illegal transition without writing Status", async () => {
    stubRead(JobStatus.DONE, AwaitingRole.ACCOUNTS);

    const result = await advanceJobStatus(connection, 42, JobEvent.WORK_COMPLETED, {
      actor: "alice",
    });

    expect(result.advanced).toBe(false);
    expect(result.from).toEqual({ status: JobStatus.DONE, awaitingRole: AwaitingRole.ACCOUNTS });
    expect(result.to).toBeNull();

    const calls = collectCalls();
    const statusWrite = calls.find(
      (c) => /UPDATE Jobs/i.test(c.sql) && /SET Status\s*=\s*@Status/i.test(c.sql),
    );
    expect(statusWrite).toBeUndefined();

    // But LastModifiedDate-only update still fires.
    const touchOnly = calls.find(
      (c) =>
        /UPDATE Jobs/i.test(c.sql) &&
        /SET LastModifiedDate\s*=\s*SYSUTCDATETIME\(\)\s*WHERE/i.test(c.sql),
    );
    expect(touchOnly).toBeDefined();
  });

  it("returns advanced=false when the job does not exist", async () => {
    stubRead(null);

    const result = await advanceJobStatus(connection, 999, JobEvent.QUOTE_REQUESTED, {
      actor: "alice",
    });

    expect(result).toEqual({ advanced: false, from: null, to: null });
  });

  it("first quote attached to a Quote-status job advances to (Awaiting Approval, facilities)", async () => {
    stubRead(JobStatus.QUOTE, AwaitingRole.FACILITIES);

    const result = await advanceJobStatus(connection, 7, JobEvent.QUOTE_RECEIVED, {
      actor: "bob",
      quoteId: 99,
    });

    expect(result.advanced).toBe(true);
    expect(result.to).toEqual({
      status: JobStatus.AWAITING_APPROVAL,
      awaitingRole: AwaitingRole.FACILITIES,
    });

    const event = collectCalls().find((c) => /INSERT INTO JobEvents/i.test(c.sql));
    expect(event!.paramsByName.QuoteID).toBe(99);
  });

  it("second quote arriving on an already-Awaiting-Approval job is a no-op (idempotent advance)", async () => {
    stubRead(JobStatus.AWAITING_APPROVAL, AwaitingRole.FACILITIES);

    const result = await advanceJobStatus(connection, 7, JobEvent.QUOTE_RECEIVED, {
      actor: "bob",
    });

    expect(result.advanced).toBe(false);
  });

  it("writes no status_change event when the predicated UPDATE matched no row (lane-j)", async () => {
    stubRead(JobStatus.WORK, AwaitingRole.FACILITIES, false);

    const result = await advanceJobStatus(connection, 42, JobEvent.WORK_COMPLETED, { actor: "alice" });

    expect(result).toEqual({
      advanced: false,
      from: { status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES },
      to: null,
    });
    expect(collectCalls().some((c) => /INSERT INTO JobEvents/i.test(c.sql))).toBe(false);
    expect(collectCalls().some((c) => /ServiceScheduleRuns/i.test(c.sql))).toBe(false);
  });

  it("sends a job back to the quote round on QUOTES_DECLINED", async () => {
    stubRead(JobStatus.AWAITING_APPROVAL, AwaitingRole.FACILITIES);

    const result = await advanceJobStatus(connection, 5, JobEvent.QUOTES_DECLINED, { actor: "alice" });

    expect(result.to).toEqual({ status: JobStatus.QUOTE, awaitingRole: AwaitingRole.FACILITIES });
    const event = collectCalls().find((c) => /INSERT INTO JobEvents/i.test(c.sql));
    expect(event!.paramsByName).toMatchObject({ NewStatus: JobStatus.QUOTE, NewAwaitingRole: AwaitingRole.FACILITIES });
  });

  // S1-1: nothing but the work being done may complete a scheduled service.
  it("completes the scheduled service run when work is completed, and not when a quote is approved", async () => {
    stubRead(JobStatus.WORK, AwaitingRole.FACILITIES);
    await advanceJobStatus(connection, 42, JobEvent.WORK_COMPLETED, { actor: "alice" });
    expect(collectCalls().some((c) => /FROM dbo\.ServiceScheduleRuns/i.test(c.sql))).toBe(true);

    mockExecuteQuery.mockReset();
    stubRead(JobStatus.AWAITING_APPROVAL, AwaitingRole.FACILITIES);
    const approved = await advanceJobStatus(connection, 42, JobEvent.QUOTE_APPROVED, { actor: "alice" });
    expect(approved.to).toEqual({ status: JobStatus.WORK, awaitingRole: AwaitingRole.FACILITIES });
    expect(collectCalls().some((c) => /ServiceScheduleRuns/i.test(c.sql))).toBe(false);
  });
});

// REV-02: an event that arrives while a job is on hold moves the saved pre-hold
// state, so resuming lands where the records say the job now is.
describe("advanceJobStatus on a held job", () => {
  const connection = {} as never;
  let held: { status: string | null; role: string | null };

  function stubHeld(status: JobStatus | null, role: AwaitingRole | null, rowChanges = true) {
    held = { status, role };
    mockExecuteQuery.mockImplementation(async (_conn, sql, params) => {
      const p = Object.fromEntries((params ?? []).map((x) => [x.name, x.value]));
      if (/SELECT Status, AwaitingRole FROM Jobs/i.test(sql)) return [{ Status: JobStatus.TENANT, AwaitingRole: AwaitingRole.FACILITIES }];
      if (/SELECT PreBlockStatus, PreBlockAwaitingRole FROM Jobs/i.test(sql)) return [{ PreBlockStatus: held.status, PreBlockAwaitingRole: held.role }];
      if (/SET PreBlockStatus = @NewStatus/i.test(sql)) {
        if (!rowChanges) return [];
        held = { status: p.NewStatus as string, role: p.NewRole as string };
        return [{ JobID: 1 }];
      }
      return [];
    });
  }
  const heldAt = () => `${held.status}/${held.role}`;
  const wrote = (re: RegExp) => collectCalls().filter((c) => re.test(c.sql));

  beforeEach(() => mockExecuteQuery.mockReset());

  it("held at Quote: a quote added and then approved during the hold resumes at Work", async () => {
    stubHeld(JobStatus.QUOTE, AwaitingRole.FACILITIES);
    const received = await advanceJobStatus(connection, 5, JobEvent.QUOTE_RECEIVED, { actor: "alice", quoteId: 1 });
    expect(received).toMatchObject({ advanced: false, heldUpdated: true });
    expect(heldAt()).toBe("Awaiting Approval/facilities");
    await advanceJobStatus(connection, 5, JobEvent.QUOTE_APPROVED, { actor: "alice", quoteId: 1 });
    expect(heldAt()).toBe("Work/facilities");
    const events = wrote(/INSERT INTO JobEvents/i);
    expect(events).toHaveLength(2);
    expect(events[0].sql).toMatch(/'status_while_held'/);
    expect(events[0].paramsByName.Text).toMatch(/recorded while on hold; the job returns here when resumed/);
    // The job itself is never moved out of Tenant.
    expect(wrote(/SET Status\s*=\s*@Status/i)).toHaveLength(0);
  });

  it("held at Work: the purchase order completed during the hold resumes at accounts and stamps the service run", async () => {
    stubHeld(JobStatus.WORK, AwaitingRole.FACILITIES);
    await advanceJobStatus(connection, 5, JobEvent.WORK_COMPLETED, { actor: "alice", purchaseOrderId: 3 });
    expect(heldAt()).toBe("Awaiting Approval/accounts");
    expect(collectCalls().some((c) => /FROM dbo\.ServiceScheduleRuns/i.test(c.sql))).toBe(true);
  });

  it("held at accounts: an invoice approved during the hold does not close the job", async () => {
    stubHeld(JobStatus.AWAITING_APPROVAL, AwaitingRole.ACCOUNTS);
    const result = await advanceJobStatus(connection, 5, JobEvent.INVOICE_APPROVED, { actor: "alice", invoiceId: 4 });
    expect(result.heldUpdated).toBeUndefined();
    expect(heldAt()).toBe("Awaiting Approval/accounts");
    expect(wrote(/INSERT INTO JobEvents/i)).toHaveLength(0);
  });

  it("a legacy hold with no saved state treats the job as at Work", async () => {
    stubHeld(null, null);
    await advanceJobStatus(connection, 5, JobEvent.WORK_COMPLETED, { actor: "alice" });
    expect(heldAt()).toBe("Awaiting Approval/accounts");
  });

  it("writes no event when the saved state changed under it", async () => {
    stubHeld(JobStatus.QUOTE, AwaitingRole.FACILITIES, false);
    const result = await advanceJobStatus(connection, 5, JobEvent.QUOTE_RECEIVED, { actor: "alice" });
    expect(result.heldUpdated).toBeUndefined();
    expect(wrote(/INSERT INTO JobEvents/i)).toHaveLength(0);
  });
});
