/// <reference types="jest" />
import { moveDecision } from "./moveDecision";
import { moveEmail } from "./moveEmail";
import { moveEscalation } from "./moveEscalation";
import { moveJob } from "./moveJob";
import type { MoveArgs } from "./types";

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../../jobDecisions/store", () => ({ getRequestRow: jest.fn() }));
jest.mock("../../escalation/store", () => ({ findLiveEscalation: jest.fn(), getEscalationRow: jest.fn(), updateEscalation: jest.fn() }));
jest.mock("../inventory/emails", () => ({ probeEmailColumns: jest.fn() }));

const db = jest.requireMock("../../db") as { executeQuery: jest.Mock };
const decisions = jest.requireMock("../../jobDecisions/store") as { getRequestRow: jest.Mock };
const store = jest.requireMock("../../escalation/store") as { findLiveEscalation: jest.Mock; getEscalationRow: jest.Mock; updateEscalation: jest.Mock };
const emails = jest.requireMock("../inventory/emails") as { probeEmailColumns: jest.Mock };
const conn = {} as never;

const args = (over: Partial<MoveArgs> = {}): MoveArgs => ({
  actorName: "Floorplan (cover while away)",
  detail: {},
  from: { name: "Fay Facilities", userId: 1 },
  itemId: "12",
  reason: "It falls due before they are back.",
  to: { name: "Max Manager", userId: 2 },
  ...over,
});
const sqls = (): string[] => db.executeQuery.mock.calls.map((call) => String(call[1]));
const paramsOf = (index: number): Record<string, unknown> => Object.fromEntries((db.executeQuery.mock.calls[index][2] as { name: string; value: unknown }[]).map((param) => [param.name, param.value]));

beforeEach(() => {
  jest.resetAllMocks();
});

describe("moveJob", () => {
  it("writes the history entry and then the reassignment, predicated on it still being theirs", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ AssignedToUserID: 1, IsArchived: false, Status: "Work" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ JobID: 12 }]);
    expect(await moveJob(conn, args())).toBe(true);
    expect(sqls()[0]).toContain("WITH (UPDLOCK, HOLDLOCK)");
    expect(sqls()[1]).toContain("INSERT INTO dbo.JobEvents");
    expect(sqls()[1]).toContain("N'assignment_change'");
    expect(paramsOf(1)).toMatchObject({ CreatedBy: "Floorplan (cover while away)", NewAssignee: "Max Manager" });
    expect(String(paramsOf(1).Text)).toBe("Reassigned to Max Manager (was Fay Facilities): It falls due before they are back.");
    expect(sqls()[2]).toContain("UPDATE dbo.Jobs SET AssignedTo = @Name, AssignedToUserID = @To");
    expect(sqls()[2]).toContain("WHERE JobID = @JobID AND AssignedToUserID = @From");
    expect(sqls()[2]).not.toMatch(/Status\s*=/);
    expect(paramsOf(2)).toMatchObject({ From: 1, JobID: 12, Name: "Max Manager", To: 2 });
  });

  it.each([
    ["someone else already has it", { AssignedToUserID: 3, IsArchived: false, Status: "Work" }],
    ["it is done", { AssignedToUserID: 1, IsArchived: false, Status: "Done" }],
    ["it is archived", { AssignedToUserID: 1, IsArchived: true, Status: "Work" }],
  ])("writes nothing when %s", async (_label, row) => {
    db.executeQuery.mockResolvedValueOnce([row]);
    expect(await moveJob(conn, args())).toBe(false);
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the job is gone", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    expect(await moveJob(conn, args())).toBe(false);
  });

  it("reports false when the predicated update finds it moved after all", async () => {
    db.executeQuery.mockResolvedValueOnce([{ AssignedToUserID: 1, IsArchived: false, Status: "Work" }]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await moveJob(conn, args())).toBe(false);
  });
});

describe("moveDecision", () => {
  const request = (userIds = [1], over: Record<string, unknown> = {}) => ({ decisionMakers: { role: null, userIds }, jobId: 12, requestId: 5, rowVersion: Buffer.from("rv").toString("base64"), state: "pending", ...over });

  it("adds the cover to the people asked, keeps the person who is away named, and points the live escalation at the cover", async () => {
    decisions.getRequestRow.mockResolvedValue(request());
    db.executeQuery.mockResolvedValueOnce([{ RequestId: 5 }]).mockResolvedValueOnce([]);
    store.findLiveEscalation.mockResolvedValue({ escalationId: 40, level: 1, rowVersion: "ev" });
    store.updateEscalation.mockResolvedValue(true);
    expect(await moveDecision(conn, args({ detail: { jobId: 12 }, itemId: "5" }))).toBe(true);
    expect(paramsOf(0).Makers).toBe(JSON.stringify({ role: null, userIds: [1, 2] }));
    expect(sqls()[0]).toContain("State = N'pending' AND RowVersion = @RowVersion");
    expect(store.findLiveEscalation).toHaveBeenCalledWith(conn, "job", "12", "job.decision_pending");
    expect(store.updateEscalation).toHaveBeenCalledWith(conn, 40, "ev", { TargetUserId: 2 });
    expect(sqls()[1]).toContain("N'comment'");
  });

  it("reports false, having already written the makers, when the escalation turns out stale: the caller must roll back", async () => {
    decisions.getRequestRow.mockResolvedValue(request());
    db.executeQuery.mockResolvedValueOnce([{ RequestId: 5 }]);
    store.findLiveEscalation.mockResolvedValue({ escalationId: 40, level: 1, rowVersion: "ev" });
    store.updateEscalation.mockResolvedValue(false);
    expect(await moveDecision(conn, args({ itemId: "5" }))).toBe(false);
    expect(sqls()[0]).toContain("UPDATE dbo.JobDecisionRequests");
  });

  it("leaves an escalation that has moved up to the manager alone", async () => {
    decisions.getRequestRow.mockResolvedValue(request());
    db.executeQuery.mockResolvedValueOnce([{ RequestId: 5 }]).mockResolvedValueOnce([]);
    store.findLiveEscalation.mockResolvedValue({ escalationId: 40, level: 2, rowVersion: "ev" });
    expect(await moveDecision(conn, args({ itemId: "5" }))).toBe(true);
    expect(store.updateEscalation).not.toHaveBeenCalled();
  });

  it("takes the cover off again on a take-back and puts the person back", async () => {
    decisions.getRequestRow.mockResolvedValue(request([1, 2]));
    db.executeQuery.mockResolvedValueOnce([{ RequestId: 5 }]).mockResolvedValueOnce([]);
    store.findLiveEscalation.mockResolvedValue(null);
    expect(await moveDecision(conn, args({ from: { name: "Max Manager", userId: 2 }, itemId: "5", takeBack: true, to: { name: "Fay Facilities", userId: 1 } }))).toBe(true);
    expect(paramsOf(0).Makers).toBe(JSON.stringify({ role: null, userIds: [1] }));
  });

  it.each([
    ["answered", request([1], { state: "answered" })],
    ["no longer asking them", request([3])],
  ])("writes nothing when the request is %s", async (_label, row) => {
    decisions.getRequestRow.mockResolvedValue(row);
    expect(await moveDecision(conn, args({ itemId: "5" }))).toBe(false);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("writes nothing when the request is gone, and reports false when its version moved", async () => {
    decisions.getRequestRow.mockResolvedValue(null);
    expect(await moveDecision(conn, args({ itemId: "5" }))).toBe(false);
    decisions.getRequestRow.mockResolvedValue(request());
    db.executeQuery.mockResolvedValueOnce([]);
    expect(await moveDecision(conn, args({ itemId: "5" }))).toBe(false);
    expect(store.updateEscalation).not.toHaveBeenCalled();
  });
});

describe("moveEscalation", () => {
  const row = (over: Record<string, unknown> = {}) => ({ escalationId: 40, rowVersion: "v1", status: "open", targetUserId: 1, ...over });

  it("points a live escalation at the cover with its own versioned update", async () => {
    store.getEscalationRow.mockResolvedValue(row());
    store.updateEscalation.mockResolvedValue(true);
    expect(await moveEscalation(conn, args({ detail: { rowVersion: "v1" }, itemId: "40" }))).toBe(true);
    expect(store.getEscalationRow).toHaveBeenCalledWith(conn, 40, { forUpdate: true });
    expect(store.updateEscalation).toHaveBeenCalledWith(conn, 40, "v1", { TargetUserId: 2 });
  });

  it.each([
    ["it was resolved", row({ status: "resolved" })],
    ["it is aimed at someone else now", row({ targetUserId: 3 })],
    ["it changed since it was read", row({ rowVersion: "v2" })],
  ])("does nothing when %s", async (_label, current) => {
    store.getEscalationRow.mockResolvedValue(current);
    expect(await moveEscalation(conn, args({ detail: { rowVersion: "v1" }, itemId: "40" }))).toBe(false);
    expect(store.updateEscalation).not.toHaveBeenCalled();
  });

  it("does nothing when it is gone", async () => {
    store.getEscalationRow.mockResolvedValue(null);
    expect(await moveEscalation(conn, args({ itemId: "40" }))).toBe(false);
  });
});

describe("moveEmail", () => {
  const columns = (over = {}) => ({ assignedAt: true, assignedBy: true, assignedToUserId: true, assignmentReason: true, ...over });

  it("reassigns through the assignment column, stamping who and why, predicated on it still being theirs and unfiled", async () => {
    emails.probeEmailColumns.mockResolvedValue(columns());
    db.executeQuery.mockResolvedValueOnce([{ EmailID: 77 }]);
    expect(await moveEmail(conn, args({ itemId: "77" }))).toBe(true);
    expect(sqls()[0]).toContain("SET AssignedToUserId = @To, AssignedAt = SYSUTCDATETIME(), AssignedBy = @By, AssignmentReason = @Reason");
    expect(sqls()[0]).toContain("WHERE EmailID = @Id AND AssignedToUserId = @From AND Status NOT IN (N'promoted', N'archived')");
  });

  it("only stamps the columns that exist", async () => {
    emails.probeEmailColumns.mockResolvedValue(columns({ assignedAt: false, assignedBy: false, assignmentReason: false }));
    db.executeQuery.mockResolvedValueOnce([{ EmailID: 77 }]);
    await moveEmail(conn, args({ itemId: "77" }));
    expect(sqls()[0]).toContain("SET AssignedToUserId = @To\n");
    expect(sqls()[0]).not.toContain("AssignedAt");
  });

  it("does nothing where the column does not exist, or the email moved", async () => {
    emails.probeEmailColumns.mockResolvedValue(columns({ assignedToUserId: false }));
    expect(await moveEmail(conn, args({ itemId: "77" }))).toBe(false);
    expect(db.executeQuery).not.toHaveBeenCalled();
    emails.probeEmailColumns.mockResolvedValue(columns());
    db.executeQuery.mockResolvedValueOnce([]);
    expect(await moveEmail(conn, args({ itemId: "77" }))).toBe(false);
  });
});
