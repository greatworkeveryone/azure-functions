/// <reference types="jest" />
import {
  clearServiceTokenCache,
  createRequestConnection,
  createServiceConnection,
  requestConnectionToken,
  requestTokenSource,
} from "./db";

// Mocked so createRequestConnection/createServiceConnection can run through
// their real connect flow without touching a real socket.
jest.mock("tedious", () => {
  const actual = jest.requireActual("tedious");
  return {
    ...actual,
    Connection: jest.fn().mockImplementation(function mockConnection() {
      const conn: Record<string, unknown> = {};
      conn.on = jest.fn((event: string, cb: (err?: unknown) => void) => {
        if (event === "connect") setImmediate(() => cb());
        return conn;
      });
      conn.connect = jest.fn();
      conn.close = jest.fn();
      return conn;
    }),
  };
});

function mockTokenResponse(accessToken: string): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ access_token: accessToken, expires_in: 3600 }),
  }) as unknown as typeof fetch;
}

const originalFetch = global.fetch;

afterAll(() => {
  global.fetch = originalFetch;
});

beforeEach(() => {
  jest.clearAllMocks();
  clearServiceTokenCache();
  delete process.env.SQL_USER_CONNECTION;
  process.env.GRAPH_TENANT_ID = "tenant";
  process.env.GRAPH_CLIENT_ID = "client";
  process.env.GRAPH_CLIENT_SECRET = "secret";
  // Every test starts with a fresh fetch mock, so an assertion like
  // `expect(global.fetch).not.toHaveBeenCalled()` is never true only because
  // an earlier test happened to replace global.fetch first.
  mockTokenResponse("service-token");
});

describe("requestTokenSource", () => {
  it("defaults to the service identity", () => {
    expect(requestTokenSource()).toBe("service");
  });

  it("returns 'user' only when SQL_USER_CONNECTION is exactly 'true'", () => {
    process.env.SQL_USER_CONNECTION = "true";
    expect(requestTokenSource()).toBe("user");
  });

  it("ignores other truthy-looking values", () => {
    process.env.SQL_USER_CONNECTION = "1";
    expect(requestTokenSource()).toBe("service");
  });
});

describe("requestConnectionToken", () => {
  it("returns the service token, not the caller's, by default", async () => {
    mockTokenResponse("service-token");
    await expect(requestConnectionToken("caller-token")).resolves.toBe(
      "service-token",
    );
  });

  it("returns the caller's token when the rollback flag is set", async () => {
    process.env.SQL_USER_CONNECTION = "true";
    await expect(requestConnectionToken("caller-token")).resolves.toBe(
      "caller-token",
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("caches the service token across calls", async () => {
    mockTokenResponse("service-token");
    await requestConnectionToken("caller-token");
    await requestConnectionToken("caller-token");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("de-dupes concurrent service-token fetches onto one request", async () => {
    mockTokenResponse("service-token");
    const [a, b, c] = await Promise.all([
      requestConnectionToken("caller"),
      requestConnectionToken("caller"),
      requestConnectionToken("caller"),
    ]);
    expect([a, b, c]).toEqual(["service-token", "service-token", "service-token"]);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed token fetch", async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 429, text: async () => "throttled" })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "later", expires_in: 3600 }) }) as unknown as typeof fetch;
    await expect(requestConnectionToken("caller")).rejects.toThrow();
    await expect(requestConnectionToken("caller")).resolves.toBe("later");
  });
});

describe("createRequestConnection", () => {
  it("returns a fresh connection, never the createServiceConnection() singleton", async () => {
    process.env.SQL_SERVER = "test-server";
    process.env.SQL_DATABASE = "test-db";

    const singleton = await createServiceConnection();
    const requestConnA = await createRequestConnection("caller-token");
    const requestConnB = await createRequestConnection("caller-token");

    expect(requestConnA).not.toBe(singleton);
    expect(requestConnB).not.toBe(singleton);
    expect(requestConnA).not.toBe(requestConnB);
  });
});
