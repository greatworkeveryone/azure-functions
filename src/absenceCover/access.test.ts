/// <reference types="jest" />
import { inTeamOf, isAdminOnly, requireCoverCaller, requireLive, coverErrorResponse } from "./access";
import { CoverError } from "./errors";

jest.mock("../escalation/http", () => ({ resolveCaller: jest.fn() }));
jest.mock("../auth", () => ({ errorResponse: (message: string) => ({ jsonBody: { error: message }, status: 500 }) }));
const http = jest.requireMock("../escalation/http") as { resolveCaller: jest.Mock };
const conn = {} as never;
const request = {} as never;

const caller = (roles: string[], userId = 1) => ({ name: "X", roles, userId });

describe("requireCoverCaller", () => {
  it("returns the signed-in person with their id and lower-cased roles", async () => {
    http.resolveCaller.mockResolvedValue({ actor: { kind: "user", name: "Fay", role: "facilities", userId: 1 }, viewer: { name: "Fay", roles: ["Facilities"], userId: 1 } });
    expect(await requireCoverCaller(request, conn)).toEqual({ name: "Fay", roles: ["facilities"], userId: 1 });
  });

  it("is a 401 when the token does not verify", async () => {
    http.resolveCaller.mockResolvedValue(null);
    await expect(requireCoverCaller(request, conn)).rejects.toMatchObject({ code: "unauthorized", status: 401 });
  });

  it("says in words, with a 422, when there is no active staff record: the gate is for roles, this is about the person", async () => {
    http.resolveCaller.mockResolvedValue({ actor: { kind: "user", name: "Fay", role: "facilities", userId: null }, viewer: { name: "Fay", roles: ["facilities"], userId: null } });
    await expect(requireCoverCaller(request, conn)).rejects.toMatchObject({ code: "no_staff_record", message: "An active staff record is required.", status: 422 });
  });
});

describe("inTeamOf and isAdminOnly", () => {
  it.each([
    [["facilities_manager"], "facilities", true],
    [["facilities_manager"], "facilities_manager", true],
    [["facilities_manager"], "accounts", false],
    [["accounts_manager"], "facilities", false],
    [["cfo"], "facilities_manager", true],
    [["cfo"], "accounts", true],
    [["cfo"], "cfo", true],
    [["cfo"], "director", false],
    [["director"], "director", true],
    [["director"], "facilities", true],
    [["facilities"], "facilities", false],
    [["user"], "facilities", false],
  ])("a %j manager's view takes in a %s: %s", (roles, role, expected) => {
    expect(inTeamOf(caller(roles), role)).toBe(expected);
  });

  it("never takes anyone in for admin, who looks after Floorplan", () => {
    expect(isAdminOnly(caller(["admin"]))).toBe(true);
    expect(isAdminOnly(caller(["admin", "user"]))).toBe(true);
    expect(isAdminOnly(caller(["admin", "director"]))).toBe(false);
    expect(inTeamOf(caller(["admin"]), "facilities")).toBe(false);
  });
});

describe("requireLive", () => {
  it("lets a live engine through and refuses off and dry run in words", () => {
    expect(() => requireLive("live")).not.toThrow();
    for (const mode of ["off", "dry-run"] as const) {
      expect(() => requireLive(mode)).toThrow(expect.objectContaining({ code: "cover_switched_off", status: 409 }));
    }
  });

  it("reads the environment when no mode is given", () => {
    const saved = { enabled: process.env.ABSENCE_COVER_ENABLED, dry: process.env.ABSENCE_COVER_DRY_RUN };
    try {
      delete process.env.ABSENCE_COVER_DRY_RUN;
      process.env.ABSENCE_COVER_ENABLED = "true";
      expect(() => requireLive()).not.toThrow();
      delete process.env.ABSENCE_COVER_ENABLED;
      expect(() => requireLive()).toThrow();
    } finally {
      for (const [key, value] of [["ABSENCE_COVER_ENABLED", saved.enabled], ["ABSENCE_COVER_DRY_RUN", saved.dry]] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});

describe("coverErrorResponse", () => {
  const context = { error: jest.fn() } as never;

  it("answers a cover refusal with its status, code and words", () => {
    expect(coverErrorResponse(new CoverError("changed", "This changed.", 409), context, "x")).toEqual({ jsonBody: { code: "changed", error: "This changed." }, status: 409 });
  });

  it("answers anything else as a failure without its internals, and logs it", () => {
    const response = coverErrorResponse(new Error("deadlock on dbo.Jobs"), context, "decideCoverItem");
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.jsonBody)).not.toContain("dbo.Jobs");
  });
});
