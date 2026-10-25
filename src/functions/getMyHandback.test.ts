/// <reference types="jest" />
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { createRequestConnection } from "../db";
import { _resetRateLimitForTests } from "../rateLimit";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.FACILITIES];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
}));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})) }));
jest.mock("../absenceCover/access", () => ({ ...jest.requireActual("../absenceCover/access"), requireCoverCaller: jest.fn() }));
const access = jest.requireMock("../absenceCover/access") as { requireCoverCaller: jest.Mock };
const context = { error: jest.fn() } as unknown as InvocationContext;
const CALLER = { name: "Fay Facilities", roles: ["facilities"], userId: 1 };

import { getMyHandback } from "./getMyHandback";

jest.mock("../absenceCover/handback", () => ({ buildHandback: jest.fn() }));
const handback = jest.requireMock("../absenceCover/handback") as { buildHandback: jest.Mock };
const request = () => new HttpRequest({ method: "GET", url: "http://localhost/api/getMyHandback" });

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.FACILITIES];
  token = "token";
  access.requireCoverCaller.mockResolvedValue(CALLER);
  handback.buildHandback.mockResolvedValue({ items: [], returned: true });
});

describe("getMyHandback", () => {
  it("refuses a request with no token, and someone with no role", async () => {
    token = null;
    expect((await getMyHandback(request(), context)).status).toBe(401);
    token = "token";
    roles = [];
    expect((await getMyHandback(request(), context)).status).toBe(403);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("answers with the caller's own handback, uncached", async () => {
    const response = await getMyHandback(request(), context);
    expect(response).toMatchObject({ headers: { "Cache-Control": "no-store" }, jsonBody: { items: [], returned: true }, status: 200 });
    expect(handback.buildHandback).toHaveBeenCalledWith({}, CALLER);
  });

  it("is a 500 without internals when reading fails", async () => {
    handback.buildHandback.mockRejectedValue(new Error("timeout on dbo.CoverActions"));
    const failed = await getMyHandback(request(), context);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.jsonBody)).not.toContain("dbo.");
  });
});
