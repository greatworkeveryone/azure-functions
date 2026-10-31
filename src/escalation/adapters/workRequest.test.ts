/// <reference types="jest" />
// The work_request adapter must understand Floorplan-native (negative) request ids: tenant-page requests have them.
import type { Connection } from "tedious";
import { workRequestAdapter } from "./workRequest";
import { parseWorkRequestId } from "../../workRequestsNative";

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));
const db = require("../../db") as { executeQuery: jest.Mock };
const conn = {} as Connection;
const row = { ActualCompletionDate: null, BuildingID: 5, BuildingName: "Tower A", HasJob: 0, IntakeState: null, Priority: "Urgent", RequestType: "Leak", TenantName: "Acme", WorkRequestID: -3 };

beforeEach(() => db.executeQuery.mockReset());

describe("work request ids", () => {
  it("parses positive, negative and string ids, and refuses zero, floats and out-of-range", () => {
    expect(parseWorkRequestId(12)).toBe(12);
    expect(parseWorkRequestId(-3)).toBe(-3);
    expect(parseWorkRequestId("-3")).toBe(-3);
    expect(parseWorkRequestId("31")).toBe(31);
    for (const bad of [0, "0", "-0", "01", 1.5, "1.5", 2_147_483_648, "-2147483649", "abc", "", null, undefined, {}, NaN]) expect(parseWorkRequestId(bad)).toBeNull();
  });
});

describe("the work_request adapter with a negative id", () => {
  it("loads the summary of a Floorplan-native request", async () => {
    db.executeQuery.mockResolvedValue([row]);
    const summary = await workRequestAdapter.loadSummary(conn, "-3");
    expect(summary?.summary).toContain("Request #-3");
    expect(db.executeQuery.mock.calls[0][2]).toEqual([expect.objectContaining({ name: "Id", value: -3 })]);
  });

  it("keeps the condition active while a native request is still received", async () => {
    db.executeQuery.mockResolvedValue([row]);
    await expect(workRequestAdapter.isConditionActive(conn, { policyKey: "request.unacknowledged", subjectId: "-3", subjectType: "work_request" }, new Date())).resolves.toBe(true);
  });

  it("still refuses a non-id", async () => {
    await expect(workRequestAdapter.loadSummary(conn, "abc")).resolves.toBeNull();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});
