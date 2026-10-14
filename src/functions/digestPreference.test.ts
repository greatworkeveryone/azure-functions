/// <reference types="jest" />
import type { HttpRequest, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ status: 500, jsonBody: { error: "Error" } }),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    verifiedIdentityFromRequest: jest.fn(),
  };
});
jest.mock("../db", () => ({
  closeConnection: jest.fn(),
  createServiceRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
}));

const auth = require("../auth") as { verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as { closeConnection: jest.Mock; createServiceRequestConnection: jest.Mock; executeQuery: jest.Mock };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };
const { getDigestPreference } = require("./getDigestPreference") as { getDigestPreference: (r: HttpRequest, c: InvocationContext) => Promise<{ jsonBody?: unknown; status: number }> };
const { setDigestPreference } = require("./setDigestPreference") as { setDigestPreference: (r: HttpRequest, c: InvocationContext) => Promise<{ jsonBody?: unknown; status: number }> };
const { app } = require("@azure/functions") as { app: { http: jest.Mock } };
// Taken at load: beforeEach clears the mock's calls.
const registrations = Object.fromEntries(app.http.mock.calls.map((c: unknown[]) => [c[0], (c[1] as { methods: string[] }).methods]));

const ctx = { error: jest.fn(), log: jest.fn() } as unknown as InvocationContext;
const request = (body?: unknown): HttpRequest => ({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body) }) as unknown as HttpRequest;

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateLimitForTests();
  auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "fay@x.test", name: "Fay", oid: "oid-fay" });
  db.createServiceRequestConnection.mockResolvedValue({});
});

describe("registration", () => {
  it("registers a GET and a POST, each its own function", () => {
    expect(registrations.getDigestPreference).toEqual(["GET"]);
    expect(registrations.setDigestPreference).toEqual(["POST"]);
  });
});

describe("getDigestPreference", () => {
  it("returns the role gate's refusal before reading the identity or the database", async () => {
    const auth = jest.requireMock("../auth") as { requireRole: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
    auth.requireRole.mockResolvedValueOnce({ jsonBody: { error: "Forbidden" }, status: 403 });
    const res = await getDigestPreference(request(), ctx);
    expect(res).toEqual({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect(auth.verifiedIdentityFromRequest).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("says whether the signed-in person has switched the digest off, by their verified identity", async () => {
    db.executeQuery.mockResolvedValue([{ DigestOptOut: true }]);
    const res = await getDigestPreference(request(), ctx);
    expect(res).toEqual({ jsonBody: { digestOptOut: true }, status: 200 });
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toMatch(/FROM dbo\.AppUsers/);
    expect(sql).toMatch(/EntraOid = @Oid/);
    expect(sql).toMatch(/IsActive = 1/);
    expect(params).toEqual([{ name: "Oid", type: TYPES.NVarChar, value: "oid-fay" }]);
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("treats a person who never chose as receiving it", async () => {
    db.executeQuery.mockResolvedValue([{ DigestOptOut: null }]);
    expect((await getDigestPreference(request(), ctx)).jsonBody).toEqual({ digestOptOut: false });
  });

  it("is 401 without a verified token and never reads the database", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValue(null);
    const res = await getDigestPreference(request(), ctx);
    expect(res.status).toBe(401);
    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
  });

  it("is 404 when the sign-in has no active user", async () => {
    db.executeQuery.mockResolvedValue([]);
    expect((await getDigestPreference(request(), ctx)).status).toBe(404);
  });

  it("is a 500 that closes the connection when the database fails", async () => {
    db.executeQuery.mockRejectedValue(new Error("Invalid column name 'DigestOptOut'"));
    expect((await getDigestPreference(request(), ctx)).status).toBe(500);
    expect(db.closeConnection).toHaveBeenCalled();
  });
});

describe("setDigestPreference", () => {
  it("switches the digest off for the signed-in person only", async () => {
    db.executeQuery.mockResolvedValue([{ DigestOptOut: true }]);
    const res = await setDigestPreference(request({ digestOptOut: true }), ctx);
    expect(res).toEqual({ jsonBody: { digestOptOut: true }, status: 200 });
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toMatch(/UPDATE dbo\.AppUsers SET DigestOptOut = @OptOut/);
    expect(sql).toMatch(/WHERE EntraOid = @Oid AND IsActive = 1/);
    expect(params).toEqual([
      { name: "OptOut", type: TYPES.Bit, value: true },
      { name: "Oid", type: TYPES.NVarChar, value: "oid-fay" },
    ]);
  });

  it("switches it back on", async () => {
    db.executeQuery.mockResolvedValue([{ DigestOptOut: false }]);
    const res = await setDigestPreference(request({ digestOptOut: false }), ctx);
    expect(res.jsonBody).toEqual({ digestOptOut: false });
    expect(db.executeQuery.mock.calls[0][2][0]).toMatchObject({ value: false });
  });

  it.each([undefined, null, {}, { digestOptOut: "true" }, { digestOptOut: 1 }, { digestOptOut: null }, "true"])("is 400 for body %j, and writes nothing", async (body) => {
    const res = await setDigestPreference(request(body), ctx);
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("ignores a user id or email in the body: the identity comes from the token", async () => {
    db.executeQuery.mockResolvedValue([{ DigestOptOut: true }]);
    await setDigestPreference(request({ digestOptOut: true, email: "boss@x.test", userId: 99 }), ctx);
    expect(db.executeQuery.mock.calls[0][2].map((p: { value: unknown }) => p.value)).toEqual([true, "oid-fay"]);
  });

  it("is 401 without a verified token and writes nothing", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValue(null);
    expect((await setDigestPreference(request({ digestOptOut: true }), ctx)).status).toBe(401);
    expect(db.createServiceRequestConnection).not.toHaveBeenCalled();
  });

  it("is 404 when the sign-in has no active user", async () => {
    db.executeQuery.mockResolvedValue([]);
    expect((await setDigestPreference(request({ digestOptOut: true }), ctx)).status).toBe(404);
  });

  it("is 429 after a burst of changes", async () => {
    db.executeQuery.mockResolvedValue([{ DigestOptOut: true }]);
    let last = 200;
    for (let i = 0; i < 25; i += 1) last = (await setDigestPreference(request({ digestOptOut: true }), ctx)).status;
    expect(last).toBe(429);
  });

  it("is a 500 that closes the connection when the database fails", async () => {
    db.executeQuery.mockRejectedValue(new Error("down"));
    expect((await setDigestPreference(request({ digestOptOut: true }), ctx)).status).toBe(500);
    expect(db.closeConnection).toHaveBeenCalled();
  });
});
