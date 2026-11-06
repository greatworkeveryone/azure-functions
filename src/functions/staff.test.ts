/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
  };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));
jest.mock("../graph", () => ({ graphGetGroupUsers: jest.fn() }));

const db = require("../db") as { closeConnection: jest.Mock; createRequestConnection: jest.Mock; executeQuery: jest.Mock };
const graph = require("../graph") as { graphGetGroupUsers: jest.Mock };
const { getStaff, mapUsersToStaff } = require("./staff") as {
  getStaff: (req: HttpRequest, ctx: InvocationContext) => Promise<{ status: number; jsonBody?: unknown }>;
  mapUsersToStaff: typeof import("./staff").mapUsersToStaff;
};

const request = { headers: new Map() } as unknown as HttpRequest;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

describe("getStaff", () => {
  const env = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...env };
    delete process.env.PLANNER_FACILITIES_GROUP_ID;
    delete process.env.PLANNER_ACCOUNTS_GROUP_ID;
    db.createRequestConnection.mockResolvedValue({});
  });

  afterAll(() => {
    process.env = env;
  });

  it("lists active, signed-in app users when the Planner groups are not configured", async () => {
    db.executeQuery.mockResolvedValue([
      { DisplayName: "Zed Ops", Email: "zed@randazzo.properties" },
      { DisplayName: "Amy Accounts", Email: "amy@randazzo.properties" },
      { DisplayName: "Amy Again", Email: "AMY@randazzo.properties" },
    ]);

    const res = await getStaff(request, ctx);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({
      staff: [
        { email: "amy@randazzo.properties", name: "Amy Accounts" },
        { email: "zed@randazzo.properties", name: "Zed Ops" },
      ],
    });
    expect(graph.graphGetGroupUsers).not.toHaveBeenCalled();
    expect(db.executeQuery.mock.calls[0][1]).toMatch(/FROM dbo\.AppUsers/);
    expect(db.executeQuery.mock.calls[0][1]).toMatch(/IsActive = 1/);
    expect(db.closeConnection).toHaveBeenCalled();
    expect(ctx.error).not.toHaveBeenCalled();
  });

  it("reads the Planner groups through Graph when both are configured", async () => {
    process.env.PLANNER_FACILITIES_GROUP_ID = "fac";
    process.env.PLANNER_ACCOUNTS_GROUP_ID = "acc";
    graph.graphGetGroupUsers
      .mockResolvedValueOnce([{ id: "1", displayName: "Fay Facilities", mail: "fay@randazzo.properties", mobilePhone: null }])
      .mockResolvedValueOnce([{ id: "2", displayName: "Al Accounts", mail: "al@randazzo.properties", mobilePhone: null }]);

    const res = await getStaff(request, ctx);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({
      staff: [
        { email: "al@randazzo.properties", name: "Al Accounts" },
        { email: "fay@randazzo.properties", name: "Fay Facilities" },
      ],
    });
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("falls back to app users when only one Planner group is configured", async () => {
    process.env.PLANNER_FACILITIES_GROUP_ID = "fac";
    db.executeQuery.mockResolvedValue([{ DisplayName: "Solo", Email: "solo@randazzo.properties" }]);

    const res = await getStaff(request, ctx);

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ staff: [{ email: "solo@randazzo.properties", name: "Solo" }] });
    expect(graph.graphGetGroupUsers).not.toHaveBeenCalled();
  });

  it("returns 500 and logs when the fallback query fails", async () => {
    db.executeQuery.mockRejectedValue(new Error("boom"));

    const res = await getStaff(request, ctx);

    expect(res.status).toBe(500);
    expect(ctx.error).toHaveBeenCalledWith("getStaff failed:", "boom");
    expect(db.closeConnection).toHaveBeenCalled();
  });
});

describe("mapUsersToStaff", () => {
  it("drops users without email, dedupes case-insensitively and sorts by name", () => {
    const out = mapUsersToStaff([
      { id: "1", displayName: "B", mail: "b@x.com", mobilePhone: null },
      { id: "2", displayName: "No mail", mail: null, mobilePhone: null },
      { id: "3", displayName: "A", mail: "a@x.com", mobilePhone: null },
      { id: "4", displayName: "A dup", mail: "A@x.com", mobilePhone: null },
    ]);
    expect(out).toEqual([
      { email: "a@x.com", name: "A" },
      { email: "b@x.com", name: "B" },
    ]);
  });
});
