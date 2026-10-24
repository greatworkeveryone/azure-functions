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

import { saveCoverDelegate } from "./saveCoverDelegate";

jest.mock("../absenceCover/nominate", () => ({ ...jest.requireActual("../absenceCover/nominate"), saveNomination: jest.fn() }));
const nominate = jest.requireMock("../absenceCover/nominate") as { saveNomination: jest.Mock };
const request = (body: unknown) => new HttpRequest({ body: { string: typeof body === "string" ? body : JSON.stringify(body) }, headers: { "Content-Type": "application/json" }, method: "POST", url: "http://localhost/api/saveCoverDelegate" });
const GOOD = { delegateUserId: 7, fromDate: "2026-10-26", toDate: "2026-10-30" };

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  roles = [AppRole.FACILITIES];
  token = "token";
  access.requireCoverCaller.mockResolvedValue(CALLER);
  nominate.saveNomination.mockResolvedValue({ created: true, nomination: { coverDelegateId: 5 } });
});

describe("saveCoverDelegate", () => {
  it("refuses a request with no token, and someone with no role", async () => {
    token = null;
    expect((await saveCoverDelegate(request(GOOD), context)).status).toBe(401);
    token = "token";
    roles = [];
    expect((await saveCoverDelegate(request(GOOD), context)).status).toBe(403);
    expect(nominate.saveNomination).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "nope"],
    ["an array", "[]"],
    ["no cover", { fromDate: "2026-10-26", toDate: "2026-10-30" }],
    ["no dates", { delegateUserId: 7 }],
    ["an end before the start", { ...GOOD, fromDate: "2026-10-30", toDate: "2026-10-26" }],
    ["a cover that is not a number", { ...GOOD, delegateUserId: "7" }],
  ])("is a 400 for %s, before the database is opened", async (_label, body) => {
    expect((await saveCoverDelegate(request(body), context)).status).toBe(400);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("saves the nomination for the signed-in caller and answers with it", async () => {
    const response = await saveCoverDelegate(request({ ...GOOD, leaveRequestId: 4 }), context);
    expect(response).toMatchObject({ jsonBody: { created: true, nomination: { coverDelegateId: 5 } }, status: 200 });
    expect(nominate.saveNomination).toHaveBeenCalledWith({}, CALLER, { delegateUserId: 7, fromDate: "2026-10-26", leaveRequestId: 4, toDate: "2026-10-30", userId: null }, expect.any(String));
  });

  it("answers a refusal in the status and words given, and a failure without internals", async () => {
    const { CoverError } = jest.requireActual("../absenceCover/errors");
    nominate.saveNomination.mockRejectedValueOnce(new CoverError("delegate_is_self", "Choose someone else to cover.", 422));
    expect(await saveCoverDelegate(request(GOOD), context)).toMatchObject({ jsonBody: { code: "delegate_is_self", error: "Choose someone else to cover." }, status: 422 });
    nominate.saveNomination.mockRejectedValueOnce(new Error("insert failed on dbo.CoverDelegates"));
    const failed = await saveCoverDelegate(request(GOOD), context);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.jsonBody)).not.toContain("dbo.");
  });

  it("limits how fast one person can save", async () => {
    let last = 200;
    for (let call = 0; call < 21; call += 1) last = (await saveCoverDelegate(request(GOOD), context)).status as number;
    expect(last).toBe(429);
  });
});
