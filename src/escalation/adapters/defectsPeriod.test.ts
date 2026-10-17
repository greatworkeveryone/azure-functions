/// <reference types="jest" />
import type { Connection } from "tedious";
import { DEFECTS_POLICIES, defectsPeriodAdapter, defectsReminderHeadline } from "./defectsPeriod";
import { getAdapter } from "./registry";
import "./index";
import { periodRow, at } from "../../__tests__/fixtures/facilitiesHarness";

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));
const db = require("../../db") as { executeQuery: jest.Mock };
const conn = {} as Connection;
// 14 Oct 2026 09:30 in Darwin.
const NOW = new Date("2026-10-14T00:00:00Z");
const ref = (policyKey: string) => ({ policyKey, subjectId: "3", subjectType: "defects_period" });

beforeEach(() => db.executeQuery.mockReset());

describe("defects_period adapter", () => {
  it("is registered with the engine", () => {
    expect(getAdapter("defects_period")).toBe(defectsPeriodAdapter);
  });

  it("links to the period on the Maintenance page", () => {
    expect(defectsPeriodAdapter.deepLink("3")).toBe("/maintenance?defectsPeriodId=3");
  });

  it("names the works, building and end date", async () => {
    db.executeQuery.mockResolvedValue([periodRow()]);
    const summary = await defectsPeriodAdapter.loadSummary(conn, "3");
    expect(summary).toMatchObject({ buildingId: 1, context: { endsOn: "2027-06-30", works: "Level 3 mechanical upgrade" } });
    expect(summary?.summary).toBe("Defects period · Level 3 mechanical upgrade · Tower A · ends 30/06/2027");
  });

  it("knows nothing about a missing period or a bad id", async () => {
    db.executeQuery.mockResolvedValue([]);
    expect(await defectsPeriodAdapter.loadSummary(conn, "3")).toBeNull();
    expect(await defectsPeriodAdapter.loadSummary(conn, "x")).toBeNull();
  });

  it("keeps the 60-day reminder live until the end, the 30-day one only in the last 30 days", async () => {
    db.executeQuery.mockResolvedValue([periodRow({ EndsOn: at("2026-11-28") })]); // 45 days left
    expect(await defectsPeriodAdapter.isConditionActive(conn, ref(DEFECTS_POLICIES.endsIn60), NOW)).toBe(true);
    expect(await defectsPeriodAdapter.isConditionActive(conn, ref(DEFECTS_POLICIES.endsIn30), NOW)).toBe(false);
    db.executeQuery.mockResolvedValue([periodRow({ EndsOn: at("2026-10-24") })]); // 10 days left
    expect(await defectsPeriodAdapter.isConditionActive(conn, ref(DEFECTS_POLICIES.endsIn60), NOW)).toBe(true);
    expect(await defectsPeriodAdapter.isConditionActive(conn, ref(DEFECTS_POLICIES.endsIn30), NOW)).toBe(true);
  });

  it("clears once the period has ended, is archived or is gone", async () => {
    db.executeQuery.mockResolvedValue([periodRow({ EndsOn: at("2026-10-13") })]);
    expect(await defectsPeriodAdapter.isConditionActive(conn, ref(DEFECTS_POLICIES.endsIn30), NOW)).toBe(false);
    db.executeQuery.mockResolvedValue([periodRow({ ArchivedAt: at("2026-10-01"), EndsOn: at("2026-10-24") })]);
    expect(await defectsPeriodAdapter.isConditionActive(conn, ref(DEFECTS_POLICIES.endsIn30), NOW)).toBe(false);
    db.executeQuery.mockResolvedValue([]);
    expect(await defectsPeriodAdapter.isConditionActive(conn, ref(DEFECTS_POLICIES.endsIn60), NOW)).toBe(false);
  });

  it("is visible to operational roles, not to the baseline user", () => {
    expect(defectsPeriodAdapter.visibleTo({ name: "F", roles: ["facilities"], userId: 1 }, ref(DEFECTS_POLICIES.endsIn60))).toBe(true);
    expect(defectsPeriodAdapter.visibleTo({ name: "U", roles: ["user"], userId: 2 }, ref(DEFECTS_POLICIES.endsIn60))).toBe(false);
  });

  it("writes the reminder the spec asks for", () => {
    const headline = defectsReminderHeadline({ contractorName: "Acme Builders", endsOn: "2026-11-28", services: ["HVAC / mechanical"] }, "2026-10-14");
    expect(headline).toBe(
      "Ends in 45 days: book the end-of-defects inspection, send outstanding defects to Acme Builders, and put HVAC / mechanical back on RP's schedule after 28/11/2026",
    );
  });
});
