/// <reference types="jest" />
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { createRequestConnection } from "../db";
import { _resetRateLimitForTests } from "../rateLimit";
import { decideCoverItem } from "./decideCoverItem";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.FACILITIES_APPROVAL];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
}));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})) }));
jest.mock("../absenceCover/access", () => ({ ...jest.requireActual("../absenceCover/access"), requireCoverCaller: jest.fn() }));
jest.mock("../absenceCover/decide", () => ({ ...jest.requireActual("../absenceCover/decide"), decideCoverItem: jest.fn() }));

const access = jest.requireMock("../absenceCover/access") as { requireCoverCaller: jest.Mock };
const decide = jest.requireMock("../absenceCover/decide") as { decideCoverItem: jest.Mock };
const context = { error: jest.fn() } as unknown as InvocationContext;
const request = (body: unknown) => new HttpRequest({ body: { string: typeof body === "string" ? body : JSON.stringify(body) }, headers: { "Content-Type": "application/json" }, method: "POST", url: "http://localhost/api/decideCoverItem" });
const GOOD = { decision: "move", itemId: "12", itemType: "job" };

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  roles = [AppRole.FACILITIES_APPROVAL];
  token = "token";
  delete process.env.ABSENCE_COVER_ENABLED;
  access.requireCoverCaller.mockResolvedValue({ name: "Max", roles: ["facilities_manager"], userId: 2 });
  decide.decideCoverItem.mockResolvedValue({ coverActionId: 8, decision: "move", toUserId: 7 });
});

describe("decideCoverItem: who may call it", () => {
  it("refuses a request with no token", async () => {
    token = null;
    expect((await decideCoverItem(request(GOOD), context)).status).toBe(401);
    expect(decide.decideCoverItem).not.toHaveBeenCalled();
  });

  it.each([AppRole.FACILITIES, AppRole.ACCOUNTS, AppRole.USER])("refuses %s before reading the body or the database", async (role) => {
    roles = [role];
    expect((await decideCoverItem(request(GOOD), context)).status).toBe(403);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR])("lets %s through the gate", async (role) => {
    roles = [role];
    expect((await decideCoverItem(request(GOOD), context)).status).toBe(200);
  });
});

describe("decideCoverItem: input", () => {
  it.each([
    ["not JSON", "not json"],
    ["an array", "[1]"],
    ["an unknown item type", { ...GOOD, itemType: "payment" }],
    ["neither move nor keep", { ...GOOD, decision: "approve" }],
  ])("is a 400 for %s, before the database is opened", async (_label, body) => {
    expect((await decideCoverItem(request(body), context)).status).toBe(400);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("decideCoverItem: the decision", () => {
  it("passes the parsed decision and the engine's current mode, and answers with the result", async () => {
    process.env.ABSENCE_COVER_ENABLED = "true";
    const response = await decideCoverItem(request({ ...GOOD, coverUserId: 7 }), context);
    expect(response).toMatchObject({ jsonBody: { coverActionId: 8, decision: "move", toUserId: 7 }, status: 200 });
    expect(decide.decideCoverItem).toHaveBeenCalledWith({}, { name: "Max", roles: ["facilities_manager"], userId: 2 }, { coverUserId: 7, decision: "move", itemId: "12", itemType: "job" }, "live");
  });

  it("passes off as the mode when nothing is set, so the decision is refused there", async () => {
    await decideCoverItem(request(GOOD), context);
    expect(decide.decideCoverItem.mock.calls[0][3]).toBe("off");
  });

  it("answers a refusal in the status and words the decision gave", async () => {
    const { CoverError } = jest.requireActual("../absenceCover/errors");
    decide.decideCoverItem.mockRejectedValue(new CoverError("cover_switched_off", "Automatic cover is switched off.", 409));
    expect(await decideCoverItem(request(GOOD), context)).toMatchObject({ jsonBody: { code: "cover_switched_off", error: "Automatic cover is switched off." }, status: 409 });
  });

  it("is a 500 without internals when something unexpected fails", async () => {
    decide.decideCoverItem.mockRejectedValue(new Error("deadlock on dbo.Jobs"));
    const response = await decideCoverItem(request(GOOD), context);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.jsonBody)).not.toContain("dbo.Jobs");
  });

  it("limits how fast one manager can decide", async () => {
    let last = 200;
    for (let call = 0; call < 61; call += 1) last = (await decideCoverItem(request(GOOD), context)).status as number;
    expect(last).toBe(429);
  });
});
