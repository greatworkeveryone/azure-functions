import assert from "node:assert";
import { rolesFromAppToken, requireRole, AppRole } from "../auth";
import type { HttpRequest } from "@azure/functions";

// ── JWT helpers ───────────────────────────────────────────────────────────────

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body   = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

function makeRequest(sqlRoles: string[], appRoles: string[]): HttpRequest {
  const oid = "test-oid-123";
  const sqlToken = makeJwt({ oid, aud: "https://database.windows.net/" });
  const appToken = makeJwt({ oid, roles: appRoles });

  const _ = sqlRoles; // unused — sql token doesn't carry app roles
  return {
    headers: {
      get: (name: string) => {
        if (name === "authorization") return `Bearer ${sqlToken}`;
        if (name === "x-app-token")   return appToken;
        return null;
      },
    },
  } as unknown as HttpRequest;
}

// ── rolesFromAppToken ─────────────────────────────────────────────────────────

describe("rolesFromAppToken — case normalisation", () => {
  test("returns lowercase when Entra sends capital-A Admin", () => {
    const sqlToken = makeJwt({ oid: "abc" });
    const appToken = makeJwt({ oid: "abc", roles: ["Admin"] });
    assert.deepStrictEqual(rolesFromAppToken(sqlToken, appToken), ["admin"]);
  });

  test("returns lowercase for mixed-case role names", () => {
    const sqlToken = makeJwt({ oid: "abc" });
    const appToken = makeJwt({ oid: "abc", roles: ["Facilities", "ACCOUNTS_MANAGER"] });
    assert.deepStrictEqual(rolesFromAppToken(sqlToken, appToken), ["facilities", "accounts_manager"]);
  });

  test("returns lowercase for already-lowercase roles", () => {
    const sqlToken = makeJwt({ oid: "abc" });
    const appToken = makeJwt({ oid: "abc", roles: ["admin", "facilities"] });
    assert.deepStrictEqual(rolesFromAppToken(sqlToken, appToken), ["admin", "facilities"]);
  });

  test("returns [] when OIDs do not match", () => {
    const sqlToken = makeJwt({ oid: "user-1" });
    const appToken = makeJwt({ oid: "user-2", roles: ["admin"] });
    assert.deepStrictEqual(rolesFromAppToken(sqlToken, appToken), []);
  });

  test("returns [] when roles claim is absent", () => {
    const sqlToken = makeJwt({ oid: "abc" });
    const appToken = makeJwt({ oid: "abc" });
    assert.deepStrictEqual(rolesFromAppToken(sqlToken, appToken), []);
  });

  test("returns [] when roles claim is not an array", () => {
    const sqlToken = makeJwt({ oid: "abc" });
    const appToken = makeJwt({ oid: "abc", roles: "admin" });
    assert.deepStrictEqual(rolesFromAppToken(sqlToken, appToken), []);
  });

  test("returns [] for a malformed token", () => {
    assert.deepStrictEqual(rolesFromAppToken("notajwt", "alsonotajwt"), []);
  });
});

// ── requireRole ───────────────────────────────────────────────────────────────

describe("requireRole — admin bypass", () => {
  test("allows user whose JWT has lowercase 'admin'", () => {
    const req = makeRequest([], ["admin"]);
    assert.strictEqual(requireRole(req, [AppRole.ACCOUNTS]), null);
  });

  test("allows user whose JWT has capital-A 'Admin' (case normalisation fix)", () => {
    const req = makeRequest([], ["Admin"]);
    assert.strictEqual(requireRole(req, [AppRole.ACCOUNTS]), null);
  });

  test("allows user whose JWT has all-caps 'ADMIN'", () => {
    const req = makeRequest([], ["ADMIN"]);
    assert.strictEqual(requireRole(req, [AppRole.ACCOUNTS]), null);
  });
});

describe("requireRole — role matching", () => {
  test("allows user with an exact matching role", () => {
    const req = makeRequest([], ["facilities"]);
    assert.strictEqual(requireRole(req, [AppRole.FACILITIES, AppRole.ACCOUNTS]), null);
  });

  test("allows user when one of their roles matches", () => {
    const req = makeRequest([], ["user", "accounts_manager"]);
    assert.strictEqual(requireRole(req, [AppRole.ACCOUNTS_APPROVAL]), null);
  });

  test("returns 403 when user has no matching roles", () => {
    const req = makeRequest([], ["user"]);
    const result = requireRole(req, [AppRole.ACCOUNTS, AppRole.ADMIN]);
    assert.ok(result !== null);
    assert.strictEqual(result.status, 403);
  });

  test("403 body includes the required roles and actual roles", () => {
    const req = makeRequest([], ["user"]);
    const result = requireRole(req, [AppRole.ACCOUNTS, AppRole.DIRECTOR]);
    assert.ok(result !== null);
    const body = result.jsonBody as { details: string };
    assert.ok(body.details.includes("accounts | director"), `details: ${body.details}`);
    assert.ok(body.details.includes("user"), `details: ${body.details}`);
  });

  test("returns 403 when user has no tokens at all", () => {
    const req = {
      headers: { get: () => null },
    } as unknown as HttpRequest;
    const result = requireRole(req, [AppRole.ADMIN]);
    assert.ok(result !== null);
    assert.strictEqual(result.status, 403);
  });
});
