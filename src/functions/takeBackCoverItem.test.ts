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

import { takeBackCoverItem } from "./takeBackCoverItem";

jest.mock("../absenceCover/handback", () => ({ takeBackItem: jest.fn() }));
const handback = jest.requireMock("../absenceCover/handback") as { takeBackItem: jest.Mock };
const request = (body: unknown) => new HttpRequest({ body: { string: typeof body === "string" ? body : JSON.stringify(body) }, headers: { "Content-Type": "application/json" }, method: "POST", url: "http://localhost/api/takeBackCoverItem" });

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  roles = [AppRole.FACILITIES];
  token = "token";
  access.requireCoverCaller.mockResolvedValue(CALLER);
  handback.takeBackItem.mockResolvedValue({ coverActionId: 555 });
});

describe("takeBackCoverItem", () => {
  it("refuses a request with no token, and someone with no role", async () => {
    token = null;
    expect((await takeBackCoverItem(request({ coverActionId: 100 }), context)).status).toBe(401);
    token = "token";
    roles = [];
    expect((await takeBackCoverItem(request({ coverActionId: 100 }), context)).status).toBe(403);
    expect(handback.takeBackItem).not.toHaveBeenCalled();
  });

  it.each([["not JSON", "nope"], ["an array", "[]"], ["no id", {}], ["an id that is text", { coverActionId: "100" }], ["zero", { coverActionId: 0 }], ["a fraction", { coverActionId: 1.5 }]])("is a 400 for %s", async (_label, body) => {
    expect((await takeBackCoverItem(request(body), context)).status).toBe(400);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("takes it back for the signed-in person and answers with the take-back's row", async () => {
    expect(await takeBackCoverItem(request({ coverActionId: 100 }), context)).toMatchObject({ jsonBody: { coverActionId: 555 }, status: 200 });
    expect(handback.takeBackItem).toHaveBeenCalledWith({}, CALLER, 100);
  });

  it("answers a refusal in the status and words given, and a failure without internals", async () => {
    const { CoverError } = jest.requireActual("../absenceCover/errors");
    handback.takeBackItem.mockRejectedValueOnce(new CoverError("changed", "You have already taken this back.", 409));
    expect(await takeBackCoverItem(request({ coverActionId: 100 }), context)).toMatchObject({ jsonBody: { error: "You have already taken this back." }, status: 409 });
    handback.takeBackItem.mockRejectedValueOnce(new Error("lock timeout on dbo.Jobs"));
    const failed = await takeBackCoverItem(request({ coverActionId: 100 }), context);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.jsonBody)).not.toContain("dbo.");
  });

  it("limits how fast one person can take items back", async () => {
    let last = 200;
    for (let call = 0; call < 61; call += 1) last = (await takeBackCoverItem(request({ coverActionId: 100 }), context)).status as number;
    expect(last).toBe(429);
  });
});
