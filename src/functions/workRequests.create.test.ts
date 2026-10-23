/// <reference types="jest" />
// createWorkRequest (SC-HY1): the route reads its gate from ACTION_ROLES.createWorkRequest, the
// entry Job Intake's New request button and the palette action are offered from. Each role class
// is sent through the real handler with the role hierarchy applied, so the table and the route
// cannot drift apart. (action-roles.parity.test sweeps the same route across every role too.)
import type { HttpRequest, InvocationContext } from "@azure/functions";
import { ACTION_ROLES, exportActionRoles } from "../action-roles";
import { AppRole } from "../auth";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});
let roles: string[] = [AppRole.FACILITIES_APPROVAL];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_request: unknown, allowed: string[]) =>
    jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 },
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

type Handler = (request: HttpRequest, context: InvocationContext) => Promise<{ jsonBody?: any; status?: number }>;
const db = require("../db") as { closeConnection: jest.Mock; createRequestConnection: jest.Mock; executeQuery: jest.Mock };
const myBuildings = require("../mybuildings-client") as { createWorkRequest: jest.Mock; fetchWorkRequestById: jest.Mock };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
require("./workRequests");
const registered = app.http.mock.calls.find((call: unknown[]) => call[0] === "createWorkRequest");
const createWorkRequest = (registered![1] as { handler: Handler }).handler;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const payload = { BuildingID: 5, Details: "Leaking tap in the plant room" };
const post = (body: unknown = payload) =>
  ({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: new URLSearchParams() }) as unknown as HttpRequest;
const asRole = (role: AppRole | string) => {
  roles = [role];
};

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.FACILITIES_APPROVAL];
  token = "token";
  myBuildings.createWorkRequest.mockResolvedValue({ Result: { WorkRequestID: 77 } });
  myBuildings.fetchWorkRequestById.mockResolvedValue({ BuildingID: 5, BuildingName: "Alpha House", Details: payload.Details, WorkRequestID: 77 });
  db.executeQuery.mockResolvedValue([{ BuildingID: 5, WorkRequestID: 77 }]);
});

describe("access", () => {
  it("is the createWorkRequest entry: facilities managers, with admin and directors through the hierarchy", () => {
    expect(ACTION_ROLES.createWorkRequest.routes).toEqual(["createWorkRequest"]);
    expect(ACTION_ROLES.createWorkRequest.gate).toEqual([AppRole.FACILITIES_APPROVAL]);
    expect(exportActionRoles().createWorkRequest).toEqual([AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES_APPROVAL]);
  });

  it("returns 401 with no token, before any role check or call out", async () => {
    token = null;
    expect((await createWorkRequest(post(), ctx)).status).toBe(401);
    expect(myBuildings.createWorkRequest).not.toHaveBeenCalled();
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([[AppRole.ADMIN], [AppRole.DIRECTOR], [AppRole.FACILITIES_APPROVAL]])("lets %s create a work request", async (role) => {
    asRole(role);
    const res = await createWorkRequest(post(), ctx);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ message: "Work request created", workRequest: { WorkRequestID: 77 } });
    expect(myBuildings.createWorkRequest).toHaveBeenCalledTimes(1);
    expect(myBuildings.createWorkRequest).toHaveBeenCalledWith(payload);
  });

  it.each([[AppRole.ACCOUNTS], [AppRole.ACCOUNTS_APPROVAL], [AppRole.CFO], [AppRole.FACILITIES], [AppRole.USER]])(
    "returns 403 for %s, before anything is created in myBuildings or read from SQL",
    async (role) => {
      asRole(role);
      const res = await createWorkRequest(post(), ctx);

      expect(res.status).toBe(403);
      expect(myBuildings.createWorkRequest).not.toHaveBeenCalled();
      expect(db.createRequestConnection).not.toHaveBeenCalled();
    },
  );

  it("returns 403 for someone with no role at all", async () => {
    roles = [];
    expect((await createWorkRequest(post(), ctx)).status).toBe(403);
    expect(myBuildings.createWorkRequest).not.toHaveBeenCalled();
  });

  it("lets in someone who holds the manager role among others, and not someone holding only field-officer and accounts roles", async () => {
    roles = [AppRole.USER, AppRole.FACILITIES_APPROVAL];
    expect((await createWorkRequest(post(), ctx)).status).toBe(200);

    roles = [AppRole.FACILITIES, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO];
    expect((await createWorkRequest(post(), ctx)).status).toBe(403);
  });
});

describe("what it does for a role that is let in", () => {
  it("looks the building up by name when myBuildings leaves its id out, as a parameter", async () => {
    myBuildings.fetchWorkRequestById.mockResolvedValue({ BuildingName: "Alpha House", WorkRequestID: 77 });
    await createWorkRequest(post({ Details: "No building id in the payload" }), ctx);

    const lookup = db.executeQuery.mock.calls.find(([, sql]) => /FROM Buildings WHERE BuildingName/.test(sql as string));
    expect(lookup?.[2]).toEqual([expect.objectContaining({ name: "BuildingName", value: "Alpha House" })]);
    expect(lookup?.[1]).not.toContain("Alpha House");
  });

  it("closes the SQL connection after a success", async () => {
    await createWorkRequest(post(), ctx);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});

describe("when something goes wrong", () => {
  it("returns a 500 without the raw error, and stores nothing, when myBuildings refuses the request", async () => {
    myBuildings.createWorkRequest.mockRejectedValue(new Error("myBuildings API error 502: secret upstream detail"));
    const res = await createWorkRequest(post(), ctx);

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.jsonBody)).not.toContain("secret upstream detail");
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("returns a 500, and stores nothing, when myBuildings does not say which request it made", async () => {
    myBuildings.createWorkRequest.mockResolvedValue({ Success: true });
    const res = await createWorkRequest(post(), ctx);

    expect(res.status).toBe(500);
    expect(myBuildings.fetchWorkRequestById).not.toHaveBeenCalled();
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("returns a 500, and stores nothing, when the new request cannot be read back", async () => {
    myBuildings.fetchWorkRequestById.mockResolvedValue(null);
    expect((await createWorkRequest(post(), ctx)).status).toBe(500);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("returns a 500 without the raw error and still closes the connection when SQL fails", async () => {
    db.executeQuery.mockRejectedValue(new Error("Violation of PRIMARY KEY constraint"));
    const res = await createWorkRequest(post(), ctx);

    expect(res.status).toBe(500);
    expect(JSON.stringify(res.jsonBody)).not.toContain("PRIMARY KEY");
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });

  it("creates nothing in myBuildings when the body cannot be read", async () => {
    const unreadable = { headers: { get: () => null }, json: jest.fn().mockRejectedValue(new SyntaxError("Unexpected token")), query: new URLSearchParams() } as unknown as HttpRequest;
    const res = await createWorkRequest(unreadable, ctx);

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(myBuildings.createWorkRequest).not.toHaveBeenCalled();
  });
});
