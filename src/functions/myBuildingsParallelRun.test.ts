/// <reference types="jest" />
import type { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: jest.fn().mockReturnValue({ status: 500 }),
  extractToken: () => "t",
  requireRole: jest.fn().mockResolvedValue(null),
  unauthorizedResponse: jest.fn().mockReturnValue({ status: 401 }),
}));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})), executeQuery: jest.fn() }));
jest.mock("../mybuildings-client", () => ({ fetchWorkRequests: jest.fn() }));

const db = require("../db") as { executeQuery: jest.Mock };
const mb = require("../mybuildings-client") as { fetchWorkRequests: jest.Mock };
const auth = require("../auth") as { requireRole: jest.Mock };
const { handleParallelRun } = require("./myBuildingsParallelRun") as { handleParallelRun: (r: HttpRequest, c: InvocationContext) => Promise<{ status?: number; jsonBody?: any }> };
const ctx = { error: jest.fn(), log: jest.fn() } as unknown as InvocationContext;
const get = (q = "") => ({ headers: { get: () => null }, query: new URLSearchParams(q) }) as unknown as HttpRequest;

const OLD = { ...process.env };
afterEach(() => { process.env = { ...OLD }; });

it("lists what is only in myBuildings and what is only in Floorplan, and shows the switches", async () => {
  mb.fetchWorkRequests.mockResolvedValue([
    { WorkRequestID: 1, LastModifiedDate: "a", BuildingName: "Alpha" },
    { WorkRequestID: 2, LastModifiedDate: "b", BuildingName: "Alpha" },
    { WorkRequestID: 3, LastModifiedDate: "c", BuildingName: "Beta" },
  ]);
  db.executeQuery.mockImplementation(async (_c: unknown, text: string) =>
    /OPENJSON/.test(text) ? [{ WorkRequestID: 1, LastModifiedDate: "a" }, { WorkRequestID: 2, LastModifiedDate: "old" }] : [{ WorkRequestID: -1, Details: "native" }]);
  process.env.MYBUILDINGS_PUSH_ENABLED = "false";
  const res = await handleParallelRun(get("since=2026-10-15"), ctx);
  expect(res.jsonBody).toMatchObject({ matchedCount: 2, outOfDateCount: 1, onlyInMyBuildingsCount: 1, onlyInFloorplanCount: 1, since: "2026-10-15" });
  expect(res.jsonBody.onlyInMyBuildings[0].WorkRequestID).toBe(3);
  expect(res.jsonBody.switches).toMatchObject({ pushEnabled: false, syncMode: "normal" });
});

it("does not ask myBuildings when the sync is off", async () => {
  mb.fetchWorkRequests.mockClear();
  process.env.MYBUILDINGS_SYNC_MODE = "off";
  db.executeQuery.mockResolvedValue([]);
  const res = await handleParallelRun(get(), ctx);
  expect(mb.fetchWorkRequests).not.toHaveBeenCalled();
  expect(res.jsonBody.upstreamNote).toMatch(/off/);
});

it("is admin only and rejects a bad date", async () => {
  auth.requireRole.mockResolvedValueOnce({ status: 403 });
  expect((await handleParallelRun(get(), ctx)).status).toBe(403);
  expect((await handleParallelRun(get("since=yesterday"), ctx)).status).toBe(400);
});
