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

import { archiveCoverDelegate } from "./archiveCoverDelegate";

jest.mock("../absenceCover/nominate", () => ({ archiveNomination: jest.fn() }));
jest.mock("../rentReview/store", () => ({ inTransaction: jest.fn(async (_c: unknown, work: () => Promise<unknown>) => work()) }));
const nominate = jest.requireMock("../absenceCover/nominate") as { archiveNomination: jest.Mock };
const request = (body: unknown) => new HttpRequest({ body: { string: typeof body === "string" ? body : JSON.stringify(body) }, headers: { "Content-Type": "application/json" }, method: "POST", url: "http://localhost/api/archiveCoverDelegate" });

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  roles = [AppRole.FACILITIES];
  token = "token";
  access.requireCoverCaller.mockResolvedValue(CALLER);
  nominate.archiveNomination.mockResolvedValue(undefined);
});

describe("archiveCoverDelegate", () => {
  it("refuses a request with no token, and someone with no role", async () => {
    token = null;
    expect((await archiveCoverDelegate(request({ coverDelegateId: 5, rowVersion: "rv" }), context)).status).toBe(401);
    token = "token";
    roles = [];
    expect((await archiveCoverDelegate(request({ coverDelegateId: 5, rowVersion: "rv" }), context)).status).toBe(403);
    expect(nominate.archiveNomination).not.toHaveBeenCalled();
  });

  it.each([
    ["not JSON", "nope"],
    ["no id", { rowVersion: "rv" }],
    ["an id of zero", { coverDelegateId: 0, rowVersion: "rv" }],
    ["an id that is text", { coverDelegateId: "5", rowVersion: "rv" }],
    ["no row version", { coverDelegateId: 5 }],
    ["an empty row version", { coverDelegateId: 5, rowVersion: "" }],
    ["a reason that is not text", { coverDelegateId: 5, reason: 4, rowVersion: "rv" }],
  ])("is a 400 for %s", async (_label, body) => {
    expect((await archiveCoverDelegate(request(body), context)).status).toBe(400);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("ends the nomination inside a transaction", async () => {
    expect(await archiveCoverDelegate(request({ coverDelegateId: 5, reason: "plans changed", rowVersion: "rv" }), context)).toMatchObject({ jsonBody: { ended: true }, status: 200 });
    expect(nominate.archiveNomination).toHaveBeenCalledWith({}, CALLER, 5, "rv", "plans changed");
  });

  it("answers a stale version as a conflict and a failure without internals", async () => {
    const { CoverError } = jest.requireActual("../absenceCover/errors");
    nominate.archiveNomination.mockRejectedValueOnce(new CoverError("changed", "This changed while you were looking at it.", 409));
    expect((await archiveCoverDelegate(request({ coverDelegateId: 5, rowVersion: "old" }), context)).status).toBe(409);
    nominate.archiveNomination.mockRejectedValueOnce(new Error("update failed on dbo.CoverDelegates"));
    const failed = await archiveCoverDelegate(request({ coverDelegateId: 5, rowVersion: "rv" }), context);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.jsonBody)).not.toContain("dbo.");
  });
});
