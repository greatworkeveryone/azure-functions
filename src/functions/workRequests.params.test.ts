/// <reference types="jest" />
// Values spliced into the myBuildings URL are validated and encoded (a crafted
// buildingId used to add upstream parameters), and the overlay's money columns
// go through the shared money parser.
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
  extractToken: jest.fn().mockReturnValue("mock-token"),
  requireRole: jest.fn().mockResolvedValue(null),
  unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "m@rp", name: "Mia Manager", oid: "mia-oid" }),
}));
jest.mock("../mybuildings-client", () => ({ fetchWorkRequests: jest.fn().mockResolvedValue([]) }));

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status?: number; jsonBody?: unknown }>;
const db = require("../db") as { createRequestConnection: jest.Mock; executeQuery: jest.Mock };
const client = require("../mybuildings-client") as { fetchWorkRequests: jest.Mock };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
require("./workRequests");
require("./syncWorkRequests");
const handler = (name: string): Handler => {
  const hit = app.http.mock.calls.find((c: unknown[]) => c[0] === name);
  return (hit![1] as { handler: Handler }).handler;
};
const getWorkRequests = handler("getWorkRequests");
const syncWorkRequests = handler("syncWorkRequests");
const updateWorkRequestLocal = handler("updateWorkRequestLocal");

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const get = (query: string, body: unknown = {}) =>
  ({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams(query) }) as unknown as HttpRequest;

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockResolvedValue([]);
  client.fetchWorkRequests.mockResolvedValue([]);
});

describe.each([
  ["getWorkRequests", () => getWorkRequests],
  ["syncWorkRequests", () => syncWorkRequests],
])("%s: buildingId", (_name, pick) => {
  it.each(["1&buildingID=2", "12abc", "1.5", "abc", "0x10", " "])("refuses %p with 400 before anything is sent upstream", async (value) => {
    const res = await pick()(get(`buildingId=${encodeURIComponent(value)}`), ctx);

    expect(res.status).toBe(400);
    expect(client.fetchWorkRequests).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("refuses a non-numeric statusId the same way", async () => {
    const res = await pick()(get("buildingId=5&statusId=1%26x%3D2"), ctx);

    expect(res.status).toBe(400);
    expect(client.fetchWorkRequests).not.toHaveBeenCalled();
  });
});

describe("the upstream query string", () => {
  it("getWorkRequests sends a numeric building and an encoded date", async () => {
    const res = await getWorkRequests(get("buildingId=7&force=true"), ctx);

    expect(res.status).toBe(200);
    const params = new URLSearchParams(client.fetchWorkRequests.mock.calls[0][0] as string);
    expect([...params.keys()].sort()).toEqual(["buildingID", "lastmodifieddate"]);
    expect(params.get("buildingID")).toBe("7");
  });

  it("syncWorkRequests encodes every value, so lastModifiedDate cannot add a parameter", async () => {
    const res = await syncWorkRequests(get("buildingId=7&statusId=3&lastModifiedDate=2026-01-01%26buildingID%3D9"), ctx);

    expect(res.status).toBe(200);
    const raw = client.fetchWorkRequests.mock.calls[0][0] as string;
    const params = new URLSearchParams(raw);
    expect(params.getAll("buildingID")).toEqual(["7"]);
    expect(params.get("statusID")).toBe("3");
    expect(params.get("lastmodifieddate")).toBe("2026-01-01&buildingID=9");
    expect(raw).not.toMatch(/lastmodifieddate=[^&]*&buildingID=9/);
  });

  it("syncWorkRequests with no filters asks for everything", async () => {
    await syncWorkRequests(get(""), ctx);

    expect(client.fetchWorkRequests).toHaveBeenCalledWith("");
  });
});

describe("updateWorkRequestLocal: money columns", () => {
  const post = (body: unknown) => get("", body);
  const bound = (name: string): unknown =>
    (db.executeQuery.mock.calls[0][2] as { name: string; value: unknown }[]).find((p) => p.name === name)?.value;

  it.each(["12abc", -5, "1.234", "abc", true])("refuses TotalCost %p with 400 and writes nothing", async (value) => {
    const res = await updateWorkRequestLocal(post({ WorkRequestID: 4, TotalCost: value }), ctx);

    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("stores \"1,500.50\" as 1500.5, not 1", async () => {
    db.executeQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ WorkRequestID: 4 }]);
    const res = await updateWorkRequestLocal(post({ WorkRequestID: 4, TotalCost: "1,500.50", CostNotToExceed: 2000 }), ctx);

    expect(res.status).toBe(200);
    expect(bound("TotalCost")).toBe(1500.5);
    expect(bound("CostNotToExceed")).toBe(2000);
  });

  it("still clears a cost with null", async () => {
    db.executeQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ WorkRequestID: 4 }]);
    await updateWorkRequestLocal(post({ WorkRequestID: 4, CostNotToExceed: null }), ctx);

    expect(bound("CostNotToExceed")).toBeNull();
  });
});
