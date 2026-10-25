/// <reference types="jest" />
import { HttpRequest, type InvocationContext } from "@azure/functions";
import { AppRole } from "../auth";
import { labelUsageDevice } from "./labelUsageDevice";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
let roles: string[] = [AppRole.ADMIN];
let token: string | null = "token";
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  errorResponse: (message: string) => ({ jsonBody: { error: message }, status: 500 }),
  extractToken: () => token,
  requireRole: async (_r: unknown, allowed: string[]) => (jest.requireActual("../auth").rolesPassGate(roles, allowed) ? null : { status: 403 }),
}));
jest.mock("../callerFromToken", () => ({ callerFromToken: () => ({ id: "oid", name: "Pat Admin" }) }));
jest.mock("../db", () => ({ closeConnection: jest.fn(), createRequestConnection: jest.fn(async () => ({})), executeQuery: jest.fn(async () => [{ Changed: 1 }]) }));

import { createRequestConnection, executeQuery } from "../db";

const ctx = { error: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown, raw?: string) => new HttpRequest({ body: { string: raw ?? JSON.stringify(body) }, method: "POST", url: "http://localhost/api/labelUsageDevice" });
const DEVICE = "d_abcdefghijklmnop1";
const params = () => Object.fromEntries((jest.mocked(executeQuery).mock.calls[0][2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value]));

beforeEach(() => {
  jest.clearAllMocks();
  roles = [AppRole.ADMIN];
  token = "token";
  jest.mocked(executeQuery).mockResolvedValue([{ Changed: 1 }]);
});

describe("labelUsageDevice", () => {
  it("answers 401 with no token", async () => {
    token = null;
    expect((await labelUsageDevice(post({ deviceId: DEVICE, label: "x" }), ctx)).status).toBe(401);
  });

  it.each([AppRole.DIRECTOR, AppRole.CFO, AppRole.FACILITIES_APPROVAL, AppRole.ACCOUNTS, AppRole.USER])("answers 403 for %s: admin only", async (role) => {
    roles = [role];
    expect((await labelUsageDevice(post({ deviceId: DEVICE, label: "x" }), ctx)).status).toBe(403);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("names a device, trimmed, with the admin's own name, through bound parameters", async () => {
    const response = await labelUsageDevice(post({ deviceId: DEVICE, label: "  Facilities tablet  " }), ctx);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ deviceId: DEVICE, label: "Facilities tablet" });
    expect(params()).toMatchObject({ By: "Pat Admin", DeviceId: DEVICE, Label: "Facilities tablet" });
    expect(String(jest.mocked(executeQuery).mock.calls[0][1])).not.toMatch(/Facilities tablet|Pat Admin/);
  });

  it.each([[""], ["   "], [null]])("clears the name for %p", async (label) => {
    const response = await labelUsageDevice(post({ deviceId: DEVICE, label }), ctx);
    expect(response.jsonBody).toEqual({ deviceId: DEVICE, label: null });
    expect(params().Label).toBeNull();
  });

  it("answers 404 for a device that is not known", async () => {
    jest.mocked(executeQuery).mockResolvedValueOnce([{ Changed: 0 }]);
    expect((await labelUsageDevice(post({ deviceId: DEVICE, label: "x" }), ctx)).status).toBe(404);
  });

  it.each([
    ["a bad device id", { deviceId: "tablet", label: "x" }],
    ["a missing device id", { label: "x" }],
    ["a label that is not text", { deviceId: DEVICE, label: 5 }],
    ["a label over 80 characters", { deviceId: DEVICE, label: "x".repeat(81) }],
    ["a label with a control character", { deviceId: DEVICE, label: "bad\u0007name" }],
  ])("answers 400 for %s, before any query", async (_name, body) => {
    expect((await labelUsageDevice(post(body), ctx)).status).toBe(400);
    expect(createRequestConnection).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON", async () => {
    expect((await labelUsageDevice(post(null, "{nope"), ctx)).status).toBe(400);
  });
});
