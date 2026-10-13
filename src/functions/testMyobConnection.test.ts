/// <reference types="jest" />

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "a@b.c", name: "Admin User", oid: "admin-oid" }),
  };
});
jest.mock("../myob-auth", () => ({
  MyobNotLinkedError: class extends Error {},
  getValidMyobAccessToken: jest.fn().mockResolvedValue("access-token"),
}));
jest.mock("../myob-api-log", () => ({
  ...jest.requireActual("../myob-api-log"),
  myobRequest: jest.fn(),
}));

import type { HttpRequest, InvocationContext } from "@azure/functions";

const auth = require("../auth") as { verifiedIdentityFromRequest: jest.Mock };
const myobAuth = require("../myob-auth") as { getValidMyobAccessToken: jest.Mock };
const { myobRequest } = require("../myob-api-log") as { myobRequest: jest.Mock };

require("./testMyobConnection");
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
const handler = (app.http.mock.calls.find((c: unknown[]) => c[0] === "testMyobConnection")?.[1] as {
  handler: (r: HttpRequest, c: InvocationContext) => Promise<{ status?: number; jsonBody?: any }>;
}).handler;

const request = { headers: { get: () => null } } as unknown as HttpRequest;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const original = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MYOB_CLIENT_ID = "id";
  process.env.MYOB_CLIENT_SECRET = "secret";
  process.env.MYOB_REDIRECT_URI = "https://example.test/cb";
  process.env.MYOB_COMPANY_FILE_ID = "cf-1";
  myobRequest.mockResolvedValue({
    json: () => [{ Id: "cf-1", Name: "Randazzo Properties" }],
    ok: true,
    status: 200,
    statusText: "OK",
    text: "",
  });
});

afterAll(() => {
  process.env = original;
});

describe("testMyobConnection", () => {
  it("reads the company files through myobRequest as the signed-in admin", async () => {
    const res = await handler(request, ctx);

    expect(res.jsonBody.ok).toBe(true);
    expect(res.jsonBody.configuredFileName).toBe("Randazzo Properties");
    const actor = { kind: "user", name: "Admin User", oid: "admin-oid", role: "admin" };
    expect(myobRequest).toHaveBeenCalledWith(
      expect.objectContaining({ actor, method: "GET", purpose: "test-connection" }),
    );
    expect(myobAuth.getValidMyobAccessToken).toHaveBeenCalledWith("mock-token", actor);
  });

  it("reports a non-2xx from MYOB without throwing", async () => {
    myobRequest.mockResolvedValue({ ok: false, status: 401, statusText: "Unauthorized", text: "token expired" });

    const res = await handler(request, ctx);

    expect(res.jsonBody.ok).toBe(false);
    expect(res.jsonBody.message).toContain("MYOB API 401 Unauthorized: token expired");
  });

  it("401s when the token has no verified identity", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    const res = await handler(request, ctx);

    expect(res.status).toBe(401);
    expect(myobRequest).not.toHaveBeenCalled();
  });
});
