/// <reference types="jest" />

jest.mock("./db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("./myob-api-log", () => ({
  ...jest.requireActual("./myob-api-log"),
  myobRequest: jest.fn(),
}));

import { randomBytes } from "crypto";
import {
  assertGrantedScope,
  buildAuthorizeUrl,
  exchangeCode,
  getMyobAuthStatus,
  getValidMyobAccessToken,
  MyobRelinkRequiredError,
  MyobScopeError,
} from "./myob-auth";
import type { MyobActor } from "./myob-api-log";
import { sealSecret } from "./myob-token-crypto";

const db = require("./db") as Record<string, jest.Mock>;
const { myobRequest } = require("./myob-api-log") as { myobRequest: jest.Mock };

const ACTOR: MyobActor = { kind: "user", name: "Admin", oid: "admin-oid", role: "admin" };
const CORRELATION = "9b1f2c34-5d6e-4f70-8a91-0b2c3d4e5f60";
const original = { ...process.env };

const tokenResponse = (over: Record<string, unknown> = {}, body: Record<string, unknown> = {}) => ({
  json: () => ({ access_token: "new-access", expires_in: "1200", refresh_token: "new-refresh", scope: "sme-company-file sme-purchases", ...body }),
  ok: true,
  status: 200,
  text: "",
  ...over,
});

function storedRow(expiresInMs: number, tokens = { a: "old-access", r: "old-refresh" }) {
  const sealed = sealSecret(JSON.stringify(tokens), "dbo.MyobAuth#1");
  return {
    AuthorizedAt: new Date(),
    AuthorizedBy: "x",
    BusinessId: "cf",
    CompanyFileName: null,
    ExpiresAt: new Date(Date.now() + expiresInMs),
    LinkedByName: "Will Admin",
    LinkedByOid: "admin-oid",
    MyobUserUid: "u",
    MyobUsername: "floorplan@rp",
    Scope: "sme-company-file sme-purchases",
    TokenCiphertext: sealed.ciphertext,
    TokenKeyVersion: sealed.keyVersion,
  };
}

const sqlCalls = () => db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1]));

beforeEach(() => {
  jest.clearAllMocks();
  process.env.MYOB_CLIENT_ID = "client-id";
  process.env.MYOB_CLIENT_SECRET = "client-secret";
  process.env.MYOB_REDIRECT_URI = "https://example.test/cb";
  process.env.MYOB_TOKEN_KEY = randomBytes(32).toString("base64");
  delete process.env.MYOB_TOKEN_KEY_VERSION;
  myobRequest.mockResolvedValue(tokenResponse());
});

afterAll(() => {
  process.env = original;
});

describe("authorize URL and scopes", () => {
  it("asks for exactly sme-company-file sme-purchases, with prompt=consent", () => {
    const url = new URL(buildAuthorizeUrl("state-1"));
    expect(url.searchParams.get("scope")).toBe("sme-company-file sme-purchases");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("state")).toBe("state-1");
  });

  it("ignores any MYOB_SCOPE setting: the scope is fixed in code", () => {
    process.env.MYOB_SCOPE = "sme-company-file sme-purchases sme-banking";
    expect(new URL(buildAuthorizeUrl("s")).searchParams.get("scope")).toBe("sme-company-file sme-purchases");
    delete process.env.MYOB_SCOPE;
  });

  it("refuses a token that carries any other scope", () => {
    expect(() => assertGrantedScope("sme-company-file sme-purchases")).not.toThrow();
    expect(() => assertGrantedScope(undefined)).toThrow("MYOB did not say which access it granted");
    expect(() => assertGrantedScope("  ")).toThrow(MyobScopeError);
    expect(() => assertGrantedScope("sme-company-file sme-purchases sme-banking")).toThrow(MyobScopeError);
    expect(() => assertGrantedScope("CompanyFile")).toThrow("CompanyFile");
  });
});

describe("exchangeCode", () => {
  it("exchanges through myobRequest as the given actor and stores nothing itself", async () => {
    const tokens = await exchangeCode("auth-code", ACTOR, CORRELATION);

    const req = myobRequest.mock.calls[0][0];
    expect(req).toMatchObject({ actor: ACTOR, correlationId: CORRELATION, method: "POST", purpose: "oauth-token-exchange" });
    expect(req.body.get("code")).toBe("auth-code");
    expect(req.body.get("scope")).toBe("sme-company-file sme-purchases");
    expect(tokens.access_token).toBe("new-access");
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("throws on a refused exchange and on extra scopes", async () => {
    myobRequest.mockResolvedValueOnce(tokenResponse({ ok: false, status: 400, text: "bad code" }));
    await expect(exchangeCode("c", ACTOR)).rejects.toThrow("MYOB token endpoint 400: bad code");
    myobRequest.mockResolvedValueOnce(tokenResponse({}, { scope: "sme-company-file sme-purchases sme-contacts-supplier" }));
    await expect(exchangeCode("c", ACTOR)).rejects.toBeInstanceOf(MyobScopeError);
  });
});

describe("getValidMyobAccessToken", () => {
  it("decrypts and returns a still-valid token without any MYOB call or lock", async () => {
    db.executeQuery.mockResolvedValue([storedRow(10 * 60_000)]);

    await expect(getValidMyobAccessToken(null, ACTOR)).resolves.toBe("old-access");

    expect(myobRequest).not.toHaveBeenCalled();
    expect(sqlCalls().some((sql) => /sp_getapplock/.test(sql))).toBe(false);
  });

  it("refreshes under sp_getapplock('myob_refresh'), re-reading the row under the lock", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      /sp_getapplock/.test(sql) ? [{ LockResult: 0 }] : /FROM dbo\.MyobAuth/.test(sql) ? [storedRow(1_000)] : [],
    );

    await expect(getValidMyobAccessToken("sql-token", ACTOR, CORRELATION)).resolves.toBe("new-access");

    const sql = sqlCalls();
    const lockAt = sql.findIndex((s) => /sp_getapplock @Resource = N'myob_refresh'/.test(s));
    expect(lockAt).toBeGreaterThan(0);
    expect(sql.slice(lockAt + 1).some((s) => /FROM dbo\.MyobAuth/.test(s))).toBe(true);
    expect(db.beginTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).toHaveBeenCalled();
    const req = myobRequest.mock.calls[0][0];
    expect(req).toMatchObject({ actor: ACTOR, correlationId: CORRELATION, purpose: "oauth-token-refresh" });
    expect(req.body.get("refresh_token")).toBe("old-refresh");
  });

  it("stores the refreshed tokens encrypted only, blanking the plaintext columns", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      /sp_getapplock/.test(sql) ? [{ LockResult: 0 }] : /FROM dbo\.MyobAuth/.test(sql) ? [storedRow(1_000)] : [],
    );

    await getValidMyobAccessToken(null, ACTOR);

    const update = db.executeQuery.mock.calls.find((c: unknown[]) => /UPDATE dbo\.MyobAuth/.test(String(c[1])));
    expect(String(update[1])).toMatch(/AccessToken = N'', RefreshToken = N''/);
    const written = JSON.stringify(update[2]);
    expect(written).not.toContain("new-access");
    expect(written).not.toContain("new-refresh");
  });

  it("uses the token another caller refreshed while it waited for the lock", async () => {
    let reads = 0;
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (/sp_getapplock/.test(sql)) return [{ LockResult: 1 }];
      if (/FROM dbo\.MyobAuth/.test(sql)) {
        reads += 1;
        return [reads === 1 ? storedRow(1_000) : storedRow(20 * 60_000, { a: "fresh-access", r: "fresh-refresh" })];
      }
      return [];
    });

    await expect(getValidMyobAccessToken(null, ACTOR)).resolves.toBe("fresh-access");
    expect(myobRequest).not.toHaveBeenCalled();
  });

  it("rolls back and throws when the lock can't be taken", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      /sp_getapplock/.test(sql) ? [{ LockResult: -1 }] : [storedRow(1_000)],
    );

    await expect(getValidMyobAccessToken(null, ACTOR)).rejects.toThrow("sp_getapplock returned -1");
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(myobRequest).not.toHaveBeenCalled();
  });

  it("rolls back when MYOB refuses the refresh", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      /sp_getapplock/.test(sql) ? [{ LockResult: 0 }] : [storedRow(1_000)],
    );
    myobRequest.mockResolvedValue(tokenResponse({ ok: false, status: 400, text: "invalid_grant" }));

    await expect(getValidMyobAccessToken(null, ACTOR)).rejects.toThrow("MYOB token endpoint 400: invalid_grant");
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("never reads a legacy plaintext row: it asks for a re-link", async () => {
    db.executeQuery.mockResolvedValue([{ ...storedRow(10 * 60_000), TokenCiphertext: null, TokenKeyVersion: null }]);

    await expect(getValidMyobAccessToken(null, ACTOR)).rejects.toBeInstanceOf(MyobRelinkRequiredError);
    expect(sqlCalls().every((sql) => !/\bAccessToken\b,|SELECT AccessToken/.test(sql))).toBe(true);
  });
});

describe("getMyobAuthStatus", () => {
  it("reports the linked file, MYOB user and who linked it", async () => {
    db.executeQuery.mockResolvedValue([storedRow(10 * 60_000)]);

    await expect(getMyobAuthStatus(null)).resolves.toMatchObject({
      authorizedBy: "Will Admin",
      businessId: "cf",
      linked: true,
      myobUsername: "floorplan@rp",
      relinkReason: null,
    });
  });

  it("reads a legacy plaintext row as not linked, with the reason", async () => {
    db.executeQuery.mockResolvedValue([{ ...storedRow(10 * 60_000), TokenCiphertext: null }]);

    await expect(getMyobAuthStatus(null)).resolves.toMatchObject({
      linked: false,
      relinkReason: "the stored link predates token encryption",
    });
  });
});
