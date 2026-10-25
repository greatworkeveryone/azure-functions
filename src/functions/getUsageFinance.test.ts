/// <reference types="jest" />
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { getUsageFinance } from "./getUsageFinance";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.CFO];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: (message: string) => ({ jsonBody: { error: message }, status: 500 }),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
  rolesForRequest: async () => roles,
}));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})) }));
jest.mock("../usage/queries/finance", () => ({
  loadUsageFinance: jest.fn(async (_c: unknown, _p: unknown, filter: unknown) => ({ filter })),
  roleOfUser: jest.fn(async () => "accounts"),
}));

import { createRequestConnection } from "../db";
import { loadUsageFinance, roleOfUser } from "../usage/queries/finance";

const ctx = { error: jest.fn() } as unknown as InvocationContext;
const get = (qs = "") => new HttpRequest({ method: "GET", url: `http://localhost/api/getUsageFinance${qs}` });
const filterSent = () => jest.mocked(loadUsageFinance).mock.calls[0][2];

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.CFO];
  token = "token";
  jest.mocked(roleOfUser).mockResolvedValue("accounts");
});

describe("getUsageFinance: who may call it", () => {
  it("answers 401 with no token", async () => {
    token = null;
    expect((await getUsageFinance(get(), ctx)).status).toBe(401);
  });

  it.each([AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.ACCOUNTS_APPROVAL, AppRole.USER])("answers 403 for %s, before any query", async (role) => {
    roles = [role];
    expect((await getUsageFinance(get(), ctx)).status).toBe(403);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it.each([
    [AppRole.CFO, "finance"],
    [AppRole.ADMIN, "all"],
    [AppRole.DIRECTOR, "all"],
  ])("lets %s in with the %s scope", async (role, scope) => {
    roles = [role];
    expect((await getUsageFinance(get(), ctx)).status).toBe(200);
    expect(filterSent()).toMatchObject({ scope });
  });
});

describe("getUsageFinance: the CFO's scope holds whatever is asked", () => {
  it.each(["facilities", "facilities_manager", "director", "user"])("refuses role=%s with 403 and reads nothing", async (role) => {
    expect((await getUsageFinance(get(`?role=${role}`), ctx)).status).toBe(403);
    expect(loadUsageFinance).not.toHaveBeenCalled();
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it.each(["accounts", "accounts_manager", "cfo", "admin"])("allows role=%s", async (role) => {
    expect((await getUsageFinance(get(`?role=${role}`), ctx)).status).toBe(200);
    expect(filterSent()).toMatchObject({ role });
  });

  it.each([null, "facilities", "facilities_manager", "director", "user"])("refuses a userId whose role is %p with 403 and reads no figures", async (role) => {
    jest.mocked(roleOfUser).mockResolvedValue(role);
    expect((await getUsageFinance(get("?userId=44"), ctx)).status).toBe(403);
    expect(loadUsageFinance).not.toHaveBeenCalled();
  });

  it("allows a userId whose role is in scope, and sends it on", async () => {
    expect((await getUsageFinance(get("?userId=12"), ctx)).status).toBe(200);
    expect(filterSent()).toMatchObject({ scope: "finance", userId: 12 });
  });

  it("does not let admin and directors' wider scope leak to the CFO when she also sends a role they could ask for", async () => {
    roles = [AppRole.CFO];
    expect((await getUsageFinance(get("?role=facilities&userId=12"), ctx)).status).toBe(403);
  });

  it("lets admin and directors ask for anyone", async () => {
    roles = [AppRole.DIRECTOR];
    expect((await getUsageFinance(get("?role=facilities"), ctx)).status).toBe(200);
    jest.mocked(roleOfUser).mockResolvedValue("facilities");
    expect((await getUsageFinance(get("?userId=44"), ctx)).status).toBe(200);
  });
});

describe("getUsageFinance: malformed requests", () => {
  it.each(["?role=boss", "?userId=abc", "?userId=0", "?userId=1.5", "?days=0", "?from=2026-10-01"])("answers 400 for %s", async (qs) => {
    expect((await getUsageFinance(get(qs), ctx)).status).toBe(400);
    expect(loadUsageFinance).not.toHaveBeenCalled();
  });
});
