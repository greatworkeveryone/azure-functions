/// <reference types="jest" />
import type { Connection } from "tedious";
import { SCHEDULE_POLICIES, schedulePolicyFor, serviceScheduleAdapter } from "./serviceSchedule";
import { getAdapter } from "./registry";
import "./index";
import { at, scheduleRow } from "../../__tests__/fixtures/facilitiesHarness";

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));
const db = require("../../db") as { executeQuery: jest.Mock };
const conn = {} as Connection;
const NOW = new Date("2026-10-14T00:00:00Z");
const ref = { policyKey: SCHEDULE_POLICIES.overdue, subjectId: "21", subjectType: "service_schedule" };

beforeEach(() => db.executeQuery.mockReset());

describe("service_schedule adapter", () => {
  it("is registered and links to the schedule on the Maintenance page", () => {
    expect(getAdapter("service_schedule")).toBe(serviceScheduleAdapter);
    expect(serviceScheduleAdapter.deepLink("21")).toBe("/maintenance?scheduleId=21");
  });

  it("names the service, what is serviced, the building and the due date", async () => {
    db.executeQuery.mockResolvedValue([scheduleRow({ NextDue: at("2026-10-12") })]);
    const summary = await serviceScheduleAdapter.loadSummary(conn, "21");
    expect(summary?.summary).toBe("Service · Six-monthly chiller service · Chiller 1 (CH-01) · Tower A · was due 12/10/2026");
    expect(summary?.context).toMatchObject({ nextDue: "2026-10-12", serviceScheduleId: 21 });
  });

  it("is overdue while the due date has passed and the schedule is live", async () => {
    db.executeQuery.mockResolvedValue([scheduleRow({ NextDue: at("2026-10-13") })]);
    expect(await serviceScheduleAdapter.isConditionActive(conn, ref, NOW)).toBe(true);
  });

  it("clears once the service is done (NextDue moved on), paused, archived or gone", async () => {
    for (const row of [
      scheduleRow({ NextDue: at("2026-10-14") }),
      scheduleRow({ Active: false, NextDue: at("2026-10-01") }),
      scheduleRow({ ArchivedAt: at("2026-10-10"), NextDue: at("2026-10-01") }),
    ]) {
      db.executeQuery.mockResolvedValue([row]);
      expect(await serviceScheduleAdapter.isConditionActive(conn, ref, NOW)).toBe(false);
    }
    db.executeQuery.mockResolvedValue([]);
    expect(await serviceScheduleAdapter.isConditionActive(conn, ref, NOW)).toBe(false);
  });

  it("is urgent for fire and life safety and lifts", () => {
    expect(schedulePolicyFor({ urgent: true })).toBe(SCHEDULE_POLICIES.overdueUrgent);
    expect(schedulePolicyFor({ urgent: false })).toBe(SCHEDULE_POLICIES.overdue);
  });

  it("is visible to operational roles only", () => {
    expect(serviceScheduleAdapter.visibleTo({ name: "A", roles: ["accounts"], userId: 1 }, ref)).toBe(true);
    expect(serviceScheduleAdapter.visibleTo({ name: "U", roles: ["user"], userId: 2 }, ref)).toBe(false);
  });
});
