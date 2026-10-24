import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { loadQueue } from "../inboundTriage/routingView";
import { _resetRateLimitForTests } from "../rateLimit";
import { getTriageQueue } from "./getTriageQueue";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.FACILITIES_APPROVAL];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
  rolesForRequest: async () => roles,
  verifiedIdentityFromRequest: async () => ({ email: "mo@example.com", name: "Mo Manager", oid: "mo-oid" }),
}));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})), executeQuery: jest.fn() }));
jest.mock("../test-data", () => ({ showTestParam: jest.fn(async () => ({ name: "ShowTest", type: 0, value: false })) }));
jest.mock("../inboundTriage/routingView", () => ({ ...jest.requireActual("../inboundTriage/routingView"), loadQueue: jest.fn() }));

const queue = jest.mocked(loadQueue);
const context = { error: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const request = () => new HttpRequest({ method: "GET", url: "http://localhost/api/getTriageQueue" });

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  roles = [AppRole.FACILITIES_APPROVAL];
  token = "token";
  queue.mockResolvedValue([]);
});

describe("getTriageQueue", () => {
  it.each([AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR, AppRole.ADMIN])("lets %s work the queue", async (role) => {
    roles = [role];
    expect((await getTriageQueue(request(), context)).status).toBe(200);
  });

  it.each([AppRole.FACILITIES, AppRole.ACCOUNTS, AppRole.USER])("refuses %s: field officers see who has an email, they do not hand it out", async (role) => {
    roles = [role];
    expect((await getTriageQueue(request(), context)).status).toBe(403);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("refuses a request with no token", async () => {
    token = null;
    expect((await getTriageQueue(request(), context)).status).toBe(401);
  });

  it("shows a manager their own team's lanes and the shared one, and test emails only with Show test data on", async () => {
    await getTriageQueue(request(), context);
    expect(queue).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining(["facilities", "both"]), false);
    expect(queue.mock.calls[0][1]).not.toContain("accounts");
  });

  it("answers the items uncached and closes the connection", async () => {
    queue.mockResolvedValue([{ category: null, emailId: 1, fromAddress: null, fromName: null, intent: "other", lane: "both", mailbox: null, receivedAt: null, subject: "s", suggestions: [], urgency: null }]);
    const response = await getTriageQueue(request(), context);
    expect(response.jsonBody).toMatchObject({ items: [{ emailId: 1 }] });
    expect(response.headers).toMatchObject({ "Cache-Control": "no-store" });
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });

  it("is a plain 500 when the database fails", async () => {
    queue.mockRejectedValue(new Error("deadlock"));
    const response = await getTriageQueue(request(), context);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.jsonBody)).not.toContain("deadlock");
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });
});
