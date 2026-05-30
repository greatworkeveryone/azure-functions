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

jest.mock("../sentry", () => ({
  Sentry: {
    captureMessage:   jest.fn(),
    captureException: jest.fn(),
  },
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

const sentry = require("../sentry") as {
  Sentry: { captureMessage: jest.Mock; captureException: jest.Mock };
};

const rateLimit = require("../rateLimit") as {
  _resetRateLimitForTests: () => void;
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
  rateLimit._resetRateLimitForTests();
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
      .mockResolvedValueOnce([{ DisplayName: "Admin User" }]) // caller lookup
      .mockResolvedValueOnce([])                                // dup-email check
      .mockResolvedValueOnce([{ UserID: 99 }])                  // INSERT
      .mockResolvedValueOnce([]);                               // audit

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
      .mockResolvedValueOnce([])
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
      .mockResolvedValueOnce([{ Role: "user", Email: "x@co.com", EntraOid: "target-oid" }])
      .mockResolvedValueOnce([]) // UPDATE
      .mockResolvedValueOnce([]); // audit

    const req = makeRequest({ userId: 7, role: "facilities" });
    const res = await upsertAppUser(req, ctx);

    expect(res.status).toBe(200);
    const auditCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("UserRoleAudit"),
    );
    expect(auditCall).toBeDefined();
  });

  it("returns 400 when email is missing on insert", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    auth.requireRole.mockResolvedValue(null);
    db.executeQuery.mockResolvedValueOnce([{ DisplayName: "Admin User" }]);

    const req = makeRequest({ role: "facilities" });
    const res = await upsertAppUser(req, ctx);

    expect(res.status).toBe(400);
  });

  it("returns 400 when email format is invalid on insert", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    auth.requireRole.mockResolvedValue(null);
    db.executeQuery.mockResolvedValueOnce([{ DisplayName: "Admin User" }]);

    const req = makeRequest({ email: "not-an-email", role: "facilities" });
    const res = await upsertAppUser(req, ctx);

    expect(res.status).toBe(400);
  });

  it("returns 409 when an active row with the same email already exists", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    auth.requireRole.mockResolvedValue(null);
    db.executeQuery
      .mockResolvedValueOnce([{ DisplayName: "Admin User" }])
      .mockResolvedValueOnce([{ Hit: 1 }]);

    const req = makeRequest({ email: "dup@co.com", role: "facilities" });
    const res = await upsertAppUser(req, ctx);

    expect(res.status).toBe(409);
  });

  it("rejects updates that try to rewrite email", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    auth.requireRole.mockResolvedValue(null);
    db.executeQuery.mockResolvedValueOnce([{ DisplayName: "Admin User" }]);

    const req = makeRequest({ userId: 7, email: "new@co.com", role: "facilities" });
    const res = await upsertAppUser(req, ctx);

    expect(res.status).toBe(400);
  });

  it("rejects updates that try to rewrite displayName", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    auth.requireRole.mockResolvedValue(null);
    db.executeQuery.mockResolvedValueOnce([{ DisplayName: "Admin User" }]);

    const req = makeRequest({ userId: 7, displayName: "New Name", role: "facilities" });
    const res = await upsertAppUser(req, ctx);

    expect(res.status).toBe(400);
  });

  it("UPDATE SET clause only touches Role and IsActive", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    auth.requireRole.mockResolvedValue(null);
    db.executeQuery
      .mockResolvedValueOnce([{ DisplayName: "Admin User" }])
      .mockResolvedValueOnce([{ Role: "user", Email: "x@co.com", EntraOid: "target-oid" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const req = makeRequest({ userId: 7, role: "facilities", isActive: true });
    await upsertAppUser(req, ctx);

    const updateCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("UPDATE dbo.AppUsers"),
    );
    expect(updateCall).toBeDefined();
    const [, sql] = updateCall as [unknown, string];
    expect(sql).not.toMatch(/SET[\s\S]*Email/);
    expect(sql).not.toMatch(/SET[\s\S]*DisplayName/);
    expect(sql).not.toMatch(/SET[\s\S]*EntraOid/);
    expect(sql).toMatch(/SET[\s\S]*Role/);
    expect(sql).toMatch(/SET[\s\S]*IsActive/);
  });

  it("returns 403 when a non-admin tries to edit an admin user", async () => {
    auth.rolesForRequest.mockResolvedValue(["director"]);
    auth.requireRole.mockResolvedValue(null);
    db.executeQuery
      .mockResolvedValueOnce([{ DisplayName: "Director User" }])
      .mockResolvedValueOnce([{ Role: "admin", Email: "boss@co.com", EntraOid: "boss-oid" }]);

    const req = makeRequest({ userId: 7, isActive: false });
    const res = await upsertAppUser(req, ctx);

    expect(res.status).toBe(403);
  });

  it("returns 403 when the caller tries to edit their own row", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    auth.requireRole.mockResolvedValue(null);
    db.executeQuery
      .mockResolvedValueOnce([{ DisplayName: "Admin User" }])
      .mockResolvedValueOnce([{ Role: "admin", Email: "me@co.com", EntraOid: "caller-oid-123" }]);

    const req = makeRequest({ userId: 7, role: "user" });
    const res = await upsertAppUser(req, ctx);

    expect(res.status).toBe(403);
  });

  it("returns 404 when the target user does not exist", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    auth.requireRole.mockResolvedValue(null);
    db.executeQuery
      .mockResolvedValueOnce([{ DisplayName: "Admin User" }])
      .mockResolvedValueOnce([]);

    const req = makeRequest({ userId: 999, role: "facilities" });
    const res = await upsertAppUser(req, ctx);

    expect(res.status).toBe(404);
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
    db.executeQuery
      .mockResolvedValueOnce([{ UserID: 1, Role: "facilities" }])
      .mockResolvedValueOnce([]);

    const req = makeAuthReq({ name: "Jane", preferred_username: "jane@co.com" });
    const res = await registerSelf(req, ctx);

    expect(res.status).toBe(200);
    expect((res.jsonBody as { role: string }).role).toBe("facilities");
  });

  it("claims a pre-invite by email when OID has no match", async () => {
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ UserID: 5, Role: "accounts", DisplayName: null }])
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

  it("preserves an admin-typed DisplayName when claiming a pre-invite", async () => {
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ UserID: 5, Role: "accounts", DisplayName: "Pre-set Name" }])
      .mockResolvedValueOnce([]);

    const req = makeAuthReq({ name: "Jane", preferred_username: "jane@co.com" });
    await registerSelf(req, ctx);

    const updateCall = db.executeQuery.mock.calls.find(
      ([, sql]: [unknown, string]) => sql.includes("UPDATE") && sql.includes("EntraOid"),
    );
    const [, sql] = updateCall as [unknown, string];
    expect(sql).not.toMatch(/DisplayName/);
  });

  it("returns 409 + emits Sentry event when more than one pre-invite matches", async () => {
    db.executeQuery
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { UserID: 5, Role: "accounts", DisplayName: null },
        { UserID: 6, Role: "facilities", DisplayName: null },
      ]);

    const req = makeAuthReq({ name: "Jane", preferred_username: "jane@co.com" });
    const res = await registerSelf(req, ctx);

    expect(res.status).toBe(409);
    expect(sentry.Sentry.captureMessage).toHaveBeenCalledWith(
      "ambiguous pre-invite",
      expect.objectContaining({ level: "error" }),
    );
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
