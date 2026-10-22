import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { executeQuery, rollbackTransaction, commitTransaction } from "../db";
import { loadPeople, peopleAudit } from "../peopleWorkflow";
import { decideLeaveRequest } from "./decideLeaveRequest";
import { getLeaveRequests } from "./getLeaveRequests";
import { createLeaveRequest } from "./createLeaveRequest";
import { saveStaffReporting } from "./saveStaffReporting";
jest.mock("@azure/functions", () => ({
  ...jest.requireActual("@azure/functions"),
  app: { http: jest.fn() },
}));
let actor = "manager",
  roles: string[] = [AppRole.FACILITIES_APPROVAL];
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => "token",
  requireRole: async (_r: unknown, allowed: string[]) =>
    jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 },
  verifiedIdentityFromRequest: async () => ({ name: "Verified actor", oid: actor }),
}));
jest.mock("../rateLimit", () => ({ checkRateLimit: () => ({ allowed: true }) }));
jest.mock("../peopleWorkflow", () => ({ loadPeople: jest.fn(), peopleAudit: jest.fn() }));
jest.mock("../db", () => ({
  createRequestConnection: jest.fn(async () => ({})),
  closeConnection: jest.fn(),
  executeQuery: jest.fn(),
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
const query = jest.mocked(executeQuery),
  load = jest.mocked(loadPeople),
  audit = jest.mocked(peopleAudit),
  context = { error: jest.fn() } as unknown as InvocationContext;
const staff = [
  { id: 1, name: "Staff", role: "facilities", oid: "staff" },
  { id: 2, name: "Manager", role: "facilities_manager", oid: "manager" },
  { id: 3, name: "Other manager", role: "facilities_manager", oid: "other" },
  { id: 4, name: "CFO", role: "cfo", oid: "cfo" },
];
const req = (body: Record<string, unknown> = { id: 9, revision: 1, action: "approve", note: "" }) =>
  new HttpRequest({
    method: "POST",
    url: "http://localhost/api/leave",
    headers: { "Content-Type": "application/json" },
    body: { string: JSON.stringify(body) },
  });
beforeEach(() => {
  jest.clearAllMocks();
  actor = "manager";
  roles = [AppRole.FACILITIES_APPROVAL];
  load.mockResolvedValue({
    staff,
    links: [{ userId: 1, managerId: 2 }],
    revision: 2,
    updatedBy: "CFO",
    updatedAt: null,
  });
  query.mockResolvedValue([{ RequestId: 9, UserId: 1, Status: "pending", Revision: 1 }]);
});
it("refuses self-approval even by a CFO", async () => {
  actor = "cfo";
  roles = [AppRole.CFO];
  query.mockResolvedValue([{ RequestId: 9, UserId: 4, Status: "pending", Revision: 1 }]);
  expect((await decideLeaveRequest(req(), context)).status).toBe(403);
  expect(audit).not.toHaveBeenCalled();
});
it("refuses another manager when a named reporting manager exists", async () => {
  actor = "other";
  expect((await decideLeaveRequest(req(), context)).status).toBe(403);
  expect(audit).not.toHaveBeenCalled();
});
it("detects stale decisions without writing", async () => {
  expect(
    (await decideLeaveRequest(req({ id: 9, revision: 0, action: "approve", note: "" }), context)).status,
  ).toBe(409);
  expect(commitTransaction).not.toHaveBeenCalled();
});
it("rolls back decisions when audit fails", async () => {
  audit.mockRejectedValueOnce(new Error("audit"));
  expect((await decideLeaveRequest(req(), context)).status).toBe(500);
  expect(rollbackTransaction).toHaveBeenCalled();
  expect(commitTransaction).not.toHaveBeenCalled();
});
it("records verified actor and reporting revision with approval", async () => {
  expect((await decideLeaveRequest(req(), context)).status).toBe(200);
  expect(audit).toHaveBeenCalledWith(
    expect.anything(),
    { oid: "manager", name: "Verified actor" },
    "leave",
    9,
    "approve",
    expect.anything(),
    { status: "approved", reportingRevision: 2 },
  );
});
it("filters other employees requests out of the response", async () => {
  actor = "other";
  const result = await getLeaveRequests(req(), context);
  expect(result.status).toBe(200);
  expect((result.jsonBody as any).requests).toEqual([]);
});
it("rejects malformed leave before querying", async () => {
  expect((await createLeaveRequest(req({ hours: 0 }), context)).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});
it("ignores spoofed subject and blocks overlapping requests", async () => {
  actor = "staff";
  expect(
    (
      await createLeaveRequest(
        req({ userId: 999, kind: "annual_leave", startDate: "2026-12-01", endDate: "2026-12-01", hours: 8 }),
        context,
      )
    ).status,
  ).toBe(409);
  expect(query.mock.calls[0][2]).toContainEqual(expect.objectContaining({ name: "User", value: 1 }));
});
it("keeps reporting edits CFO/director/admin only", async () => {
  expect((await saveStaffReporting(req({ links: [], revision: 2 }), context)).status).toBe(403);
  expect(load).not.toHaveBeenCalled();
});
it("requires a reason for declining", async () => {
  expect(
    (await decideLeaveRequest(req({ id: 9, revision: 1, action: "decline", note: "" }), context)).status,
  ).toBe(400);
  expect(query).not.toHaveBeenCalled();
});
it("saves valid reporting with a verified audit and rejects stale revisions", async () => {
  actor = "cfo";
  roles = [AppRole.CFO];
  expect(
    (await saveStaffReporting(req({ links: [{ userId: 1, managerId: 2 }], revision: 1 }), context)).status,
  ).toBe(409);
  expect(audit).not.toHaveBeenCalled();
  expect(
    (await saveStaffReporting(req({ links: [{ userId: 1, managerId: 2 }], revision: 2 }), context)).status,
  ).toBe(200);
  expect(audit).toHaveBeenCalledWith(
    expect.anything(),
    { oid: "cfo", name: "Verified actor" },
    "reporting",
    1,
    "change",
    expect.anything(),
    { links: [{ userId: 1, managerId: 2 }], revision: 3 },
  );
});
it("rolls reporting back when its audit cannot be written", async () => {
  actor = "cfo";
  roles = [AppRole.CFO];
  audit.mockRejectedValueOnce(new Error("audit"));
  expect((await saveStaffReporting(req({ links: [], revision: 2 }), context)).status).toBe(500);
  expect(commitTransaction).not.toHaveBeenCalled();
  expect(rollbackTransaction).toHaveBeenCalled();
});
it("creates a request for the verified owner with the current routing revision", async () => {
  actor = "staff";
  query.mockImplementation(async (_c, sql) =>
    sql.startsWith("INSERT dbo.LeaveRequests") ? [{ RequestId: 10 }] : [],
  );
  expect(
    (
      await createLeaveRequest(
        req({ userId: 999, kind: "annual_leave", startDate: "2026-12-01", endDate: "2026-12-01", hours: 8 }),
        context,
      )
    ).status,
  ).toBe(201);
  expect(audit).toHaveBeenCalledWith(
    expect.anything(),
    { oid: "staff", name: "Verified actor" },
    "leave",
    10,
    "request",
    null,
    expect.objectContaining({ userId: 1, reportingRevision: 2 }),
  );
});
it("allows an owner to withdraw approved leave but forbids a reviewer withdrawing it", async () => {
  query.mockResolvedValue([{ RequestId: 9, UserId: 1, Status: "approved", Revision: 1 }]);
  expect(
    (await decideLeaveRequest(req({ id: 9, revision: 1, action: "withdraw", note: "" }), context)).status,
  ).toBe(403);
  actor = "staff";
  expect(
    (await decideLeaveRequest(req({ id: 9, revision: 1, action: "withdraw", note: "" }), context)).status,
  ).toBe(200);
});
