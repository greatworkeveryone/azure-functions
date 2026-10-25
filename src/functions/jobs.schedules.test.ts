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
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn(), flush: jest.fn() } }));

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
    { match: /UPDATE Jobs SET[\s\S]*OUTPUT INSERTED\.JobID/, rows: [{ JobID: 500 }] },
    { match: /INSERT INTO JobEvents/, rows: [{ JobEventID: 1 }] },
    // D4: addJobEvent first refuses archived jobs; this one is live.
    { match: /SELECT CreatedBy, CreatedById, IsArchived FROM Jobs/, rows: [{ CreatedBy: "Adam", CreatedById: 1, IsArchived: false }] },
    // J2: the transition guard reads the job under lock with its money facts.
    { match: /FROM Jobs j WITH \(UPDLOCK, HOLDLOCK\)/, rows: [{ AwaitingRole: "facilities", HasApprovedQuote: 1, HasMoneyRecords: 0, IsContract: true, IsInternal: false, JobID: 500, PreBlockAwaitingRole: null, PreBlockStatus: null, Status: "Work" }] },
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
  expect(paramsOf(callsMatching(db.executeQuery, ADVANCE)[0])).toMatchObject({ Due: "2026-10-31", Id: 21, JobId: 500, Next: "2026-11-30", UpdatedBy: "Adam (job #500 completed)" });
  expect(db.commitTransaction).toHaveBeenCalledTimes(1);
});

it("does not move a schedule that has already moved on (idempotent)", async () => {
  given({ Status: "Work" }, [run({ CompletedAt: at("2026-10-30"), NextDue: at("2026-11-30") })]);
  expect((await addJobEvent(post({ JobID: 500, NewStatus: "Awaiting Approval" }), context)).status).toBe(200);
  expect(callsMatching(db.executeQuery, RUN_FOR_JOB)).toHaveLength(1);
  expect(callsMatching(db.executeQuery, STAMP_RUN)).toHaveLength(0);
  expect(callsMatching(db.executeQuery, ADVANCE)).toHaveLength(0);
});

it("still completes the job, loudly, on a database without migration 120", async () => {
  given({ Status: "Work" }, []);
  routeQueries(db.executeQuery, [
    { match: CURRENT, rows: [{ AwaitingRole: "facilities", IsContract: true, IsInternal: false, PreBlockAwaitingRole: null, PreBlockStatus: null, Status: "Work" }] },
    { match: RUN_FOR_JOB, throws: new Error("Invalid object name 'dbo.ServiceScheduleRuns'.") },
    { match: /INSERT INTO JobEvents/, rows: [{ JobEventID: 1 }] },
    { match: /SELECT CreatedBy, CreatedById, IsArchived FROM Jobs/, rows: [{ CreatedBy: "Adam", CreatedById: 1, IsArchived: false }] },
    { match: /FROM Jobs j WITH \(UPDLOCK, HOLDLOCK\)/, rows: [{ AwaitingRole: "facilities", HasApprovedQuote: 1, HasMoneyRecords: 0, IsContract: true, IsInternal: false, JobID: 500, PreBlockAwaitingRole: null, PreBlockStatus: null, Status: "Work" }] },
    { match: /UPDATE Jobs SET[\s\S]*OUTPUT INSERTED\.JobID/, rows: [{ JobID: 500 }] },
  ]);
  const response = await addJobEvent(post({ JobID: 500, NewStatus: "Awaiting Approval" }), context);
  expect(response.status).toBe(200);
  expect(db.commitTransaction).toHaveBeenCalledTimes(1);
});

it("leaves jobs that didn't come from a schedule alone", async () => {
  given({ Status: "Work" }, []);
  expect((await addJobEvent(post({ JobID: 600, NewStatus: "Awaiting Approval" }), context)).status).toBe(200);
  expect(callsMatching(db.executeQuery, RUN_FOR_JOB)).toHaveLength(1);
  expect(callsMatching(db.executeQuery, ADVANCE)).toHaveLength(0);
});

it("doesn't look for a schedule on transitions that aren't completions", async () => {
  given({ Status: "New" }, [run()]);
  expect((await addJobEvent(post({ JobID: 500, NewStatus: "Work" }), context)).status).toBe(200);
  expect(callsMatching(db.executeQuery, RUN_FOR_JOB)).toHaveLength(0);
});
