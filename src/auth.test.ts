/// <reference types="jest" />
import { HttpRequest } from "@azure/functions";
import { AppRole, clearRoleCache, requireRole, rolesForRequest } from "./auth";

// Mock the DB module so tests don't need a real SQL connection.
jest.mock("./db", () => ({
  closeConnection:         jest.fn(),
  createServiceConnection: jest.fn(),
  executeQuery:            jest.fn(),
}));

const db = require("./db") as {
  closeConnection:         jest.Mock;
  createServiceConnection: jest.Mock;
  executeQuery:            jest.Mock;
};

// Builds a minimal base64url-encoded JWT with the given payload.
function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function makeRequest(headers: Record<string, string> = {}): HttpRequest {
  return {
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
  } as unknown as HttpRequest;
}

beforeEach(() => {
  jest.clearAllMocks();
  // The role cache is module-level state; clear it so a cached role from one
  // case can't satisfy another that mocks a different role for the same oid.
  clearRoleCache();
  db.createServiceConnection.mockResolvedValue({});
  db.closeConnection.mockImplementation(() => undefined);
  // Tests use unsigned JWTs and run offline — keep the dev override on so
  // verifyEntraToken skips JWKS lookup and just decodes the payload. The
  // dev-roles-header test below re-asserts the override path explicitly.
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  delete process.env.AZURE_FUNCTIONS_ENVIRONMENT;
});

describe("rolesForRequest", () => {
  it("returns the role from DB for a known OID", async () => {
    db.executeQuery.mockResolvedValue([{ Role: "facilities" }]);
    const token = makeJwt({ oid: "abc-123" });
    const req = makeRequest({ authorization: `Bearer ${token}` });

    const roles = await rolesForRequest(req);

    expect(roles).toEqual(["facilities"]);
    expect(db.executeQuery).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("SELECT Role"),
      expect.arrayContaining([
        expect.objectContaining({ name: "Oid", value: "abc-123" }),
      ]),
    );
  });

  it("returns [] when OID has no matching AppUsers row", async () => {
    db.executeQuery.mockResolvedValue([]);
    const token = makeJwt({ oid: "unknown" });
    const req = makeRequest({ authorization: `Bearer ${token}` });

    expect(await rolesForRequest(req)).toEqual([]);
  });

  it("returns [] when there is no Authorization header", async () => {
    expect(await rolesForRequest(makeRequest())).toEqual([]);
    expect(db.createServiceConnection).not.toHaveBeenCalled();
  });

  it("closes the connection and rejects when executeQuery throws", async () => {
    db.executeQuery.mockRejectedValue(new Error("timeout"));
    const token = makeJwt({ oid: "oid" });
    const req = makeRequest({ authorization: `Bearer ${token}` });

    await expect(rolesForRequest(req)).rejects.toThrow();

    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("uses dev override when DEV_ROLE_OVERRIDE_ENABLED=true", async () => {
    process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
    const req = makeRequest({ "x-dev-roles": "admin,facilities" });

    const roles = await rolesForRequest(req);

    expect(roles).toEqual(["admin", "facilities"]);
    expect(db.createServiceConnection).not.toHaveBeenCalled();
  });
});

describe("requireRole", () => {
  it("returns null (allow) when the caller has a matching role", async () => {
    db.executeQuery.mockResolvedValue([{ Role: "facilities" }]);
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "oid" })}`,
    });

    const result = await requireRole(req, [AppRole.FACILITIES]);

    expect(result).toBeNull();
  });

  it("returns 403 when the caller lacks the required role", async () => {
    db.executeQuery.mockResolvedValue([{ Role: "user" }]);
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "oid" })}`,
    });

    const result = await requireRole(req, [AppRole.ADMIN]);

    expect(result?.status).toBe(403);
  });

  it("admin satisfies every role check", async () => {
    db.executeQuery.mockResolvedValue([{ Role: "admin" }]);
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "oid" })}`,
    });

    const result = await requireRole(req, [AppRole.DIRECTOR]);

    expect(result).toBeNull();
  });

  it("director satisfies any non-admin-only role check", async () => {
    db.executeQuery.mockResolvedValue([{ Role: "director" }]);
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "oid" })}`,
    });

    const result = await requireRole(req, [AppRole.FACILITIES, AppRole.FACILITIES_APPROVAL]);

    expect(result).toBeNull();
  });

  it("director is rejected on admin-only role checks", async () => {
    db.executeQuery.mockResolvedValue([{ Role: "director" }]);
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "oid" })}`,
    });

    const result = await requireRole(req, [AppRole.ADMIN]);

    expect(result?.status).toBe(403);
  });

  it("facilities_manager satisfies a facilities-only check", async () => {
    db.executeQuery.mockResolvedValue([{ Role: "facilities_manager" }]);
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "oid" })}`,
    });

    const result = await requireRole(req, [AppRole.FACILITIES]);

    expect(result).toBeNull();
  });

  it("accounts_manager satisfies an accounts-only check", async () => {
    db.executeQuery.mockResolvedValue([{ Role: "accounts_manager" }]);
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "oid" })}`,
    });

    const result = await requireRole(req, [AppRole.ACCOUNTS]);

    expect(result).toBeNull();
  });

  // USER is the baseline tier: any caller with an assigned, active role
  // satisfies it. Only Pending / no-role accounts (empty roles) are rejected.
  // This lets endpoints gate on [AppRole.USER] to mean "any authenticated app
  // user" without enumerating every operational role.
  it.each([
    ["facilities"],
    ["accounts"],
    ["facilities_manager"],
    ["accounts_manager"],
    ["director"],
    ["admin"],
    ["user"],
  ])("%s satisfies a baseline [USER] check", async (role) => {
    db.executeQuery.mockResolvedValue([{ Role: role }]);
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "oid" })}`,
    });

    const result = await requireRole(req, [AppRole.USER]);

    expect(result).toBeNull();
  });

  it("rejects a Pending (no-role) caller on a baseline [USER] check", async () => {
    db.executeQuery.mockResolvedValue([]); // no active AppUsers row → []
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "oid" })}`,
    });

    const result = await requireRole(req, [AppRole.USER]);

    expect(result?.status).toBe(403);
  });
});

// ── Transient role-lookup failure ─────────────────────────────────────────────
// A failure of the role lookup itself (DB/connection error) must NOT be
// swallowed into [] — that masquerades as "user has no role" and yields a
// misleading 403 that the user can never resolve. It must surface as a
// retryable 503 so react-query re-fires and recovers once the connection warms.

describe("requireRole — transient role-lookup failure", () => {
  it("returns a retryable 503, not a 403, when the role lookup throws", async () => {
    db.executeQuery.mockRejectedValue(new Error("connection reset by peer"));
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "oid-lookup-fail-1" })}`,
    });

    const result = await requireRole(req, [AppRole.FACILITIES]);

    expect(result?.status).toBe(503);
  });
});

describe("rolesForRequest — transient role-lookup failure", () => {
  it("rejects (does not resolve to []) when the lookup throws", async () => {
    db.executeQuery.mockRejectedValue(new Error("connection reset by peer"));
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "oid-lookup-fail-2" })}`,
    });

    await expect(rolesForRequest(req)).rejects.toThrow();
  });
});

// ── Caching & in-flight de-dup ────────────────────────────────────────────────
// A page-load burst fires many requests for the same user; these must collapse
// onto a single DB role lookup rather than stampeding the shared connection.

describe("rolesForRequest — caching & in-flight de-dup", () => {
  it("de-dupes concurrent lookups for the same oid onto one DB query", async () => {
    db.executeQuery.mockResolvedValue([{ Role: "facilities" }]);
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "burst-oid" })}`,
    });

    const results = await Promise.all([
      rolesForRequest(req),
      rolesForRequest(req),
      rolesForRequest(req),
    ]);

    expect(results).toEqual([["facilities"], ["facilities"], ["facilities"]]);
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });

  it("serves a later lookup from cache without re-querying", async () => {
    db.executeQuery.mockResolvedValue([{ Role: "accounts" }]);
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "cache-oid" })}`,
    });

    expect(await rolesForRequest(req)).toEqual(["accounts"]);
    expect(await rolesForRequest(req)).toEqual(["accounts"]);

    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed lookup — a later request retries the DB", async () => {
    db.executeQuery
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce([{ Role: "director" }]);
    const req = makeRequest({
      authorization: `Bearer ${makeJwt({ oid: "retry-oid" })}`,
    });

    await expect(rolesForRequest(req)).rejects.toThrow();
    expect(await rolesForRequest(req)).toEqual(["director"]);
    expect(db.executeQuery).toHaveBeenCalledTimes(2);
  });
});
