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

import { getCoverNotes } from "./getCoverNotes";

jest.mock("../absenceCover/notes", () => ({ ...jest.requireActual("../absenceCover/notes"), loadJobCoverNotes: jest.fn() }));
const notes = jest.requireMock("../absenceCover/notes") as { loadJobCoverNotes: jest.Mock };
const request = (query = "") => new HttpRequest({ method: "GET", url: `http://localhost/api/getCoverNotes${query}` });

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.FACILITIES];
  token = "token";
  notes.loadJobCoverNotes.mockResolvedValue([{ awayName: "Fay", coverName: "Max", itemId: "12", returnDate: "2026-11-02" }]);
});

describe("getCoverNotes", () => {
  it("refuses a request with no token", async () => {
    token = null;
    expect((await getCoverNotes(request("?jobIds=1"), context)).status).toBe(401);
  });

  it.each([AppRole.USER])("refuses %s, who cannot read jobs", async (role) => {
    roles = [role];
    expect((await getCoverNotes(request("?jobIds=1"), context)).status).toBe(403);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR])("lets %s, who read jobs, see who is covering", async (role) => {
    roles = [role];
    expect((await getCoverNotes(request("?jobIds=12"), context)).status).toBe(200);
  });

  it("answers with the notes for the jobs asked about, once each", async () => {
    const response = await getCoverNotes(request("?jobIds=12,13,12"), context);
    expect(response.jsonBody).toEqual({ notes: [{ awayName: "Fay", coverName: "Max", itemId: "12", returnDate: "2026-11-02" }] });
    expect(notes.loadJobCoverNotes).toHaveBeenCalledWith({}, [12, 13], expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/));
  });

  it("answers an empty list for no ids, without asking the database for any", async () => {
    await getCoverNotes(request(), context);
    expect(notes.loadJobCoverNotes).toHaveBeenCalledWith({}, [], expect.any(String));
  });

  it.each(["?jobIds=abc", "?jobIds=1,,2", "?jobIds=-3", `?jobIds=${Array.from({ length: 101 }, (_, index) => index + 1).join(",")}`])("is a 400 for %s", async (query) => {
    expect((await getCoverNotes(request(query), context)).status).toBe(400);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("is a 500 without internals when reading fails", async () => {
    notes.loadJobCoverNotes.mockRejectedValue(new Error("timeout on dbo.CoverActions"));
    const failed = await getCoverNotes(request("?jobIds=1"), context);
    expect(failed.status).toBe(500);
    expect(JSON.stringify(failed.jsonBody)).not.toContain("dbo.");
  });
});
