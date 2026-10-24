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

import { getCoverDelegates } from "./getCoverDelegates";

jest.mock("../absenceCover/nominate", () => ({ listNominations: jest.fn() }));
jest.mock("../escalation/store", () => ({ listActiveUsers: jest.fn() }));
const nominate = jest.requireMock("../absenceCover/nominate") as { listNominations: jest.Mock };
const escalation = jest.requireMock("../escalation/store") as { listActiveUsers: jest.Mock };
const request = (query = "") => new HttpRequest({ method: "GET", url: `http://localhost/api/getCoverDelegates${query}` });

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.FACILITIES];
  token = "token";
  access.requireCoverCaller.mockResolvedValue(CALLER);
  nominate.listNominations.mockResolvedValue([{ coverDelegateId: 5 }]);
  escalation.listActiveUsers.mockResolvedValue([
    { email: null, name: "Fay Facilities", role: "facilities", userId: 1 },
    { email: null, name: "Sam Facilities", role: "facilities", userId: 7 },
    { email: null, name: "Ada Admin", role: "admin", userId: 9 },
  ]);
});

describe("getCoverDelegates", () => {
  it("refuses a request with no token", async () => {
    token = null;
    expect((await getCoverDelegates(request(), context)).status).toBe(401);
  });

  it("refuses someone with no role at all, before reading anything", async () => {
    roles = [];
    expect((await getCoverDelegates(request(), context)).status).toBe(403);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([AppRole.FACILITIES, AppRole.ACCOUNTS, AppRole.USER, AppRole.CFO])("lets %s see their own", async (role) => {
    roles = [role];
    expect((await getCoverDelegates(request(), context)).status).toBe(200);
  });

  it("answers with the caller's nominations and the colleagues who could cover, leaving out themselves and admin", async () => {
    const response = await getCoverDelegates(request(), context);
    expect(response.jsonBody).toMatchObject({ nominations: [{ coverDelegateId: 5 }], selfId: 1, subjectId: 1 });
    expect((response.jsonBody as { people: { userId: number }[] }).people.map((person) => person.userId)).toEqual([7]);
    expect(nominate.listNominations).toHaveBeenCalledWith({}, CALLER, expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), 1);
  });

  it("asks for another person's nominations when a manager names them", async () => {
    await getCoverDelegates(request("?userId=3"), context);
    expect(nominate.listNominations.mock.calls[0][3]).toBe(3);
  });

  it.each(["?userId=abc", "?userId=-1", "?userId=1.5", "?userId="])("is a 400 for %s", async (query) => {
    expect((await getCoverDelegates(request(query), context)).status).toBe(400);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("answers a refusal with its status, and a failure without internals", async () => {
    const { CoverError } = jest.requireActual("../absenceCover/errors");
    nominate.listNominations.mockRejectedValueOnce(new CoverError("forbidden", "You cannot see their cover nominations.", 403));
    expect(await getCoverDelegates(request("?userId=3"), context)).toMatchObject({ jsonBody: { error: "You cannot see their cover nominations." }, status: 403 });
    nominate.listNominations.mockRejectedValueOnce(new Error("timeout on dbo.CoverDelegates"));
    const failed = await getCoverDelegates(request(), context);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.jsonBody)).not.toContain("dbo.");
  });
});
