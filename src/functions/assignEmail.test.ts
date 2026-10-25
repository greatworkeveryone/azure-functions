import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { assignEmail as assign } from "../inboundTriage/assign";
import { _resetRateLimitForTests } from "../rateLimit";
import { assignEmail } from "./assignEmail";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.FACILITIES_APPROVAL];
let token: string | null = "token";
let ledgerActor: unknown = { kind: "user", name: "Mo Manager", role: "facilities_manager", userId: 2 };
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
  rolesForRequest: async () => roles,
  verifiedIdentityFromRequest: async () => ({ email: "mo@example.com", name: "Mo Manager", oid: "mo-oid" }),
}));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn(async () => ledgerActor) }));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})), executeQuery: jest.fn() }));
jest.mock("../inboundTriage/assign", () => ({ assignEmail: jest.fn() }));
jest.mock("../inboundTriage/routingView", () => ({ loadRouting: jest.fn(async () => new Map([[5, { emailId: 5, state: "assigned" }]])) }));

const assignMock = jest.mocked(assign);
const context = { error: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const request = (body: unknown) =>
  new HttpRequest({
    body: { string: typeof body === "string" ? body : JSON.stringify(body) },
    headers: { "Content-Type": "application/json" },
    method: "POST",
    url: "http://localhost/api/assignEmail",
  });
const GOOD = { assigneeUserId: 4, emailId: 5, expectedAssigneeUserId: null };

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  roles = [AppRole.FACILITIES_APPROVAL];
  token = "token";
  ledgerActor = { kind: "user", name: "Mo Manager", role: "facilities_manager", userId: 2 };
  assignMock.mockResolvedValue({ ok: true, value: { assigneeName: "Fay", assigneeUserId: 4, emailId: 5, outcome: "accepted", previousUserId: null } });
});

describe("assignEmail: who may", () => {
  it.each([AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR, AppRole.ADMIN])("lets %s assign", async (role) => {
    roles = [role];
    expect((await assignEmail(request(GOOD), context)).status).toBe(200);
  });

  it.each([AppRole.FACILITIES, AppRole.ACCOUNTS, AppRole.USER])("refuses %s before reading or writing anything", async (role) => {
    roles = [role];
    expect((await assignEmail(request(GOOD), context)).status).toBe(403);
    expect(createRequestConnection).not.toHaveBeenCalled();
    expect(assignMock).not.toHaveBeenCalled();
  });

  it("refuses a request with no token, and one whose token does not resolve to a person", async () => {
    token = null;
    expect((await assignEmail(request(GOOD), context)).status).toBe(401);
    token = "token";
    ledgerActor = null;
    expect((await assignEmail(request(GOOD), context)).status).toBe(401);
    expect(assignMock).not.toHaveBeenCalled();
  });
});

describe("assignEmail: input", () => {
  it.each([
    ["not JSON", "nope"],
    ["not an object", "[1]"],
    ["no email", { assigneeUserId: 4 }],
    ["no assignee", { emailId: 5 }],
    ["an assignee that is not a whole number", { assigneeUserId: "4", emailId: 5 }],
    ["a note that is too long", { ...GOOD, note: "x".repeat(400) }],
  ])("is a 400 for %s, before the database is opened", async (_label, body) => {
    expect((await assignEmail(request(body), context)).status).toBe(400);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("never takes the person acting from the body: the ledger actor and name come from the token", async () => {
    await assignEmail(request({ ...GOOD, actor: "someone else", actorName: "Eve", oid: "eve" }), context);
    expect(assignMock.mock.calls[0][2]).toEqual({ ledger: ledgerActor, name: "Mo Manager", oid: "mo-oid", roles: [AppRole.FACILITIES_APPROVAL] });
  });

  it("answers 403 with the reason when the email is another team's lane to give out", async () => {
    assignMock.mockResolvedValueOnce({ error: "This email is another team's to give out. Ask its manager.", ok: false, status: 403 });
    const response = await assignEmail(request(GOOD), context);
    expect(response.status).toBe(403);
    expect(JSON.stringify(response.jsonBody ?? response.body)).toMatch(/another team's/);
  });
});

describe("assignEmail: outcomes", () => {
  it("answers the outcome and the email's new routing, uncached", async () => {
    const response = await assignEmail(request(GOOD), context);
    expect(response.jsonBody).toEqual({ outcome: "accepted", routing: { emailId: 5, state: "assigned" } });
    expect(response.headers).toMatchObject({ "Cache-Control": "no-store" });
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });

  it.each([
    [404, "Email not found"],
    [409, "Someone else has changed who has this email. Refresh and try again."],
    [400, "That person cannot be given Incoming email."],
  ] as const)("maps %s to that status with its sentence", async (status, error) => {
    assignMock.mockResolvedValue({ error, ok: false, status });
    const response = await assignEmail(request(GOOD), context);
    expect(response.status).toBe(status);
    expect(response.jsonBody).toEqual({ error });
  });

  it("is a plain 500, and closes the connection, when the database fails", async () => {
    assignMock.mockRejectedValue(new Error("Violation of PRIMARY KEY"));
    const response = await assignEmail(request(GOOD), context);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.jsonBody)).not.toContain("PRIMARY KEY");
    expect(closeConnection).toHaveBeenCalledTimes(1);
  });

  it("slows one person who sends too many", async () => {
    let last = 200;
    for (let i = 0; i < 65; i += 1) last = (await assignEmail(request(GOOD), context)).status ?? 0;
    expect(last).toBe(429);
  });
});
