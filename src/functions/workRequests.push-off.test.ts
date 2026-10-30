/// <reference types="jest" />
// TR6: with pushing to myBuildings off, requests are created and changed in
// Floorplan and nothing goes upstream.
import type { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
  extractToken: () => "token",
  requireRole: async () => null,
  unauthorizedResponse: jest.fn().mockReturnValue({ status: 401 }),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "f@rp", name: "Fay", oid: "o" }),
}));
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(async () => ({})),
  executeQuery: jest.fn(),
}));
jest.mock("../mybuildings-client", () => ({
  bulkStatusUpdate: jest.fn(),
  createWorkRequest: jest.fn(),
  fetchWorkRequestById: jest.fn(),
  fetchWorkRequests: jest.fn(),
}));

type Handler = (r: HttpRequest, c: InvocationContext) => Promise<{ jsonBody?: any; status?: number }>;
const db = require("../db") as { executeQuery: jest.Mock };
const mb = require("../mybuildings-client") as Record<string, jest.Mock>;
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
require("./workRequests");
require("./bulkStatusUpdate");
const handlers = Object.fromEntries(app.http.mock.calls.map((c: unknown[]) => [c[0], (c[1] as { handler: Handler }).handler]));
const handler = (name: string): Handler => handlers[name];
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ headers: { get: () => null }, json: async () => body, query: new URLSearchParams() }) as unknown as HttpRequest;
const sql = () => db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1]));

const OLD = { ...process.env };
beforeEach(() => {
  jest.clearAllMocks();
  process.env.MYBUILDINGS_PUSH_ENABLED = "false";
  delete process.env.MYBUILDINGS_SYNC_MODE;
});
afterEach(() => { process.env = { ...OLD }; });

it("createWorkRequest inserts a native request and calls myBuildings not at all", async () => {
  db.executeQuery.mockImplementation(async (_c: unknown, text: string) =>
    /OUTPUT INSERTED\.WorkRequestID/.test(text) ? [{ WorkRequestID: -3 }] : [{ WorkRequestID: -3, Details: "Leak" }]);
  const res = await handler("createWorkRequest")(post({ BuildingID: 5, Details: "Leak" }), ctx);
  expect(res.status).toBe(200);
  expect(res.jsonBody.native).toBe(true);
  expect(mb.createWorkRequest).not.toHaveBeenCalled();
  expect(mb.fetchWorkRequestById).not.toHaveBeenCalled();
  expect(sql().some((s: string) => /SourceHost/.test(s))).toBe(true);
});

it("createWorkRequest still pushes when the switch is unset", async () => {
  delete process.env.MYBUILDINGS_PUSH_ENABLED;
  mb.createWorkRequest.mockResolvedValue({ Result: { WorkRequestID: 77 } });
  mb.fetchWorkRequestById.mockResolvedValue({ BuildingID: 5, WorkRequestID: 77 });
  db.executeQuery.mockResolvedValue([{ BuildingID: 5, WorkRequestID: 77 }]);
  await handler("createWorkRequest")(post({ BuildingID: 5 }), ctx);
  expect(mb.createWorkRequest).toHaveBeenCalledTimes(1);
});

describe("updateWorkRequest", () => {
  it("edits a native request in Floorplan, appending the note", async () => {
    db.executeQuery.mockResolvedValue([{ WorkRequestID: -3, StatusID: 1, LastModifiedDate: null }]);
    const res = await handler("updateWorkRequest")(post({ WorkRequestID: -3, StatusID: 2, WorkNotes: "Booked" }), ctx);
    expect(res.status).toBe(200);
    expect(mb.bulkStatusUpdate).not.toHaveBeenCalled();
    expect(sql().some((s: string) => /UPDATE WorkRequests SET/.test(s) && /CONCAT/.test(s))).toBe(true);
  });

  it("refuses a myBuildings-origin request while the pull would overwrite it", async () => {
    db.executeQuery.mockResolvedValue([{ WorkRequestID: 40, StatusID: 1, LastModifiedDate: null }]);
    const res = await handler("updateWorkRequest")(post({ WorkRequestID: 40, StatusID: 2 }), ctx);
    expect(res.status).toBe(409);
    expect(mb.bulkStatusUpdate).not.toHaveBeenCalled();
    expect(sql().some((s: string) => /UPDATE WorkRequests/.test(s))).toBe(false);
  });

  it("edits any request locally once the pull is off too", async () => {
    process.env.MYBUILDINGS_SYNC_MODE = "off";
    db.executeQuery.mockResolvedValue([{ WorkRequestID: 40, StatusID: 1, LastModifiedDate: null }]);
    const res = await handler("updateWorkRequest")(post({ WorkRequestID: 40, StatusID: 2 }), ctx);
    expect(res.status).toBe(200);
    expect(mb.bulkStatusUpdate).not.toHaveBeenCalled();
  });
});

it("bulkStatusUpdate refuses and sends nothing", async () => {
  const res = await handler("bulkStatusUpdate")(post([{ WorkRequestID: 1 }]), ctx);
  expect(res.status).toBe(409);
  expect(mb.bulkStatusUpdate).not.toHaveBeenCalled();
});
