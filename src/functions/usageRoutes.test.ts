/// <reference types="jest" />
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { ACTION_ROLES, exportActionRoles } from "../action-roles";
import { AppRole } from "../auth";
import { getUsageAi } from "./getUsageAi";
import { getUsageDevices } from "./getUsageDevices";
import { getUsageEmail } from "./getUsageEmail";
import { getUsageModules } from "./getUsageModules";
import { getUsageOverview } from "./getUsageOverview";
import { getUsagePeople } from "./getUsagePeople";
import { getUsageStatus } from "./getUsageStatus";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.ADMIN];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: (message: string) => ({ jsonBody: { error: message }, status: 500 }),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
  rolesForRequest: async () => roles,
}));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})), executeQuery: jest.fn(async () => []) }));
jest.mock("../usage/queries/overview", () => ({ loadUsageOverview: jest.fn(async () => ({ view: "overview" })) }));
jest.mock("../usage/queries/people", () => ({ loadUsagePeople: jest.fn(async () => []) }));
jest.mock("../usage/queries/devices", () => ({ loadUsageDevices: jest.fn(async () => ({ view: "devices" })) }));
jest.mock("../usage/queries/modules", () => ({ loadUsageModules: jest.fn(async () => ({ view: "modules" })) }));
jest.mock("../usage/queries/email", () => ({ loadUsageEmail: jest.fn(async () => ({ view: "email" })) }));
jest.mock("../usage/queries/ai", () => ({ loadUsageAi: jest.fn(async () => ({ view: "ai" })) }));

import { createRequestConnection } from "../db";

type Handler = (request: HttpRequest, context: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
const ROUTES: [string, Handler][] = [
  ["getUsageOverview", getUsageOverview],
  ["getUsagePeople", getUsagePeople],
  ["getUsageDevices", getUsageDevices],
  ["getUsageModules", getUsageModules],
  ["getUsageEmail", getUsageEmail],
  ["getUsageAi", getUsageAi],
];
const ctx = { error: jest.fn() } as unknown as InvocationContext;
const get = (name: string, qs = "") => new HttpRequest({ method: "GET", url: `http://localhost/api/${name}${qs}` });

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.ADMIN];
  token = "token";
});

describe("the capabilities", () => {
  it("list every analytics route, admin and director only", () => {
    expect([...ACTION_ROLES.viewUsageAnalytics.routes].sort()).toEqual(ROUTES.map(([name]) => name).sort());
    expect(exportActionRoles().viewUsageAnalytics).toEqual([AppRole.ADMIN, AppRole.DIRECTOR]);
    expect(exportActionRoles().viewFinanceUsageAnalytics).toEqual([AppRole.ADMIN, AppRole.CFO, AppRole.DIRECTOR]);
    expect(exportActionRoles().manageUsageAnalytics).toEqual([AppRole.ADMIN]);
  });
});

describe.each(ROUTES)("%s", (name, handler) => {
  it("answers 401 with no token, before any query", async () => {
    token = null;
    expect((await handler(get(name), ctx)).status).toBe(401);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.USER])("answers 403 for %s, before any query", async (role) => {
    roles = [role];
    expect((await handler(get(name), ctx)).status).toBe(403);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("answers 403 for the CFO: she has the Finance view, not this one", async () => {
    roles = [AppRole.CFO];
    expect((await handler(get(name), ctx)).status).toBe(403);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([AppRole.ADMIN, AppRole.DIRECTOR])("lets %s in and asks for no store", async (role) => {
    roles = [role];
    const response = await handler(get(name, "?days=30"), ctx);
    expect(response.status).toBe(200);
  });

  it.each(["?days=0", "?days=999", "?from=2026-10-01", "?from=bad&to=worse"])("answers 400 for the period %s, before any query", async (qs) => {
    expect((await handler(get(name, qs), ctx)).status).toBe(400);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("getUsageStatus", () => {
  const ENV = process.env.USAGE_TRACKING_ENABLED;
  afterAll(() => {
    if (ENV === undefined) delete process.env.USAGE_TRACKING_ENABLED;
    else process.env.USAGE_TRACKING_ENABLED = ENV;
  });

  it.each(Object.values(AppRole))("tells %s whether usage is recorded, from the switch alone", async (role) => {
    roles = [role];
    process.env.USAGE_TRACKING_ENABLED = "true";
    expect((await getUsageStatus(get("getUsageStatus"), ctx)).jsonBody).toEqual({ trackingEnabled: true });
    delete process.env.USAGE_TRACKING_ENABLED;
    expect((await getUsageStatus(get("getUsageStatus"), ctx)).jsonBody).toEqual({ trackingEnabled: false });
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("answers 401 with no token and 403 with no role", async () => {
    token = null;
    expect((await getUsageStatus(get("getUsageStatus"), ctx)).status).toBe(401);
    token = "token";
    roles = [];
    expect((await getUsageStatus(get("getUsageStatus"), ctx)).status).toBe(403);
  });
});
