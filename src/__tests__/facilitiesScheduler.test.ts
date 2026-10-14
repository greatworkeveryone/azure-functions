/// <reference types="jest" />
import type { Connection } from "tedious";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../escalation/engine", () => ({ raise: jest.fn() }));

import { runFacilitiesScheduler, schedulerMode } from "../facilitiesScheduler";
import { DEFECTS_POLICIES } from "../escalation/adapters/defectsPeriod";
import { at, callsMatching, paramsOf, periodRow, routeQueries } from "./fixtures/facilitiesHarness";

const db = require("../db") as { executeQuery: jest.Mock };
const engine = require("../escalation/engine") as { raise: jest.Mock };
const conn = {} as Connection;
const NOW = new Date("2026-10-14T00:00:00Z");
const ENDING = /FROM dbo\.DefectsPeriods d[\s\S]*d\.EndsOn >= @From AND d\.EndsOn <= @To/;
const EVER_RAISED = /FROM dbo\.Escalations[\s\S]*PolicyKey = @PolicyKey/;

const periods = [
  periodRow({ DefectsPeriodId: 1, EndsOn: at("2026-11-28") }), // 45 days: the 60-day reminder
  periodRow({ DefectsPeriodId: 2, EndsOn: at("2026-10-24"), Services: "all" }), // 10 days: the 30-day reminder
];

function options(dryRun: boolean) {
  return { dryRun, log: jest.fn(), now: NOW, warn: jest.fn() };
}

beforeEach(() => {
  jest.clearAllMocks();
  routeQueries(db.executeQuery, [{ match: ENDING, rows: periods }]);
  engine.raise.mockResolvedValue({ created: true, escalation: {} });
});

describe("schedulerMode", () => {
  it("is off unless SCHEDULER_ENABLED is exactly true; the dry run wins", () => {
    expect(schedulerMode({})).toBe("off");
    expect(schedulerMode({ SCHEDULER_ENABLED: "1" })).toBe("off");
    expect(schedulerMode({ SCHEDULER_ENABLED: "true" })).toBe("live");
    expect(schedulerMode({ SCHEDULER_DRY_RUN: "true", SCHEDULER_ENABLED: "true" })).toBe("dry-run");
  });
});

describe("defects reminders", () => {
  it("looks 60 days ahead from today in Darwin", async () => {
    await runFacilitiesScheduler(conn, options(false));
    expect(paramsOf(callsMatching(db.executeQuery, ENDING)[0])).toEqual({ From: "2026-10-14", To: "2026-12-13" });
  });

  it("raises the 60-day and 30-day reminders through the escalation engine", async () => {
    const report = await runFacilitiesScheduler(conn, options(false));
    expect(engine.raise).toHaveBeenCalledTimes(2);
    expect(engine.raise.mock.calls[0][1]).toMatchObject({
      actor: { kind: "system", name: "schedulerTimer" },
      policyKey: DEFECTS_POLICIES.endsIn60,
      subjectId: "1",
      subjectType: "defects_period",
    });
    expect(engine.raise.mock.calls[0][1].headline).toMatch(/^Ends in 45 days: book the end-of-defects inspection/);
    expect(engine.raise.mock.calls[1][1]).toMatchObject({ policyKey: DEFECTS_POLICIES.endsIn30, subjectId: "2" });
    expect(report.defects).toEqual({ alreadyOpen: 0, considered: 2, raised: 2, skippedAlreadySent: 0, wouldRaise: 0 });
  });

  it("does not nag: a reminder already sent for this end date is not raised again", async () => {
    routeQueries(db.executeQuery, [
      { match: ENDING, rows: periods },
      { match: EVER_RAISED, rows: (params) => (params.SubjectId === "1" ? [{ EscalationId: 50 }] : []) },
    ]);
    const report = await runFacilitiesScheduler(conn, options(false));
    expect(engine.raise).toHaveBeenCalledTimes(1);
    expect(report.defects.skippedAlreadySent).toBe(1);
    const [check] = callsMatching(db.executeQuery, EVER_RAISED);
    expect(check[1]).toMatch(/JSON_VALUE\(Context, '\$\.endsOn'\) = @EndsOn/);
  });

  it("writes nothing in a dry run and says what it would raise", async () => {
    const opts = options(true);
    const report = await runFacilitiesScheduler(conn, opts);
    expect(engine.raise).not.toHaveBeenCalled();
    expect(report.defects.wouldRaise).toBe(2);
    expect(opts.log).toHaveBeenCalledWith(expect.stringMatching(/would raise defects_period\.ends_in_60 for defects period 1/));
  });

  it("collects a failure per period instead of stopping the run", async () => {
    engine.raise.mockRejectedValueOnce(new Error("The escalation policy is switched off"));
    const report = await runFacilitiesScheduler(conn, options(false));
    expect(engine.raise).toHaveBeenCalledTimes(2);
    expect(report.errors).toEqual(["defects period 1: The escalation policy is switched off"]);
    expect(report.defects.raised).toBe(1);
  });

  it("counts a reminder that is still open as already open", async () => {
    engine.raise.mockResolvedValue({ created: false, escalation: {} });
    const report = await runFacilitiesScheduler(conn, options(false));
    expect(report.defects.alreadyOpen).toBe(2);
  });
});
