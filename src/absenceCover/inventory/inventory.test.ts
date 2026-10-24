/// <reference types="jest" />
import "../../escalation/adapters";
import { FACTS, TODAY, absent } from "../../__tests__/fixtures/absenceCover";
import { NO_HOLIDAYS } from "../../escalation/businessTime";
import { loadApprovalItems } from "./approvals";
import { loadDecisionItems } from "./decisions";
import { loadEmailItems, probeEmailColumns, type EmailColumns } from "./emails";
import { loadEscalationItems } from "./escalations";
import { loadJobItems } from "./jobs";
import { loadLeaveApprovalItems } from "./leaveApprovals";
import type { InventoryContext } from "./context";

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));
const db = jest.requireMock("../../db") as { executeQuery: jest.Mock };
const conn = {} as never;

type Row = Record<string, unknown>;
const answer = (...handlers: [RegExp, Row[]][]) =>
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => handlers.find(([pattern]) => pattern.test(sql))?.[1] ?? []);
const lastSql = (): string => String(db.executeQuery.mock.calls.at(-1)?.[1]);
const lastParams = (): { name: string; value: unknown }[] => db.executeQuery.mock.calls.at(-1)?.[2] ?? [];

const NOW = new Date("2026-10-26T03:00:00Z");
const context: InventoryContext = { facts: FACTS, holidays: NO_HOLIDAYS, now: NOW, today: TODAY };

beforeEach(() => db.executeQuery.mockReset());

describe("jobs", () => {
  const job = (over: Row = {}): Row => ({
    AcknowledgedAt: null, AssignedTo: "Fay Facilities", AssignedToUserID: 1, BuildingName: "Tower A", CreatedAt: new Date("2026-10-20T00:00:00Z"),
    JobID: 12, Priority: "Normal", StatusSince: new Date("2026-10-21T00:00:00Z"), Title: "Leaking roof", ...over,
  });

  it("selects exactly the absent people's open, real, assigned jobs", async () => {
    answer([/FROM dbo\.Jobs/, [job()]]);
    await loadJobItems(conn, [1, 7]);
    expect(lastSql()).toContain("j.AssignedToUserID IN (@U0, @U1)");
    expect(lastSql()).toContain("j.IsTest = 0");
    expect(lastSql()).toContain("j.IsArchived = 0");
    expect(lastSql()).toContain("j.Status <> N'Done'");
    expect(lastParams().map((param) => param.value)).toEqual([1, 7]);
  });

  it("asks nothing for nobody", async () => {
    expect(await loadJobItems(conn, [])).toEqual([]);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("is due when it would go stale: the later clock start plus the priority threshold", async () => {
    answer([/FROM dbo\.Jobs/, [job(), job({ AcknowledgedAt: new Date("2026-10-22T00:00:00Z"), JobID: 13, Priority: "Critical" })]]);
    const [normal, critical] = await loadJobItems(conn, [1]);
    expect(normal.dueAt?.toISOString()).toBe("2026-10-28T00:00:00.000Z"); // status change 21 Oct + 7 days
    expect(critical.dueAt?.toISOString()).toBe("2026-10-24T00:00:00.000Z"); // acknowledged 22 Oct + 2 days
    expect(critical).toMatchObject({ capability: "editJobs", importance: "high", move: "job_assignee", ownerUserId: 1, type: "job" });
    expect(normal).toMatchObject({ importance: "medium", label: "Job #12 · Leaking roof · Tower A", deepLink: "/jobs?jobId=12" });
  });

  it("rates a low priority job low", async () => {
    answer([/FROM dbo\.Jobs/, [job({ Priority: "Low" })]]);
    expect((await loadJobItems(conn, [1]))[0].importance).toBe("low");
  });
});

describe("decision requests", () => {
  const request = (over: Row = {}): Row => ({
    AssignmentMode: "named", AutoEscalate: 1, BuildingName: "Tower A", DecisionMakers: JSON.stringify({ role: null, userIds: [1] }), JobId: 12,
    Question: "Can we go ahead with the roof?", RequestId: 5, RequestedAt: new Date("2026-10-20T00:00:00Z"), RequestedBy: "Dee", RequestedByUserId: 4,
    RespondBy: new Date("2026-10-28T00:00:00Z"), RowVersion: Buffer.from("abc"), State: "pending", Tier: "soon", Title: "Leaking roof", ...over,
  });

  it("selects only pending named requests on real, open jobs", async () => {
    answer([/JobDecisionRequests/, []]);
    await loadDecisionItems(conn, new Set([1]));
    expect(lastSql()).toContain("r.State = N'pending' AND r.AssignmentMode = N'named'");
    expect(lastSql()).toContain("j.IsTest = 0");
  });

  it("is an item when every person asked is away, with its tier, deadline and asker", async () => {
    answer([/JobDecisionRequests/, [request({ Tier: "urgent" })]]);
    const [decision] = await loadDecisionItems(conn, new Set([1]));
    expect(decision).toMatchObject({
      capability: "respondToDecision", id: "5", importance: "high", move: "decision_makers", ownerUserId: 1, raisedByUserId: 4, type: "decision_request",
    });
    expect(decision.dueAt?.toISOString()).toBe("2026-10-28T00:00:00.000Z");
    expect(decision.detail).toMatchObject({ jobId: 12, requestId: 5 });
    expect(decision.label).toContain("Can we go ahead with the roof?");
  });

  it("is not at risk while one of the people asked is in", async () => {
    answer([/JobDecisionRequests/, [request({ DecisionMakers: JSON.stringify({ role: null, userIds: [1, 3] }) })]]);
    expect(await loadDecisionItems(conn, new Set([1]))).toEqual([]);
  });

  it("counts an emergency, which has no deadline, as due when it was asked", async () => {
    answer([/JobDecisionRequests/, [request({ RespondBy: null, Tier: "emergency" })]]);
    expect((await loadDecisionItems(conn, new Set([1])))[0].dueAt?.toISOString()).toBe("2026-10-20T00:00:00.000Z");
  });

  it("shortens a long question", async () => {
    answer([/JobDecisionRequests/, [request({ Question: "x".repeat(200) })]]);
    expect((await loadDecisionItems(conn, new Set([1])))[0].label).toContain(`${"x".repeat(80)}...`);
  });
});

describe("escalations", () => {
  const escalation = (over: Row = {}): Row => ({
    CreatedAt: NOW, DueAt: new Date("2026-10-27T00:00:00Z"), EscalationId: 40, Kind: "attention", Level: 1, NoIndependentTarget: 0, NotificationAttempts: 0,
    NotificationState: "sent", PolicyKey: "job.stalled_unacknowledged", RaisedByKind: "system", RaisedByName: "Floorplan", RaisedByUserId: null,
    RowVersion: Buffer.from("v1"), Status: "open", SubjectId: "12", SubjectType: "job", Summary: "Job #12 · Leaking roof", TargetRole: "facilities", TargetUserId: 1,
    UpdatedAt: NOW, Urgent: 0, ...over,
  });

  it("leaves out decision requests, next steps, attribution notices and its own notices, and test records", async () => {
    answer([/dbo\.Escalations/, []]);
    await loadEscalationItems(conn, [1]);
    const params = lastParams();
    expect(params.filter((param) => param.name.startsWith("P")).map((param) => param.value)).toEqual([
      "job.decision_pending", "job.next_step", "quote.attribution_notice", "po.variance_notice", "cover.moved",
    ]);
    expect(params).toContainEqual(expect.objectContaining({ name: "ShowTest", value: 0 }));
    expect(lastSql()).toContain("e.TargetUserId IN (@U0)");
    expect(lastSql()).toContain("e.Status IN (N'open', N'acknowledged')");
  });

  it("maps an attention escalation to an item the cover needs inbox access for", async () => {
    answer([/dbo\.Escalations/, [escalation()]]);
    const [row] = await loadEscalationItems(conn, [1]);
    expect(row).toMatchObject({
      capability: "viewEscalations", detail: { escalationId: 40 }, id: "40", importance: "medium", label: "Job #12 · Leaking roof", minRole: null, move: "escalation_retarget", ownerUserId: 1, type: "escalation",
    });
    expect(row.dueAt?.toISOString()).toBe("2026-10-27T00:00:00.000Z");
    expect(row.deepLink).toContain("/jobs?jobId=12");
  });

  it("holds an authority escalation to its target role and rates level 2 high", async () => {
    answer([/dbo\.Escalations/, [escalation({ Kind: "authority", Level: 2, PolicyKey: "lease.renewal", TargetRole: "director" })]]);
    const [row] = await loadEscalationItems(conn, [1]);
    expect(row).toMatchObject({ capability: null, importance: "high", importanceCode: "lease_deadline", minRole: "director" });
  });

  it("does not trust a user raiser it cannot name: a system raiser is nobody's SoD", async () => {
    answer([/dbo\.Escalations/, [escalation(), escalation({ EscalationId: 41, RaisedByKind: "user", RaisedByUserId: 4 })]]);
    const rows = await loadEscalationItems(conn, [1]);
    expect(rows.map((row) => row.raisedByUserId)).toEqual([null, 4]);
  });
});

describe("approvals", () => {
  const quote = (over: Row = {}): Row => ({
    Amount: 5000, BuildingID: 3, BuildingName: "Tower A", ContractorName: "Acme", CreatedAt: new Date("2026-10-26T00:00:00Z"), CreatedBy: "Fay Facilities",
    JobID: 12, QuoteID: 9, QuoteNumber: "Q-9", Title: "Leaking roof", ...over,
  });
  const manager = absent({ name: "Max Manager", role: "facilities_manager", userId: 2 });

  it("selects only quotes awaiting approval or a director, on real open jobs", async () => {
    answer([/dbo\.Quotes/, []]);
    await loadApprovalItems(conn, [manager], context);
    expect(lastSql()).toContain("q.Status IN (N'awaiting_approval', N'awaiting_director')");
    expect(lastSql()).toContain("q.IsTest = 0 AND j.IsTest = 0 AND j.IsArchived = 0");
  });

  it("is an item for an absent person the approval core says may approve it, due 16 business hours after it was added", async () => {
    answer([/dbo\.Quotes/, [quote()]]);
    const [row] = await loadApprovalItems(conn, [manager], context);
    expect(row).toMatchObject({ capability: null, id: "9", move: "notice", ownerUserId: 2, type: "approval", importance: "medium" });
    expect(row.money).toEqual({ amount: 5000, buildingId: 3, createdByName: "Fay Facilities", subject: "quote" });
    expect(row.dueAt?.toISOString()).toBe("2026-10-27T07:30:00.000Z"); // 16 business hours after Mon 26 Oct 09:30 Darwin: Tue 17:00
    expect(row.label).toContain("Quote Q-9 from Acme awaiting approval");
  });

  it("is not an item for someone whose authority does not reach the amount", async () => {
    answer([/dbo\.Quotes/, [quote({ Amount: 15_000 })]]);
    expect(await loadApprovalItems(conn, [manager], context)).toEqual([]);
  });

  it("is not an item for a role that cannot approve quotes at all", async () => {
    answer([/dbo\.Quotes/, [quote({ Amount: 100 })]]);
    expect(await loadApprovalItems(conn, [absent({ role: "facilities", userId: 1 })], context)).toEqual([]);
  });

  it("rates an unknown amount high, as only a director can approve it", async () => {
    answer([/dbo\.Quotes/, [quote({ Amount: null })]]);
    const items = await loadApprovalItems(conn, [absent({ name: "Dee", role: "director", userId: 4 })], context);
    expect(items[0]).toMatchObject({ importance: "high", importanceCode: "money" });
  });

  it("finds nothing without approval facts or without anyone away", async () => {
    expect(await loadApprovalItems(conn, [manager], { ...context, facts: null })).toEqual([]);
    expect(await loadApprovalItems(conn, [], context)).toEqual([]);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("emails", () => {
  const columns = (over: Partial<EmailColumns> = {}): EmailColumns => ({ assignedAt: true, assignedBy: true, assignedToUserId: true, assignmentReason: true, ...over });

  it("finds nothing, and asks nothing, where the assignment column is not on this database yet", async () => {
    expect(await loadEmailItems(conn, [1], columns({ assignedToUserId: false }), context)).toEqual([]);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("detects which assignment columns exist", async () => {
    answer([/COL_LENGTH/, [{ HasAssignedAt: null, HasAssignedBy: 10, HasAssignedTo: 4, HasReason: null }]]);
    expect(await probeEmailColumns(conn)).toEqual({ assignedAt: false, assignedBy: true, assignedToUserId: true, assignmentReason: false });
    answer([/COL_LENGTH/, [{ HasAssignedAt: null, HasAssignedBy: null, HasAssignedTo: null, HasReason: null }]]);
    expect((await probeEmailColumns(conn)).assignedToUserId).toBe(false);
  });

  it("selects unfiled, real emails assigned to the absent person, due a business day after they arrived", async () => {
    answer([/dbo\.Emails/, [{ AssignedToUserId: 1, EmailID: 77, FromAddress: "tenant@example.com", ReceivedAt: new Date("2026-10-26T00:00:00Z"), Subject: "Leak in the lobby" }]]);
    const [row] = await loadEmailItems(conn, [1], columns(), context);
    expect(lastSql()).toContain("e.IsTest = 0 AND e.Status NOT IN (N'promoted', N'archived')");
    expect(row).toMatchObject({ capability: "promoteEmail", id: "77", importance: "medium", move: "email_assignee", ownerUserId: 1, type: "email" });
    expect(row.label).toBe("Email from tenant@example.com: Leak in the lobby");
    expect(row.dueAt?.toISOString()).toBe("2026-10-26T23:30:00.000Z"); // Tue 09:00 in Darwin
  });
});

describe("leave approvals", () => {
  const staff = [
    { id: 1, name: "Fay Facilities", oid: "a", role: "facilities" },
    { id: 2, name: "Max Manager", oid: "b", role: "facilities_manager" },
    { id: 4, name: "Dee Director", oid: "d", role: "director" },
    { id: 5, name: "Cam Cfo", oid: "e", role: "cfo" },
  ];
  const pending = [{ EndDate: "2026-11-13", Kind: "annual_leave", RequestId: 3, StartDate: "2026-11-09", UserId: 1 }];

  it("lists a request whose every approver is away, due before the leave starts", async () => {
    answer([/dbo\.LeaveRequests/, pending]);
    const [row] = await loadLeaveApprovalItems(conn, new Set([2, 4, 5]), staff, []);
    expect(row).toMatchObject({ id: "3", move: "none", raisedByUserId: 1, type: "leave_approval" });
    expect(row.label).toBe("Fay Facilities's leave from 09/11/2026 to 13/11/2026 is waiting to be approved");
    expect(row.dueAt?.toISOString()).toBe("2026-11-08T23:00:00.000Z"); // 08:30 in Darwin on 9 Nov
  });

  it("is not at risk while any approver is in", async () => {
    answer([/dbo\.LeaveRequests/, pending]);
    expect(await loadLeaveApprovalItems(conn, new Set([2]), staff, [])).toEqual([]);
  });

  it("follows the reporting line: only the named manager counts", async () => {
    answer([/dbo\.LeaveRequests/, pending]);
    const items = await loadLeaveApprovalItems(conn, new Set([2]), staff, [{ managerId: 2, userId: 1 }]);
    expect(items).toHaveLength(1);
    expect(items[0].onlyIf?.({ email: null, name: "Dee", role: "director", userId: 4 })).toBe(true);
    expect(items[0].onlyIf?.({ email: null, name: "Una", role: "user", userId: 10 })).toBe(false);
  });

  it("asks nothing for nobody away", async () => {
    expect(await loadLeaveApprovalItems(conn, new Set(), staff, [])).toEqual([]);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});
