/// <reference types="jest" />
import type { Connection } from "tedious";

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../escalation/engine", () => ({ raise: jest.fn() }));

import { runFacilitiesScheduler } from "../facilitiesScheduler";
import { SCHEDULE_POLICIES } from "../escalation/adapters/serviceSchedule";
import { at, callsMatching, paramsOf, periodRow, routeQueries, scheduleRow, type Route } from "./fixtures/facilitiesHarness";

const db = require("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock; executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const engine = require("../escalation/engine") as { raise: jest.Mock };
const conn = {} as Connection;
const NOW = new Date("2026-10-14T00:00:00Z"); // 09:30 in Darwin

const DUE = /s\.NextDue <= DATEADD\(day, s\.LeadDays, @Today\)/;
const OVERDUE = /s\.Active = 1 AND s\.ArchivedAt IS NULL AND s\.NextDue < @Today/;
const LIVE_PERIODS = /FROM dbo\.DefectsPeriods d[\s\S]*d\.PracticalCompletion <= @Today AND d\.EndsOn >= @Today/;
const INSERT_JOB = /INSERT INTO Jobs/;
const INSERT_RUN = /INSERT INTO dbo\.ServiceScheduleRuns/;
const ADVANCE = /UPDATE dbo\.ServiceSchedules/;
const LINK_ASSET = /INSERT INTO dbo\.JobAssets/;
const EVER_RAISED = /JSON_VALUE\(Context, '\$\.nextDue'\) = @Date/;

function options(dryRun = false, maxActions?: number) {
  return { dryRun, log: jest.fn(), maxActions, now: NOW, warn: jest.fn() };
}

function given(routes: Route[]) {
  routeQueries(db.executeQuery, [...routes, { match: INSERT_JOB, rows: [{ JobID: 500 }] }]);
}

beforeEach(() => {
  jest.clearAllMocks();
  engine.raise.mockResolvedValue({ created: true, escalation: {} });
});

describe("service jobs", () => {
  it("creates the maintenance job lead days before it is due, linked to the asset, with its run row, in one transaction", async () => {
    given([{ match: DUE, rows: [scheduleRow()] }]);
    const report = await runFacilitiesScheduler(conn, options());
    expect(report.schedules).toMatchObject({ considered: 1, created: 1 });
    expect(paramsOf(callsMatching(db.executeQuery, DUE)[0])).toEqual({ Today: "2026-10-14" });
    const job = paramsOf(callsMatching(db.executeQuery, INSERT_JOB)[0]);
    expect(job).toMatchObject({
      BuildingID: 1,
      Category: "HVAC / mechanical",
      CreatedBy: "Floorplan scheduler",
      CreationMethod: "schedule",
      IsContract: true,
      LevelName: "Level 3",
      Title: "Six-monthly chiller service — Chiller 1 (CH-01) — due 28/10/2026",
    });
    expect((job.ExpectedProgressUpdate as Date).toISOString()).toBe("2026-10-28T00:00:00.000Z");
    expect(callsMatching(db.executeQuery, INSERT_JOB)[0][1]).toMatch(/'New', 'facilities', 'maintenance'/);
    expect(paramsOf(callsMatching(db.executeQuery, LINK_ASSET)[0])).toMatchObject({ AssetId: 12, JobId: 500 });
    expect(paramsOf(callsMatching(db.executeQuery, INSERT_RUN)[0])).toMatchObject({ DueDate: "2026-10-28", JobId: 500, Outcome: "job_created", ScheduleId: 21 });
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("leaves a schedule alone until its lead time arrives", async () => {
    given([{ match: DUE, rows: [scheduleRow({ NextDue: at("2026-10-29") })] }]);
    const report = await runFacilitiesScheduler(conn, options());
    expect(report.schedules.considered).toBe(0);
    expect(callsMatching(db.executeQuery, INSERT_JOB)).toHaveLength(0);
  });

  it("names a scope when there is no asset, and links nothing", async () => {
    given([{ match: DUE, rows: [scheduleRow({ AssetId: null, AssetName: null, AssetTag: null, Category: "Fire & life safety", Scope: "All emergency exit lights" })] }]);
    await runFacilitiesScheduler(conn, options());
    expect(paramsOf(callsMatching(db.executeQuery, INSERT_JOB)[0]).Title).toBe("Six-monthly chiller service — All emergency exit lights — due 28/10/2026");
    expect(callsMatching(db.executeQuery, LINK_ASSET)).toHaveLength(0);
  });

  it("skips a due date inside a blocking defects period, says why, and moves to the next occurrence", async () => {
    given([
      { match: DUE, rows: [scheduleRow()] },
      { match: LIVE_PERIODS, rows: [periodRow({ EndsOn: at("2027-06-30"), Works: "Chiller replacement" })] },
    ]);
    const opts = options();
    const report = await runFacilitiesScheduler(conn, opts);
    expect(report.schedules).toMatchObject({ created: 0, skippedDefects: 1 });
    expect(paramsOf(callsMatching(db.executeQuery, LIVE_PERIODS)[0])).toMatchObject({ BuildingId: 1, Today: "2026-10-28" });
    expect(callsMatching(db.executeQuery, INSERT_JOB)).toHaveLength(0);
    expect(paramsOf(callsMatching(db.executeQuery, INSERT_RUN)[0])).toMatchObject({ DefectsPeriodId: 3, JobId: null, Outcome: "skipped_defects" });
    const advance = callsMatching(db.executeQuery, ADVANCE)[0];
    expect(advance[1]).toMatch(/WHERE ServiceScheduleId = @Id AND NextDue = @Due/);
    expect(paramsOf(advance)).toMatchObject({ Due: "2026-10-28", Next: "2027-04-28" });
    expect(opts.log).toHaveBeenCalledWith(expect.stringMatching(/skipped schedule 21 .* inside the Chiller replacement defects period to 30\/06\/2027: Acme Builders owes it; next due 28\/04\/2027/));
  });

  it("still creates the job when the period only warns", async () => {
    given([
      { match: DUE, rows: [scheduleRow()] },
      { match: LIVE_PERIODS, rows: [periodRow({ Enforcement: "warn" })] },
    ]);
    const report = await runFacilitiesScheduler(conn, options());
    expect(report.schedules.created).toBe(1);
  });

  it("writes nothing in a dry run", async () => {
    given([
      { match: DUE, rows: [scheduleRow(), scheduleRow({ ServiceScheduleId: 22 })] },
      { match: OVERDUE, rows: [scheduleRow({ NextDue: at("2026-10-01") })] },
    ]);
    const opts = options(true);
    const report = await runFacilitiesScheduler(conn, opts);
    expect(report.schedules.wouldCreate).toBe(2);
    expect(report.overdue.wouldRaise).toBe(1);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(engine.raise).not.toHaveBeenCalled();
    expect(callsMatching(db.executeQuery, /INSERT|UPDATE/)).toHaveLength(0);
    expect(opts.log).toHaveBeenCalledWith(expect.stringMatching(/would create the job for schedule 21/));
  });

  it("is idempotent: a run row already written for that due date rolls the job back", async () => {
    given([
      { match: DUE, rows: [scheduleRow()] },
      { match: INSERT_RUN, throws: new Error("Cannot insert duplicate key row in object 'dbo.ServiceScheduleRuns' with unique index 'UX_ServiceScheduleRuns_Schedule_Due'.") },
    ]);
    const report = await runFacilitiesScheduler(conn, options());
    expect(report.schedules).toMatchObject({ alreadyDone: 1, created: 0 });
    expect(report.errors).toEqual([]);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("stops at the action cap and says so", async () => {
    given([{ match: DUE, rows: [scheduleRow(), scheduleRow({ ServiceScheduleId: 22 }), scheduleRow({ ServiceScheduleId: 23 })] }]);
    const opts = options(false, 2);
    const report = await runFacilitiesScheduler(conn, opts);
    expect(report.schedules.created).toBe(2);
    expect(report.truncated).toBe(true);
    expect(opts.warn).toHaveBeenCalledWith(expect.stringMatching(/stopped at 2 writes/));
  });
});

describe("overdue servicing", () => {
  it("escalates fire and life safety and lifts as urgent, the rest to the digest", async () => {
    given([
      { match: OVERDUE, rows: [scheduleRow({ Category: "Lifts", NextDue: at("2026-10-01"), ServiceScheduleId: 30 }), scheduleRow({ NextDue: at("2026-10-12"), ServiceScheduleId: 31 })] },
    ]);
    const report = await runFacilitiesScheduler(conn, options());
    expect(engine.raise.mock.calls.map((call) => [call[1].subjectId, call[1].policyKey])).toEqual([
      ["30", SCHEDULE_POLICIES.overdueUrgent],
      ["31", SCHEDULE_POLICIES.overdue],
    ]);
    expect(engine.raise.mock.calls[0][1]).toMatchObject({ context: { nextDue: "2026-10-01" }, headline: "Overdue by 13 days", subjectType: "service_schedule" });
    expect(report.overdue.raised).toBe(2);
  });

  it("raises once per due date, not every morning", async () => {
    given([
      { match: OVERDUE, rows: [scheduleRow({ NextDue: at("2026-10-12") })] },
      { match: EVER_RAISED, rows: [{ EscalationId: 9 }] },
    ]);
    const report = await runFacilitiesScheduler(conn, options());
    expect(engine.raise).not.toHaveBeenCalled();
    expect(report.overdue.skippedAlreadySent).toBe(1);
  });

  it("collects a failed raise and carries on", async () => {
    given([{ match: OVERDUE, rows: [scheduleRow({ NextDue: at("2026-10-12") }), scheduleRow({ NextDue: at("2026-10-12"), ServiceScheduleId: 22 })] }]);
    engine.raise.mockRejectedValueOnce(new Error("policy switched off"));
    const report = await runFacilitiesScheduler(conn, options());
    expect(report.errors).toEqual(["overdue schedule 21: policy switched off"]);
    expect(report.overdue.raised).toBe(1);
  });
});
