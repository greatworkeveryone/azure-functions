/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    requireRole:       jest.fn().mockResolvedValue(null),
    rolesForRequest:   jest.fn().mockResolvedValue(["admin"]),
    extractToken:      jest.fn().mockReturnValue("mock-token"),
    oidFromToken:      jest.fn().mockReturnValue("caller-oid-123"),
    userInfoFromToken: jest.fn().mockReturnValue({ name: "Test User", email: "test@co.com" }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({
      oid: "caller-oid-123",
      name: "Test User",
      email: "test@co.com",
    }),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    errorResponse:     jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
  };
});

jest.mock("../db", () => ({
  closeConnection:         jest.fn(),
  createConnection:        jest.fn(),
  createServiceConnection: jest.fn(),
  executeQuery:            jest.fn(),
}));

const auth = require("../auth") as {
  requireRole:                 jest.Mock;
  rolesForRequest:             jest.Mock;
  extractToken:                jest.Mock;
  oidFromToken:                jest.Mock;
  verifiedIdentityFromRequest: jest.Mock;
  AppRole:                     typeof import("../auth").AppRole;
};

const db = require("../db") as {
  closeConnection:         jest.Mock;
  createServiceConnection: jest.Mock;
  executeQuery:            jest.Mock;
};

function makeRequest(body: unknown, headers: Record<string, string> = {}): HttpRequest {
  return {
    json:    jest.fn().mockResolvedValue(body),
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  } as unknown as HttpRequest;
}

const ctx = { error: jest.fn(), log: jest.fn() } as unknown as InvocationContext;

// Import after mocks are set up
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { upsertAppUser, registerSelf } = require("./users") as {
  upsertAppUser: (req: HttpRequest, ctx: InvocationContext) => Promise<{ status: number; jsonBody?: unknown }>;
  registerSelf:  (req: HttpRequest, ctx: InvocationContext) => Promise<{ status: number; jsonBody?: unknown }>;
};

beforeEach(() => {
  jest.clearAllMocks();
  db.createServiceConnection.mockResolvedValue({});
  db.closeConnection.mockImplementation(() => undefined);
  auth.verifiedIdentityFromRequest.mockResolvedValue({
    oid: "caller-oid-123",
    name: "Test User",
    email: "test@co.com",
  });
});

describe("upsertAppUser", () => {
  it("creates a pre-invite with email + role only (no OID)", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    auth.requireRole.mockResolvedValue(null);
    db.executeQuery
      .mockResolvedValueOnce([{ DisplayName: "Admin User" }])
      .mockResolvedValueOnce([{ UserID: 99 }])
      .mockResolvedValueOnce([]);

    const req = makeRequest({ email: "jane@co.com", role: "facilities" });
    const res = await upsertAppUser(req, ctx);

    expect(res.status).toBe(201);
  });

  it("rejects when a director tries to assign the admin role", async () => {
    auth.rolesForRequest.mockResolvedValue(["director"]);
    auth.requireRole.mockResolvedValue(null);

    const req = makeRequest({ email: "someone@co.com", role: "admin" });
    const res = await upsertAppUser(req, ctx);

    expect(res.status).toBe(403);
  });

  it("allows a director to assign a non-admin role", async () => {
    auth.rolesForRequest.mockResolvedValue(["director"]);
    auth.requireRole.mockResolvedValue(null);
    db.executeQuery
      .mockResolvedValueOnce([{ DisplayName: "Director User" }])
      .mockResolvedValueOnce([{ UserID: 55 }])
      .mockResolvedValueOnce([]);

    const req = makeRequest({ email: "newbie@co.com", role: "facilities" });
    const res = await upsertAppUser(req, ctx);

    expect(res.status).toBe(201);
  });

  it("writes an audit log row on role change", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    auth.requireRole.mockResolvedValue(null);
    db.executeQuery
      .mockResolvedValueOnce([{ DisplayName: "Admin User" }])
      .mockResolvedValueOnce([{ Role: "user", Email: "x@co.com" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const req = makeRequest({ userId: 7, email: "x@co.com", role: "facilities" });
    const res = await upsertAppUser(req, ctx);

    expect(res.status).toBe(200);
    const auditCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("UserRoleAudit"),
    );
    expect(auditCall).toBeDefined();
  });

  it("returns 400 when email is missing", async () => {
    auth.requireRole.mockResolvedValue(null);

    const req = makeRequest({ role: "facilities" });
    const res = await upsertAppUser(req, ctx);

    expect(res.status).toBe(400);
  });
});

describe("registerSelf", () => {
  function makeJwt(payload: Record<string, unknown>): string {
    const encode = (obj: unknown) =>
      Buffer.from(JSON.stringify(obj)).toString("base64url");
    return `h.${encode(payload)}.sig`;
  }

  function makeAuthReq(appTokenPayload: Record<string, unknown>): HttpRequest {
    const appToken = makeJwt(appTokenPayload);
    return makeRequest(null, {
      authorization: "Bearer sql-token",
      "x-app-token": appToken,
    });
  }

  it("returns role for an existing user matched by OID", async () => {
    db.executeQuery.mockResolvedValueOnce([{ UserID: 1, Role: "facilities" }]);

    const req = makeAuthReq({ name: "Jane", preferred_username: "jane@co.com" });
    const res = await registerSelf(req, ctx);

    expect(res.status).toBe(200);
    expect((res.jsonBody as { role: string }).role).toBe("facilities");
  });

  it("claims a pre-invite by email when OID has no match", async () => {
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ UserID: 5, Role: "accounts" }])
      .mockResolvedValueOnce([]);

    const req = makeAuthReq({ name: "Jane", preferred_username: "jane@co.com" });
    const res = await registerSelf(req, ctx);

    expect(res.status).toBe(200);
    expect((res.jsonBody as { role: string }).role).toBe("accounts");
    const updateCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("UPDATE") && sql.includes("EntraOid"),
    );
    expect(updateCall).toBeDefined();
  });

  it("creates a pending user (role: null) when no OID or email match", async () => {
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ UserID: 99 }]);

    const req = makeAuthReq({ name: "New Guy", preferred_username: "new@co.com" });
    const res = await registerSelf(req, ctx);

    expect(res.status).toBe(200);
    expect((res.jsonBody as { role: null }).role).toBeNull();
  });
});
