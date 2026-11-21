/// <reference types="jest" />
import { app, HttpRequest, type InvocationContext } from "@azure/functions";
import { executeQuery, rollbackTransaction } from "../db";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn(async () => ({})),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../rateLimit", () => ({ checkRateLimit: () => ({ allowed: true }) }));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => "token",
  requireRole: async () => null,
  verifiedIdentityFromRequest: async () => ({ name: "Una User", oid: "una-oid" }),
}));

require("./staffReports");
const handlers = new Map(jest.mocked(app.http).mock.calls.map((call) => [call[0], call[1].handler!]));
const ctx = { error: jest.fn(), log: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) =>
  handlers.get("createStaffReport")!(new HttpRequest({ method: "POST", url: "http://localhost/api/x", headers: { "Content-Type": "application/json" }, body: { string: JSON.stringify(body) } }), ctx);
const query = jest.mocked(executeQuery);

beforeEach(() => {
  jest.resetAllMocks();
  jest.mocked(rollbackTransaction).mockResolvedValue(undefined);
});

describe("createStaffReport", () => {
  it("files the report under the verified identity, not one in the body", async () => {
    query.mockResolvedValueOnce([{ BuildingID: 4, BuildingName: "Alpha House" }]).mockResolvedValueOnce([{ NextId: 1_900_000_000 }]).mockResolvedValueOnce([]);
    const res = await post({ buildingId: 4, details: "Leak", oid: "forged-oid", reportedByOid: "forged-oid" });
    expect(res!.status).toBe(200);
    const insert = query.mock.calls.find(([, sql]) => sql.includes("INSERT INTO dbo.WorkRequests"))!;
    const param = (name: string) => insert[2]?.find((p) => p.name === name)?.value;
    expect(param("Oid")).toBe("una-oid");
    expect(param("Name")).toBe("Una User");
    expect(param("Id")).toBe(1_900_000_000);
    expect(insert[1]).toMatch(/N'staff'/);
  });

  it("writes nothing when the building does not exist", async () => {
    query.mockResolvedValueOnce([]);
    expect((await post({ buildingId: 999, details: "Leak" }))!.status).toBe(404);
    expect(query.mock.calls.some(([, sql]) => sql.includes("INSERT"))).toBe(false);
  });

  it("refuses an empty description", async () => {
    expect((await post({ buildingId: 4, details: " " }))!.status).toBe(400);
    expect(query).not.toHaveBeenCalled();
  });
});

describe("getMyStaffReports", () => {
  it("filters by the verified oid and says where each report has got to", async () => {
    query.mockResolvedValueOnce([
      { WorkRequestID: 1_900_000_002, BuildingName: "Alpha House", Details: "Leak", CreatedAt: "2026-11-20", JobID: null },
      { WorkRequestID: 1_900_000_001, BuildingName: "Alpha House", Details: "Door", CreatedAt: "2026-11-19", JobID: 8, JobStatus: "Done", CompletionDate: "2026-11-21" },
    ]);
    const res = await handlers.get("getMyStaffReports")!(new HttpRequest({ method: "GET", url: "http://localhost/api/x?oid=forged" }), ctx);
    expect(query.mock.calls[0][2]?.find((p) => p.name === "Oid")?.value).toBe("una-oid");
    const reports = ((res as { jsonBody: { reports: Array<{ stage: string }> } }).jsonBody).reports;
    expect(reports.map((r) => r.stage)).toEqual(["received", "closed"]);
  });
});
