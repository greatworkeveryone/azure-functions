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

function stubRead(status: JobStatus | null, role: AwaitingRole = AwaitingRole.FACILITIES) {
  mockExecuteQuery.mockImplementation(async (_conn, sql) => {
    if (/SELECT Status, AwaitingRole FROM Jobs/i.test(sql)) {
      return status == null ? [] : [{ Status: status, AwaitingRole: role }];
    }
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
});
