/// <reference types="jest" />

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("token"),
  oidFromToken: jest.fn().mockReturnValue("admin-oid"),
  requireRole: jest.fn().mockResolvedValue(null),
  verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "w@rp", name: "Will Admin", oid: "admin-oid" }),
}));
jest.mock("../myob-auth-state", () => ({ createAuthState: jest.fn().mockResolvedValue("state-xyz") }));

import type { HttpRequest, InvocationContext } from "@azure/functions";
import { myobAuthStart } from "./myobAuthStart";

const auth = require("../auth") as Record<string, jest.Mock>;
const { createAuthState } = require("../myob-auth-state") as { createAuthState: jest.Mock };
const ctx = {} as InvocationContext;
const request = {} as HttpRequest;
const original = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MYOB_CLIENT_ID = "client";
  process.env.MYOB_REDIRECT_URI = "https://example.test/cb";
});

afterAll(() => {
  process.env = original;
});

describe("myobAuthStart", () => {
  it("binds a new state to the verified admin and returns the authorize URL with the fixed scopes", async () => {
    const res = await myobAuthStart(request, ctx);

    expect(res.status).toBe(200);
    expect(createAuthState).toHaveBeenCalledWith({ name: "Will Admin", oid: "admin-oid" });
    const url = new URL((res.jsonBody as { authorizeUrl: string }).authorizeUrl);
    expect(url.searchParams.get("state")).toBe("state-xyz");
    expect(url.searchParams.get("scope")).toBe("sme-company-file sme-purchases");
    expect(url.searchParams.get("prompt")).toBe("consent");
  });

  it("401s, minting no state, when the token does not verify", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValueOnce(null);

    expect((await myobAuthStart(request, ctx)).status).toBe(401);
    expect(createAuthState).not.toHaveBeenCalled();
  });

  it("returns the role check's 403 for a non-admin", async () => {
    auth.requireRole.mockResolvedValueOnce({ status: 403 });

    expect((await myobAuthStart(request, ctx)).status).toBe(403);
    expect(createAuthState).not.toHaveBeenCalled();
  });
});
