import assert from "node:assert";
import { rolesFromAppToken } from "../auth";

// ── JWT helpers ───────────────────────────────────────────────────────────────

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const body   = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.fakesig`;
}

// ── rolesFromAppToken ─────────────────────────────────────────────────────────
//
// rolesFromAppToken now verifies the app token's signature against the
// tenant's JWKS. To unit-test the claim-extraction / case-normalisation logic
// without hitting the network, we enable the dev override (skips signature
// verification) and set APP_CLIENT_ID so the function has an expected
// audience to compare against.

const ORIGINAL_DEV_OVERRIDE = process.env.DEV_ROLE_OVERRIDE_ENABLED;
const ORIGINAL_APP_CLIENT_ID = process.env.APP_CLIENT_ID;
const ORIGINAL_ENV = process.env.AZURE_FUNCTIONS_ENVIRONMENT;

beforeAll(() => {
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.APP_CLIENT_ID = "test-client-id";
  delete process.env.AZURE_FUNCTIONS_ENVIRONMENT;
});

afterAll(() => {
  if (ORIGINAL_DEV_OVERRIDE === undefined) delete process.env.DEV_ROLE_OVERRIDE_ENABLED;
  else process.env.DEV_ROLE_OVERRIDE_ENABLED = ORIGINAL_DEV_OVERRIDE;
  if (ORIGINAL_APP_CLIENT_ID === undefined) delete process.env.APP_CLIENT_ID;
  else process.env.APP_CLIENT_ID = ORIGINAL_APP_CLIENT_ID;
  if (ORIGINAL_ENV === undefined) delete process.env.AZURE_FUNCTIONS_ENVIRONMENT;
  else process.env.AZURE_FUNCTIONS_ENVIRONMENT = ORIGINAL_ENV;
});

describe("rolesFromAppToken — case normalisation", () => {
  test("returns lowercase when Entra sends capital-A Admin", async () => {
    const sqlToken = makeJwt({ oid: "abc" });
    const appToken = makeJwt({ oid: "abc", roles: ["Admin"] });
    assert.deepStrictEqual(await rolesFromAppToken(sqlToken, appToken), ["admin"]);
  });

  test("returns lowercase for mixed-case role names", async () => {
    const sqlToken = makeJwt({ oid: "abc" });
    const appToken = makeJwt({ oid: "abc", roles: ["Facilities", "ACCOUNTS_MANAGER"] });
    assert.deepStrictEqual(await rolesFromAppToken(sqlToken, appToken), ["facilities", "accounts_manager"]);
  });

  test("returns lowercase for already-lowercase roles", async () => {
    const sqlToken = makeJwt({ oid: "abc" });
    const appToken = makeJwt({ oid: "abc", roles: ["admin", "facilities"] });
    assert.deepStrictEqual(await rolesFromAppToken(sqlToken, appToken), ["admin", "facilities"]);
  });

  test("returns [] when OIDs do not match", async () => {
    const sqlToken = makeJwt({ oid: "user-1" });
    const appToken = makeJwt({ oid: "user-2", roles: ["admin"] });
    assert.deepStrictEqual(await rolesFromAppToken(sqlToken, appToken), []);
  });

  test("returns [] when roles claim is absent", async () => {
    const sqlToken = makeJwt({ oid: "abc" });
    const appToken = makeJwt({ oid: "abc" });
    assert.deepStrictEqual(await rolesFromAppToken(sqlToken, appToken), []);
  });

  test("returns [] when roles claim is not an array", async () => {
    const sqlToken = makeJwt({ oid: "abc" });
    const appToken = makeJwt({ oid: "abc", roles: "admin" });
    assert.deepStrictEqual(await rolesFromAppToken(sqlToken, appToken), []);
  });

  test("returns [] for a malformed token", async () => {
    assert.deepStrictEqual(await rolesFromAppToken("notajwt", "alsonotajwt"), []);
  });
});

// requireRole tests are covered in src/auth.test.ts (co-located, DB-mocked).
