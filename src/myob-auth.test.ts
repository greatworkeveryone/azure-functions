/// <reference types="jest" />

jest.mock("./db", () => ({
  closeConnection: jest.fn(),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));
jest.mock("./myob-api-log", () => ({
  ...jest.requireActual("./myob-api-log"),
  myobRequest: jest.fn(),
}));

import { exchangeCodeForTokens, getValidMyobAccessToken } from "./myob-auth";
import type { MyobActor } from "./myob-api-log";

const db = require("./db") as { executeQuery: jest.Mock };
const { myobRequest } = require("./myob-api-log") as { myobRequest: jest.Mock };

const ACTOR: MyobActor = { kind: "user", name: "Admin", oid: "admin-oid", role: "admin" };
const SYSTEM: MyobActor = { kind: "system", name: "myobAuthCallback" };
const CORRELATION = "9b1f2c34-5d6e-4f70-8a91-0b2c3d4e5f60";
const tokenResponse = (over: Record<string, unknown> = {}) => ({
  json: () => ({ access_token: "new-access", expires_in: 1200, refresh_token: "new-refresh", scope: "sme-company-file" }),
  ok: true,
  status: 200,
  text: "",
  ...over,
});

function storedRow(expiresInMs: number) {
  return {
    AccessToken: "old-access",
    AuthorizedAt: new Date(),
    AuthorizedBy: "x",
    ExpiresAt: new Date(Date.now() + expiresInMs),
    RefreshToken: "old-refresh",
    Scope: "s",
  };
}

const original = { ...process.env };

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MYOB_CLIENT_ID = "client-id";
  process.env.MYOB_CLIENT_SECRET = "client-secret";
  process.env.MYOB_REDIRECT_URI = "https://example.test/cb";
  myobRequest.mockResolvedValue(tokenResponse());
});

afterAll(() => {
  process.env = original;
});

describe("getValidMyobAccessToken", () => {
  it("returns a still-valid stored token without any MYOB call", async () => {
    db.executeQuery.mockResolvedValue([storedRow(10 * 60_000)]);

    await expect(getValidMyobAccessToken(null, ACTOR)).resolves.toBe("old-access");

    expect(myobRequest).not.toHaveBeenCalled();
  });

  it("refreshes an expiring token through myobRequest as the given actor", async () => {
    db.executeQuery.mockResolvedValue([storedRow(1_000)]);

    await expect(getValidMyobAccessToken("sql-token", ACTOR)).resolves.toBe("new-access");

    const req = myobRequest.mock.calls[0][0];
    expect(req).toMatchObject({ actor: ACTOR, method: "POST", purpose: "oauth-token-refresh", url: "https://secure.myob.com/oauth2/v1/authorize/" });
    expect(req.body).toBeInstanceOf(URLSearchParams);
    expect(req.body.get("grant_type")).toBe("refresh_token");
    expect(req.body.get("refresh_token")).toBe("old-refresh");
  });

  it("uses a supplied correlationId for the refresh call", async () => {
    db.executeQuery.mockResolvedValue([storedRow(1_000)]);

    await getValidMyobAccessToken(null, ACTOR, CORRELATION);

    expect(myobRequest.mock.calls[0][0].correlationId).toBe(CORRELATION);
  });

  it("leaves the correlationId unset when none is supplied, so myobRequest generates one", async () => {
    db.executeQuery.mockResolvedValue([storedRow(1_000)]);

    await getValidMyobAccessToken(null, SYSTEM);

    expect(myobRequest.mock.calls[0][0].correlationId).toBeUndefined();
  });

  it("throws when the token endpoint refuses the refresh", async () => {
    db.executeQuery.mockResolvedValue([storedRow(1_000)]);
    myobRequest.mockResolvedValue(tokenResponse({ ok: false, status: 400, text: "invalid_grant" }));

    await expect(getValidMyobAccessToken(null, ACTOR)).rejects.toThrow("MYOB token endpoint 400: invalid_grant");
  });
});

describe("exchangeCodeForTokens", () => {
  it("exchanges the code through myobRequest as the given actor and stores the tokens", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      /FROM dbo\.MyobAuth/.test(sql) ? [storedRow(10 * 60_000)] : [],
    );

    const status = await exchangeCodeForTokens({
      actor: SYSTEM,
      authorizedBy: null,
      code: "auth-code",
      correlationId: CORRELATION,
      sqlToken: null,
    });

    const req = myobRequest.mock.calls[0][0];
    expect(req).toMatchObject({ actor: SYSTEM, correlationId: CORRELATION, method: "POST", purpose: "oauth-token-exchange" });
    expect(req.body.get("code")).toBe("auth-code");
    expect(req.body.get("grant_type")).toBe("authorization_code");
    expect(db.executeQuery.mock.calls.some((c: unknown[]) => /MERGE dbo\.MyobAuth/.test(String(c[1])))).toBe(true);
    expect(status.linked).toBe(true);
  });

  it("leaves the correlationId unset when none is supplied", async () => {
    db.executeQuery.mockResolvedValue([storedRow(10 * 60_000)]);

    await exchangeCodeForTokens({ actor: SYSTEM, authorizedBy: null, code: "c", sqlToken: null });

    expect(myobRequest.mock.calls[0][0].correlationId).toBeUndefined();
  });

  it("stores nothing when the exchange fails", async () => {
    myobRequest.mockResolvedValue(tokenResponse({ ok: false, status: 400, text: "bad code" }));

    await expect(
      exchangeCodeForTokens({ actor: SYSTEM, authorizedBy: null, code: "c", sqlToken: null }),
    ).rejects.toThrow("MYOB token endpoint 400: bad code");

    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});
