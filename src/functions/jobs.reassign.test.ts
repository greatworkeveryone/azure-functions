/// <reference types="jest" />
// UXA-09: giving a job to a different person tells them and starts the stall clock again; re-sending the same
// person does neither, and a failed email never undoes the save.
import type { HttpRequest, InvocationContext } from "@azure/functions";

export {};

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn(),
    rolesForRequest: jest.fn(),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn(),
  };
});
jest.mock("../graph", () => ({ graphSendMail: jest.fn() }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../jobPlannerSync", () => ({ syncJobActionTriggersStandalone: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../escalation/criticalJob", () => ({ raiseCriticalJobEscalation: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn().mockResolvedValue([]) }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

import { upsertJob } from "./jobs";
import { reassignmentEmail } from "../jobReassignmentNotice";
import { callsMatching, post, routeQueries } from "../__tests__/fixtures/facilitiesHarness";

const auth = require("../auth") as { requireRole: jest.Mock; rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock; createRequestConnection: jest.Mock; executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const graph = require("../graph") as { graphSendMail: jest.Mock };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const UPDATE_JOB = /UPDATE Jobs SET/;
const PREVIOUS = /SELECT Status, AssignedTo, Kind, IsContract, IsInternal, Priority, AssignedToUserID,[\s\S]*FROM Jobs WITH \(UPDLOCK, HOLDLOCK\) WHERE JobID = @JobID/;

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  delete process.env.DEV_EMAIL_OVERRIDE;
  process.env.APP_BASE_URL = "https://floorplan.example";
  auth.requireRole.mockResolvedValue(null);
  auth.rolesForRequest.mockResolvedValue(["facilities_manager"]);
  auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "fiona@example.com", name: "Fiona", oid: "oid-fiona" });
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  db.createRequestConnection.mockResolvedValue({});
  graph.graphSendMail.mockResolvedValue(undefined);
  given({});
});

function given(previous: Record<string, unknown>, owner: Record<string, unknown> = { Email: "terry@example.com", EntraOid: "oid-terry", IsTest: 0, Title: "Leaking tap" }) {
  routeQueries(db.executeQuery, [
    { match: PREVIOUS, rows: [{ AssignedTo: "Sam", AssignedToUserID: 5, HasMoneyRecords: 0, IsContract: false, IsInternal: false, Kind: "facilities", Priority: "Normal", Status: "Work", ...previous }] },
    { match: UPDATE_JOB, rows: [{ JobID: 9 }] },
    { match: /FROM dbo\.AppUsers WHERE UserID = @UserID AND IsActive = 1 AND EntraOid IS NOT NULL/, rows: [{ Hit: 1 }] },
    { match: /FROM dbo\.AppUsers u\s+JOIN dbo\.Jobs j/, rows: [owner] },
  ]);
}
const update = (body: Record<string, unknown>) => upsertJob(post({ JobID: 9, ...body }) as HttpRequest, ctx);

describe("reassigning a job", () => {
  it("starts the stall clock again and clears the old owner's acknowledgement", async () => {
    await update({ AssignedTo: "Terry", AssignedToUserID: 8 });
    const sql = callsMatching(db.executeQuery, UPDATE_JOB)[0][1];
    expect(sql).toContain("StatusSince=SYSUTCDATETIME()");
    expect(sql).toContain("AcknowledgedAt=NULL");
    expect(sql).toContain("EscalatedAt=NULL");
  });

  it("emails the new owner once, saying who gave it and who had it", async () => {
    const response = await update({ AssignedTo: "Terry", AssignedToUserID: 8 });
    expect(response.status).toBe(200);
    expect(graph.graphSendMail).toHaveBeenCalledTimes(1);
    const [egress, to, subject, body] = graph.graphSendMail.mock.calls[0];
    expect(egress).toEqual({ isTest: false });
    expect(to).toEqual(["terry@example.com"]);
    expect(subject).toBe("Job #9 was reassigned to you");
    expect(body).toContain("Fiona gave you job #9: Leaking tap. It was with Sam.");
    expect(body).toContain("https://floorplan.example/jobs?jobId=9");
  });

  it("does neither when the same person is sent again", async () => {
    await update({ AssignedTo: "Sam", AssignedToUserID: 5 });
    expect(callsMatching(db.executeQuery, UPDATE_JOB)[0][1]).not.toContain("StatusSince");
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("restarts the clock but sends nothing when a person takes the job themselves", async () => {
    given({}, { Email: "fiona@example.com", EntraOid: "oid-fiona", IsTest: 0, Title: "Leaking tap" });
    await update({ AssignedTo: "Fiona", AssignedToUserID: 3 });
    expect(callsMatching(db.executeQuery, UPDATE_JOB)[0][1]).toContain("StatusSince=SYSUTCDATETIME()");
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });

  it("does not undo the save when the email fails", async () => {
    graph.graphSendMail.mockRejectedValue(new Error("Graph is down"));
    const response = await update({ AssignedTo: "Terry", AssignedToUserID: 8 });
    expect(response.status).toBe(200);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(ctx.warn).toHaveBeenCalledWith(expect.stringContaining("not sent"));
  });

  it("does not email about an edit that leaves the owner alone", async () => {
    await update({ Title: "Leaking tap, level 2" });
    expect(graph.graphSendMail).not.toHaveBeenCalled();
  });
});

describe("reassignmentEmail", () => {
  it("leaves out who had it when nobody did, and says how to open it", () => {
    const email = reassignmentEmail({ byName: "Fiona", fromName: null, jobId: 4, link: null, title: "Door" });
    expect(email.body).toContain("Fiona gave you job #4: Door.");
    expect(email.body).not.toContain("It was with");
    expect(email.body).toContain("Open Floorplan to see it.");
  });
});
