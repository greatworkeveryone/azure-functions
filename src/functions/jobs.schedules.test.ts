/// <reference types="jest" />
import { InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Error" }, status: 500 }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    rolesForRequest: jest.fn().mockResolvedValue(["facilities_manager"]),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "a@rp.com", name: "Adam", oid: "oid-a" }),
  };
});
jest.mock("../db", () => {
  const actual = jest.requireActual("../db");
  return {
    ...actual,
    beginTransaction: jest.fn().mockResolvedValue(undefined),
    closeConnection: jest.fn(),
    commitTransaction: jest.fn().mockResolvedValue(undefined),
    createRequestConnection: jest.fn().mockResolvedValue({}),
    executeQuery: jest.fn().mockResolvedValue([]),
    rollbackTransaction: jest.fn().mockResolvedValue(undefined),
  };
});
jest.mock("../escalation/criticalJob", () => ({ raiseCriticalJobEscalation: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../jobPlannerSync", () => ({ syncJobActionTriggersStandalone: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../pdf/job-packet", () => ({ buildJobPacket: jest.fn() }));
jest.mock("../pdf/job-packet-loader", () => ({ loadJobPacketInputs: jest.fn() }));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn() }));

import { addJobEvent } from "./jobs";
import { at, callsMatching, paramsOf, post, routeQueries } from "../__tests__/fixtures/facilitiesHarness";
import { isWorkCompletion } from "../serviceScheduleRuns";

const db = require("../db") as { commitTransaction: jest.Mock; executeQuery: jest.Mock };
const context = new InvocationContext();
const CURRENT = /SELECT Status, AwaitingRole, PreBlockStatus, PreBlockAwaitingRole, IsContract, IsInternal FROM Jobs/;
const RUN_FOR_JOB = /FROM dbo\.ServiceScheduleRuns r\s+JOIN dbo\.ServiceSchedules s[\s\S]*WHERE r\.JobId = @JobId/;
const STAMP_RUN = /UPDATE dbo\.ServiceScheduleRuns SET CompletedAt/;
const ADVANCE = /UPDATE dbo\.ServiceSchedules/;

const run = (overrides: Record<string, unknown> = {}) => ({
  AnchorDate: at("2026-01-31"),
  CompletedAt: null,
  DueDate: at("2026-10-31"),
  IntervalCount: 1,
  IntervalUnit: "months",
  NextDue: at("2026-10-31"),
  ServiceScheduleId: 21,
  ServiceScheduleRunId: 7,
  ...overrides,
});

function given(current: Record<string, unknown>, runs: Record<string, unknown>[]) {
  routeQueries(db.executeQuery, [
    { match: CURRENT, rows: [{ AwaitingRole: "facilities", IsContract: true, IsInternal: false, PreBlockAwaitingRole: null, PreBlockStatus: null, ...current }] },
    { match: RUN_FOR_JOB, rows: runs },
    { match: ADVANCE, rows: [{ ServiceScheduleId: 21 }] },
    { match: /INSERT INTO JobEvents/, rows: [{ JobEventID: 1 }] },
    { match: /FROM JobEvents|FROM Jobs WHERE JobID/, rows: [] },
  ]);
}

beforeEach(() => jest.clearAllMocks());

it("treats on-to-invoice-approval and Done as the work being completed", () => {
  expect(isWorkCompletion("Awaiting Approval", "accounts")).toBe(true);
  expect(isWorkCompletion("Done", "facilities")).toBe(true);
  expect(isWorkCompletion("Awaiting Approval", "facilities")).toBe(false);
  expect(isWorkCompletion("Work", "facilities")).toBe(false);
});

it("completing a scheduled job's work stamps its run and moves the schedule on from the due date, not today", async () => {
  given({ Status: "Work" }, [run()]);
  const response = await addJobEvent(post({ JobID: 500, NewStatus: "Awaiting Approval", Text: "Serviced" }), context);
  expect(response.status).toBe(200);
  expect(paramsOf(callsMatching(db.executeQuery, STAMP_RUN)[0])).toEqual({ RunId: 7 });
  // 31 Jan anchor, monthly: after 31 Oct comes 30 Nov (from the anchor, clamped).
  expect(paramsOf(callsMatching(db.executeQuery, ADVANCE)[0])).toMatchObject({ Due: "2026-10-31", Id: 21, JobId: 500, Next: "2026-11-30" });
  expect(db.commitTransaction).toHaveBeenCalledTimes(1);
});

it("does not move a schedule that has already moved on (idempotent)", async () => {
  given({ Status: "Work" }, [run({ CompletedAt: at("2026-10-30"), NextDue: at("2026-11-30") })]);
  await addJobEvent(post({ JobID: 500, NewStatus: "Awaiting Approval" }), context);
  expect(callsMatching(db.executeQuery, STAMP_RUN)).toHaveLength(0);
  expect(callsMatching(db.executeQuery, ADVANCE)).toHaveLength(0);
});

it("leaves jobs that didn't come from a schedule alone", async () => {
  given({ Status: "Work" }, []);
  await addJobEvent(post({ JobID: 600, NewStatus: "Awaiting Approval" }), context);
  expect(callsMatching(db.executeQuery, ADVANCE)).toHaveLength(0);
});

it("doesn't look for a schedule on transitions that aren't completions", async () => {
  given({ Status: "New" }, [run()]);
  await addJobEvent(post({ JobID: 500, NewStatus: "Work" }), context);
  expect(callsMatching(db.executeQuery, RUN_FOR_JOB)).toHaveLength(0);
});
