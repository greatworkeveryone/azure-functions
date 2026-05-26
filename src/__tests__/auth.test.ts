import assert from "node:assert";
import { rolesFromAppToken } from "../auth";

// ── JWT helpers ───────────────────────────────────────────────────────────────

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body   = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
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

// requireRole tests are covered in src/auth.test.ts (co-located, DB-mocked).
