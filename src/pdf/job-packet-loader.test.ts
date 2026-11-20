import { loadJobPacketInputs } from "./job-packet-loader";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../blob-storage", () => ({ downloadBlob: jest.fn() }));

import { executeQuery } from "../db";

const mockQuery = executeQuery as unknown as jest.Mock;

function wireJob(row: Record<string, unknown>) {
  mockQuery.mockImplementation((_conn: unknown, sql: string) =>
    Promise.resolve(sql.includes("FROM Jobs j") ? [row] : []),
  );
}

const JOB_ROW = {
  CreatedAt: new Date("2026-11-20T00:00:00Z"),
  CreatedBy: "Connor Randazzo",
  Description: "Test example",
  IsOnchargeable: false,
  JobID: 2,
  Status: "New",
  Title: "[Inspection #1] Lower Ground / Test",
};

describe("loadJobPacketInputs", () => {
  beforeEach(() => mockQuery.mockReset());

  it("takes the building name from the job's building, not the tenant", async () => {
    wireJob({ ...JOB_ROW, BuildingName: "45 Stuart Highway" });
    const inputs = await loadJobPacketInputs({} as never, 2);
    expect(inputs?.job.buildingName).toBe("45 Stuart Highway");
    const sql = mockQuery.mock.calls.map(([, text]) => text as string).find((text) => text.includes("FROM Jobs j")) ?? "";
    expect(sql).toMatch(/LEFT JOIN dbo\.Buildings b ON b\.BuildingID = j\.BuildingID/);
    expect(sql).not.toMatch(/TenantName/);
  });

  it("gives an empty building name when the job has no building", async () => {
    wireJob({ ...JOB_ROW, BuildingName: null });
    const inputs = await loadJobPacketInputs({} as never, 2);
    expect(inputs?.job.buildingName).toBe("");
  });
});
