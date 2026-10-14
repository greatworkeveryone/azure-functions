/// <reference types="jest" />
// Where the access log hooks into request handling (S10): requireRole notes
// every authorised caller (the module samples), registerSelf notes every
// sign-in and advertises accessHints so the frontend starts sending its
// country hint only once this backend's CORS allows the header.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { clearRoleCache, requireRole, AppRole } from "../auth";
import { corsHeaders } from "../cors";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
jest.mock("../access/accessEvents", () => ({ noteAccess: jest.fn(), noteMoneyAction: jest.fn(), noteSignIn: jest.fn() }));
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
}));

const access = jest.requireMock("../access/accessEvents") as Record<string, jest.Mock>;
const db = jest.requireMock("../db") as Record<string, jest.Mock>;

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function makeRequest(headers: Record<string, string>): HttpRequest {
  return { headers: { get: (key: string) => headers[key.toLowerCase()] ?? null } } as unknown as HttpRequest;
}

const TOKEN = makeJwt({ name: "Jane", oid: "oid-jane", preferred_username: "jane@example.com" });
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

beforeAll(() => {
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
});
afterAll(() => {
  delete process.env.DEV_ROLE_OVERRIDE_ENABLED;
});
beforeEach(() => {
  jest.clearAllMocks();
  clearRoleCache();
});

describe("requireRole", () => {
  it("notes the caller's oid and roles, allowed or not, without waiting", async () => {
    const request = makeRequest({ authorization: `Bearer ${TOKEN}`, "x-dev-roles": "accounts" });
    expect(await requireRole(request, [AppRole.ACCOUNTS])).toBeNull();
    expect(access.noteAccess).toHaveBeenCalledWith(request, "oid-jane", ["accounts"]);

    expect((await requireRole(request, [AppRole.DIRECTOR]))?.status).toBe(403);
    expect(access.noteAccess).toHaveBeenCalledTimes(2);
  });

  it("passes no oid when there is no token", async () => {
    const request = makeRequest({ "x-dev-roles": "accounts" });
    await requireRole(request, [AppRole.ACCOUNTS]);
    expect(access.noteAccess).toHaveBeenCalledWith(request, null, ["accounts"]);
  });
});

describe("registerSelf", () => {
  it("notes the sign-in and advertises accessHints", async () => {
    const { registerSelf } = require("../functions/users") as typeof import("../functions/users");
    db.executeQuery.mockResolvedValueOnce([{ Role: "accounts", UserID: 4 }]).mockResolvedValueOnce([]);
    const request = makeRequest({ authorization: `Bearer ${TOKEN}`, "x-forwarded-for": "203.0.113.5" });
    const res = await registerSelf(request, ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ accessHints: true, role: "accounts", userId: 4 });
    expect(access.noteSignIn).toHaveBeenCalledWith(request, "oid-jane");
  });
});

describe("CORS", () => {
  it("allows the country hint header", () => {
    expect(corsHeaders("https://floorplan.randazzo.properties")["Access-Control-Allow-Headers"]).toContain("X-Fp-Country");
  });
});
