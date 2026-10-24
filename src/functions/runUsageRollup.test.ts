/// <reference types="jest" />
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { runUsageRollup } from "./runUsageRollup";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.ADMIN];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: (message: string) => ({ jsonBody: { error: message }, status: 500 }),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
}));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})) }));
jest.mock("../usage/rollup", () => ({ ...jest.requireActual("../usage/rollup"), rollUpDays: jest.fn(async () => ({ days: 7, inserted: 3, updated: 1 })) }));

import { createRequestConnection } from "../db";
import { rollUpDays } from "../usage/rollup";

const ctx = { error: jest.fn() } as unknown as InvocationContext;
const post = (raw = "") => new HttpRequest({ body: { string: raw }, method: "POST", url: "http://localhost/api/runUsageRollup" });

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.ADMIN];
  token = "token";
});

describe("runUsageRollup", () => {
  it("answers 401 with no token", async () => {
    token = null;
    expect((await runUsageRollup(post(), ctx)).status).toBe(401);
  });

  it.each([AppRole.DIRECTOR, AppRole.CFO, AppRole.ACCOUNTS_APPROVAL, AppRole.USER])("answers 403 for %s: admin only", async (role) => {
    roles = [role];
    expect((await runUsageRollup(post(), ctx)).status).toBe(403);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("rolls up the last seven days when no days are given", async () => {
    const response = await runUsageRollup(post(), ctx);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ days: 7, inserted: 3, updated: 1 });
    const [, from, to] = jest.mocked(rollUpDays).mock.calls[0];
    expect(from < to).toBe(true);
  });

  it("rolls up the days it is given", async () => {
    const today = new Date(Date.now() + 9.5 * 3600_000).toISOString().slice(0, 10);
    await runUsageRollup(post(JSON.stringify({ from: today, to: today })), ctx);
    expect(jest.mocked(rollUpDays).mock.calls[0].slice(1)).toEqual([today, today]);
  });

  it.each([
    ["from only", { from: "2026-10-01" }],
    ["dates out of order", { from: "2026-10-05", to: "2026-10-01" }],
    ["a day in the future", { from: "2099-01-01", to: "2099-01-02" }],
    ["a span over a year", { from: "2020-01-01", to: "2026-10-01" }],
    ["dates that are not real", { from: "2026-02-30", to: "2026-03-01" }],
  ])("answers 400 for %s, before any query", async (_name, body) => {
    expect((await runUsageRollup(post(JSON.stringify(body)), ctx)).status).toBe(400);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON", async () => {
    expect((await runUsageRollup(post("{no"), ctx)).status).toBe(400);
  });
});
