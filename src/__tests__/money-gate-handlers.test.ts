/// <reference types="jest" />
// The gate in a real handler (S11): setApprovalLimit refuses before it opens a
// database connection or reads the body, and goes ahead for an office request
// with a fresh MFA sign-in. Auth is the real requireRole path via the dev
// override and an unsigned JWT; the database is mocked.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { clearRoleCache } from "../auth";
import { setApprovalLimit } from "../functions/approval-limits";

jest.mock("@azure/functions", () => ({ ...jest.requireActual("@azure/functions"), app: { http: jest.fn() } }));
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../approval-limits-db", () => ({ invalidateApprovalLimitsCache: jest.fn() }));

const db = jest.requireMock("../db") as Record<string, jest.Mock>;
const NOW = Math.floor(Date.now() / 1000);

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function makeRequest(claims: Record<string, unknown>, forwardedFor: string) {
  const token = makeJwt({ name: "Ada Admin", oid: "oid-ada", preferred_username: "ada@example.com", ...claims });
  const headers: Record<string, string> = { authorization: `Bearer ${token}`, "x-dev-roles": "admin", "x-forwarded-for": forwardedFor };
  const json = jest.fn().mockResolvedValue({ MaxApprovalAmount: 5000, RoleName: "accounts_manager" });
  const request = {
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    json,
    url: "https://api.example/api/setApprovalLimit",
  } as unknown as HttpRequest;
  return { json, request };
}

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

beforeAll(() => {
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  // The dev-roles header only works on a local Development host (jwt.ts).
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  delete process.env.WEBSITE_INSTANCE_ID;
  process.env.MONEY_ALLOWED_CIDRS = "203.0.113.0/28";
});
afterAll(() => {
  delete process.env.DEV_ROLE_OVERRIDE_ENABLED;
  delete process.env.AZURE_FUNCTIONS_ENVIRONMENT;
  delete process.env.MONEY_ALLOWED_CIDRS;
});
beforeEach(() => {
  jest.clearAllMocks();
  clearRoleCache();
  jest.spyOn(console, "warn").mockImplementation(() => {});
  db.createRequestConnection.mockResolvedValue({});
  db.executeQuery.mockResolvedValue([]);
});
afterEach(() => jest.restoreAllMocks());

describe("setApprovalLimit behind the money gate", () => {
  it("refuses a request from outside the office before touching the database", async () => {
    const { json, request } = makeRequest({ amr: ["pwd", "mfa"], iat: NOW }, "198.51.100.20");
    const res = await setApprovalLimit(request, ctx);
    expect(res.status).toBe(403);
    expect(res.jsonBody).toMatchObject({ code: "money_network_required" });
    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });

  it("asks for a fresh sign-in from the office when the last one is old", async () => {
    const { request } = makeRequest({ amr: ["pwd", "mfa"], iat: NOW - 3600 }, "203.0.113.5");
    const res = await setApprovalLimit(request, ctx);
    expect(res.status).toBe(428);
    expect(res.jsonBody).toMatchObject({ code: "step_up_required", reason: "stale_sign_in" });
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });

  it("goes ahead from the office with a fresh MFA sign-in", async () => {
    const { request } = makeRequest({ amr: ["pwd", "mfa"], iat: NOW }, "203.0.113.5");
    const res = await setApprovalLimit(request, ctx);
    expect(res.status).toBe(200);
    expect(db.createRequestConnection).toHaveBeenCalled();
  });
});
