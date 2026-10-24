/// <reference types="jest" />
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { closeConnection, createRequestConnection } from "../db";
import { getCoverOverview } from "./getCoverOverview";

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
jest.mock("../absenceCover/view", () => ({ loadLiveView: jest.fn() }));
jest.mock("../absenceCover/overview", () => ({ buildOverview: jest.fn() }));

const access = jest.requireMock("../absenceCover/access") as { requireCoverCaller: jest.Mock };
const view = jest.requireMock("../absenceCover/view") as { loadLiveView: jest.Mock };
const overview = jest.requireMock("../absenceCover/overview") as { buildOverview: jest.Mock };
const context = { error: jest.fn() } as unknown as InvocationContext;
const request = () => new HttpRequest({ method: "GET", url: "http://localhost/api/getCoverOverview" });

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.FACILITIES_APPROVAL];
  token = "token";
  delete process.env.ABSENCE_COVER_ENABLED;
  access.requireCoverCaller.mockResolvedValue({ name: "Max", roles: ["facilities_manager"], userId: 2 });
  view.loadLiveView.mockResolvedValue({ today: "2026-10-26" });
  overview.buildOverview.mockResolvedValue({ away: [], moved: [], suggested: [] });
});

describe("getCoverOverview", () => {
  it("refuses a request with no token", async () => {
    token = null;
    expect((await getCoverOverview(request(), context)).status).toBe(401);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([AppRole.FACILITIES, AppRole.ACCOUNTS, AppRole.USER])("refuses %s before reading anything", async (role) => {
    roles = [role];
    expect((await getCoverOverview(request(), context)).status).toBe(403);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR, AppRole.ADMIN])("lets %s see the screen", async (role) => {
    roles = [role];
    expect((await getCoverOverview(request(), context)).status).toBe(200);
  });

  it("answers with the overview for the caller, uncached, in the engine's current mode", async () => {
    process.env.ABSENCE_COVER_ENABLED = "true";
    const response = await getCoverOverview(request(), context);
    expect(response.jsonBody).toEqual({ away: [], moved: [], suggested: [] });
    expect(response.headers).toEqual({ "Cache-Control": "no-store" });
    expect(overview.buildOverview).toHaveBeenCalledWith({}, { name: "Max", roles: ["facilities_manager"], userId: 2 }, { today: "2026-10-26" }, "live");
    expect(closeConnection).toHaveBeenCalled();
  });

  it("is a 500 that names nothing internal when reading fails, and still closes the connection", async () => {
    view.loadLiveView.mockRejectedValue(new Error("SQL timeout at dbo.Secret"));
    const response = await getCoverOverview(request(), context);
    expect(response.status).toBe(500);
    expect(JSON.stringify(response.jsonBody)).not.toContain("dbo.Secret");
    expect(closeConnection).toHaveBeenCalled();
  });

  it("answers a person with no staff record in words, with its status", async () => {
    const { CoverError } = jest.requireActual("../absenceCover/errors");
    access.requireCoverCaller.mockRejectedValue(new CoverError("no_staff_record", "An active staff record is required.", 422));
    const response = await getCoverOverview(request(), context);
    expect(response).toMatchObject({ jsonBody: { code: "no_staff_record", error: "An active staff record is required." }, status: 422 });
  });
});
