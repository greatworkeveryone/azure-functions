import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { loadRouting } from "../inboundTriage/routingView";
import { _resetRateLimitForTests } from "../rateLimit";
import { getEmailRouting } from "./getEmailRouting";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.FACILITIES];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
  verifiedIdentityFromRequest: async () => ({ email: "fay@example.com", name: "Fay Facilities", oid: "fay-oid" }),
}));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})), executeQuery: jest.fn() }));
jest.mock("../inboundTriage/routingView", () => ({ loadRouting: jest.fn() }));

const load = jest.mocked(loadRouting);
const context = { error: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const request = (query = "emailIds=1,2") => new HttpRequest({ method: "GET", url: `http://localhost/api/getEmailRouting?${query}` });
const VIEW = { assignedAt: null, assignedBy: null, assignee: null, emailId: 1, linkedSendSubject: null, mailbox: null, reasons: [], state: "none" as const, suggestions: [] };

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  roles = [AppRole.FACILITIES];
  token = "token";
  load.mockResolvedValue(new Map([[1, VIEW]]));
});

describe("getEmailRouting", () => {
  it.each([AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.DIRECTOR, AppRole.ADMIN])("lets %s read who has an email, the people who read Incoming", async (role) => {
    roles = [role];
    expect((await getEmailRouting(request(), context)).status).toBe(200);
  });

  it("answers the views, uncached, for the ids asked", async () => {
    const response = await getEmailRouting(request("emailIds=1,2"), context);
    expect(response.jsonBody).toEqual({ items: [VIEW] });
    expect(response.headers).toMatchObject({ "Cache-Control": "no-store" });
    expect(load).toHaveBeenCalledWith(expect.anything(), [1, 2]);
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });

  it("refuses a baseline user before the database is opened, and a request with no token", async () => {
    roles = [AppRole.USER];
    expect((await getEmailRouting(request(), context)).status).toBe(403);
    token = null;
    expect((await getEmailRouting(request(), context)).status).toBe(401);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([[""], ["emailIds="], ["emailIds=abc"], ["emailIds=0"], ["emailIds=1,-2"]])("is a 400 for %p, before the database is opened", async (query) => {
    expect((await getEmailRouting(request(query), context)).status).toBe(400);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("is a plain 500, and closes the connection, when the database fails", async () => {
    load.mockRejectedValue(new Error("Login failed for user 'x'"));
    const response = await getEmailRouting(request(), context);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.jsonBody)).not.toContain("Login failed");
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });

  it("slows one person who asks too often", async () => {
    let last = 200;
    for (let i = 0; i < 125; i += 1) last = (await getEmailRouting(request(), context)).status ?? 0;
    expect(last).toBe(429);
  });
});
