import { parseStaffReport, reportStage, STAFF_REPORT_ID_BASE } from "./staffReports";

describe("parseStaffReport", () => {
  it("takes a building and trimmed details", () => {
    expect(parseStaffReport({ buildingId: 4, details: "  Leak in the lift lobby " })).toEqual({ buildingId: 4, details: "Leak in the lift lobby" });
  });
  it("ignores any reporter named in the body: only the two fields come back", () => {
    expect(Object.keys(parseStaffReport({ buildingId: 4, details: "x", reportedBy: "someone-else", oid: "forged" })).sort()).toEqual(["buildingId", "details"]);
  });
  it.each([[{ details: "x" }], [{ buildingId: "4", details: "x" }], [{ buildingId: 4, details: "   " }], [{ buildingId: 4, details: "x".repeat(1001) }]])("refuses %j", (body) => {
    expect(() => parseStaffReport(body)).toThrow();
  });
});

describe("reportStage", () => {
  it("is received with no job, job while the job is live, closed when Done or archived", () => {
    expect(reportStage({})).toBe("received");
    expect(reportStage({ JobID: 3, JobStatus: "Quote" })).toBe("job");
    expect(reportStage({ JobID: 3, JobStatus: "Done" })).toBe("closed");
    expect(reportStage({ IsArchived: true, JobID: 3, JobStatus: "Quote" })).toBe("closed");
  });
  it("keeps the id range clear of myBuildings", () => {
    expect(STAFF_REPORT_ID_BASE).toBeLessThan(2_147_483_647);
  });
});
