/// <reference types="jest" />
import { FACTS } from "../__tests__/fixtures/absenceCover";
import { loadCoverState } from "./load";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../approvalAuthority-db", () => ({ loadApprovalFacts: jest.fn() }));
jest.mock("../escalation/store", () => ({ listActiveUsers: jest.fn() }));
jest.mock("../peopleWorkflow", () => ({ loadPeople: jest.fn() }));
jest.mock("./delegateStore", () => ({ listDelegatesOn: jest.fn() }));
jest.mock("./inventory/emails", () => ({ probeEmailColumns: jest.fn() }));

const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const conn = {} as never;

/** Answers by what is being read, not by the order the reads happen in. */
const answer = (leaves: Record<string, unknown>[], seen: Record<string, unknown>[]) =>
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (/LeaveRequests/.test(sql) ? leaves : /AccessEvents/.test(sql) ? seen : []));
const sqlOf = (pattern: RegExp): string => String(db.executeQuery.mock.calls.map((call) => call[1]).find((sql) => pattern.test(String(sql))));

beforeEach(() => {
  jest.resetAllMocks();
  (jest.requireMock("../approvalAuthority-db") as { loadApprovalFacts: jest.Mock }).loadApprovalFacts.mockResolvedValue(FACTS);
  (jest.requireMock("../escalation/store") as { listActiveUsers: jest.Mock }).listActiveUsers.mockResolvedValue([{ email: null, name: "Fay", role: "facilities", userId: 1 }]);
  (jest.requireMock("../peopleWorkflow") as { loadPeople: jest.Mock }).loadPeople.mockResolvedValue({ links: [{ managerId: 2, userId: 1 }], staff: [{ id: 1, name: "Fay", oid: "a", role: "facilities" }] });
  (jest.requireMock("./delegateStore") as { listDelegatesOn: jest.Mock }).listDelegatesOn.mockResolvedValue([{ coverDelegateId: 5, delegateUserId: 7, fromDate: "2026-10-26", leaveRequestId: null, toDate: "2026-10-30", userId: 1 }]);
  (jest.requireMock("./inventory/emails") as { probeEmailColumns: jest.Mock }).probeEmailColumns.mockResolvedValue({ assignedToUserId: false });
});

describe("loadCoverState", () => {
  it("gathers the directory, the nominations, the reporting lines, the approval facts and the email columns", async () => {
    answer([], []);
    const state = await loadCoverState(conn, "2026-10-26", true);
    expect(state.directory).toHaveLength(1);
    expect(state.delegates).toHaveLength(1);
    expect(state.links).toEqual([{ managerId: 2, userId: 1 }]);
    expect(state.staff).toHaveLength(1);
    expect(state.facts).toBe(FACTS);
    expect(state.emailColumns).toEqual({ assignedToUserId: false });
  });

  it("reads approved leave still running or starting within 90 days, with the Darwin day it was approved", async () => {
    answer([{ EndDate: "2026-10-30", Kind: "annual_leave", RequestId: 11, StartDate: "2026-10-26", UpdatedAt: new Date("2026-10-25T20:00:00Z"), UserId: 1 }], []);
    const state = await loadCoverState(conn, "2026-10-26", true);
    const sql = sqlOf(/LeaveRequests/);
    expect(sql).toContain("Status = N'approved' AND EndDate >= @Today AND StartDate <= DATEADD(day, 90, @Today)");
    // 20:00 UTC on the 25th is 05:30 on the 26th in Darwin.
    expect(state.leaves).toEqual([{ approvedOn: "2026-10-26", endDate: "2026-10-30", kind: "annual_leave", requestId: 11, startDate: "2026-10-26", userId: 1 }]);
  });

  it("reads when each person was last seen, as a Darwin day, over the last 45 days", async () => {
    answer([], [{ LastAt: new Date("2026-10-22T20:00:00Z"), UserID: 7 }]);
    const state = await loadCoverState(conn, "2026-10-26", true);
    expect(sqlOf(/AccessEvents/)).toContain("DATEADD(day, -45, SYSUTCDATETIME())");
    expect(state.lastSeenOn).toEqual(new Map([[7, "2026-10-23"]]));
  });

  it("does not read the access log at all when access logging is off", async () => {
    answer([], []);
    const state = await loadCoverState(conn, "2026-10-26", false);
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
    expect(String(db.executeQuery.mock.calls[0][1])).not.toMatch(/AccessEvents/);
    expect(state.lastSeenOn.size).toBe(0);
  });
});
