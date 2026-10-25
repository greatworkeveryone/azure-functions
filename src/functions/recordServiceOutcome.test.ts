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
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "s@rp.com", name: "Simone", oid: "oid-s" }),
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


import { recordServiceOutcome } from "./recordServiceOutcome";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";
import { at, callsMatching, errorOf, paramsOf, post, routeQueries, scheduleRow, type Route } from "../__tests__/fixtures/facilitiesHarness";

const auth = require("../auth") as { extractToken: jest.Mock; requireRole: jest.Mock };
const db = require("../db") as { commitTransaction: jest.Mock; executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const context = new InvocationContext();
const BY_ID = /FROM dbo\.ServiceSchedules s(?: WITH \(UPDLOCK, ROWLOCK\))?\s+LEFT JOIN[\s\S]*WHERE s\.ServiceScheduleId = @Id/;
const RUN_FOR_DUE = /FROM dbo\.ServiceScheduleRuns r\s+LEFT JOIN dbo\.Jobs j[\s\S]*r\.DueDate = @DueDate/;
const INSERT_RUN = /INSERT INTO dbo\.ServiceScheduleRuns/;
const UPDATE_RUN = /UPDATE dbo\.ServiceScheduleRuns/;
const ADVANCE = /UPDATE dbo\.ServiceSchedules/;
const DUE = "2026-04-28";

function routes(extra: Route[] = []): Route[] {
  return [
    ...extra,
    { match: BY_ID, rows: [scheduleRow({ NextDue: at("2026-04-28") })] },
    { match: ADVANCE, rows: [{ ServiceScheduleId: 21 }] },
    { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 9 }] },
  ];
}

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  routeQueries(db.executeQuery, routes());
  jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"], now: new Date("2026-10-14T01:00:00Z") });
});

afterEach(() => jest.useRealTimers());

it("marks the overdue service done without a Floorplan job, moves the schedule on, and ledgers it (UX review E4)", async () => {
  const response = await recordServiceOutcome(post({ dueDate: DUE, outcome: "serviced", reason: "Done by the contractor's own visit", serviceScheduleId: 21, servicedOn: "2026-10-03" }), context);
  expect(response.status).toBe(200);
  expect(paramsOf(callsMatching(db.executeQuery, INSERT_RUN)[0])).toMatchObject({ DueDate: "2026-04-28", JobId: null, Note: "Done by the contractor's own visit", Outcome: "recorded" });
  expect(paramsOf(callsMatching(db.executeQuery, ADVANCE)[0])).toMatchObject({ Due: "2026-04-28", Next: "2026-10-28", UpdatedBy: "Simone" });
  expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "service_schedule.mark_serviced", subjectId: "21" });
  expect(db.commitTransaction).toHaveBeenCalled();
});

it("skips this due date with a reason, ledgered as an exception", async () => {
  const response = await recordServiceOutcome(post({ dueDate: DUE, outcome: "skipped", reason: "Building closed for refurbishment", serviceScheduleId: 21 }), context);
  expect(response.status).toBe(200);
  expect(paramsOf(callsMatching(db.executeQuery, INSERT_RUN)[0])).toMatchObject({ Note: "Building closed for refurbishment", Outcome: "skipped" });
  expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "service_schedule.skip_due", isException: true, reason: "Building closed for refurbishment" });
});

it("refuses while a job for this due date is still open: finish the job instead", async () => {
  routeQueries(db.executeQuery, routes([{ match: RUN_FOR_DUE, rows: [{ JobArchived: false, JobId: 500, JobStatus: "Work", ServiceScheduleRunId: 7 }] }]));
  const response = await recordServiceOutcome(post({ dueDate: DUE, outcome: "serviced", serviceScheduleId: 21 }), context);
  expect(response.status).toBe(409);
  expect(errorOf(response)).toBe("Job #500 is still open for this due date. Finish or archive it first.");
  expect(response.jsonBody).not.toHaveProperty("code");
  expect(callsMatching(db.executeQuery, ADVANCE)).toHaveLength(0);
});

it("closes out an archived job's due date by updating its run, not adding a second", async () => {
  routeQueries(db.executeQuery, routes([{ match: RUN_FOR_DUE, rows: [{ JobArchived: true, JobId: 500, JobStatus: "New", ServiceScheduleRunId: 7 }] }]));
  await recordServiceOutcome(post({ dueDate: DUE, outcome: "skipped", reason: "Job raised by mistake", serviceScheduleId: 21 }), context);
  expect(callsMatching(db.executeQuery, INSERT_RUN)).toHaveLength(0);
  expect(paramsOf(callsMatching(db.executeQuery, UPDATE_RUN)[0])).toMatchObject({ Note: "Job raised by mistake", RunId: 7 });
});

it.each([
  [{ dueDate: DUE, outcome: "maybe", serviceScheduleId: 21 }, /outcome/],
  [{ dueDate: DUE, outcome: "skipped", serviceScheduleId: 21 }, /reason/],
  [{ dueDate: DUE, outcome: "serviced", serviceScheduleId: 21, servicedOn: "2026-12-01" }, /after today/],
  [{ dueDate: DUE, outcome: "serviced" }, /serviceScheduleId/],
  [{ outcome: "serviced", serviceScheduleId: 21 }, /dueDate is required/],
  [{ dueDate: "28/04/2026", outcome: "serviced", serviceScheduleId: 21 }, /dueDate must be a date/],
  [{ dueDate: "2026-02-30", outcome: "serviced", serviceScheduleId: 21 }, /dueDate must be a date/],
])("400 for %j", async (body, message) => {
  const response = await recordServiceOutcome(post(body), context);
  expect(response.status).toBe(400);
  expect(errorOf(response)).toMatch(message);
});

it("managers only; 404 for an unknown schedule; 409 for an archived one", async () => {
  auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
  expect((await recordServiceOutcome(post({ dueDate: DUE, outcome: "serviced", serviceScheduleId: 21 }), context)).status).toBe(403);
  routeQueries(db.executeQuery, [{ match: BY_ID, rows: [] }]);
  expect((await recordServiceOutcome(post({ dueDate: DUE, outcome: "serviced", serviceScheduleId: 21 }), context)).status).toBe(404);
  routeQueries(db.executeQuery, [{ match: BY_ID, rows: [scheduleRow({ ArchivedAt: at("2026-10-01") })] }]);
  expect((await recordServiceOutcome(post({ dueDate: DUE, outcome: "serviced", serviceScheduleId: 21 }), context)).status).toBe(409);
});

// Review F2 finding 4: the request didn't say which due date it closes, so when two people cleared the
// same overdue email the second silently recorded (or skipped) the NEXT real service.
it("refuses, and records nothing, when the due date shown is no longer the schedule's next one", async () => {
  routeQueries(db.executeQuery, routes([{ match: BY_ID, rows: [scheduleRow({ NextDue: at("2026-10-28"), UpdatedBy: "Adam" })] }]));
  const response = await recordServiceOutcome(post({ dueDate: DUE, outcome: "serviced", serviceScheduleId: 21 }), context);
  expect(response.status).toBe(409);
  expect(response.jsonBody).toEqual({
    code: "moved_on",
    error: "This schedule has moved on since you opened it: it is now due 28/10/2026 (last changed by Adam). Nothing was recorded. Reload to see it.",
  });
  for (const write of [INSERT_RUN, UPDATE_RUN, ADVANCE]) expect(callsMatching(db.executeQuery, write)).toHaveLength(0);
  expect(ledgerInserts(db.executeQuery)).toHaveLength(0);
  expect(db.commitTransaction).not.toHaveBeenCalled();
});

it("a second person clearing the same due date records nothing, even for a skip", async () => {
  const body = { dueDate: DUE, outcome: "skipped", reason: "Building closed", serviceScheduleId: 21 };
  expect((await recordServiceOutcome(post(body), context)).status).toBe(200);
  routeQueries(db.executeQuery, routes([{ match: BY_ID, rows: [scheduleRow({ NextDue: at("2026-10-28"), UpdatedBy: "Simone" })] }]));
  jest.clearAllMocks();
  expect((await recordServiceOutcome(post(body), context)).status).toBe(409);
  expect(callsMatching(db.executeQuery, INSERT_RUN)).toHaveLength(0);
});
