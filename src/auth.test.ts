/// <reference types="jest" />
import { HttpRequest } from "@azure/functions";
import { AppRole, requireRole, rolesForRequest } from "./auth";

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
  db.createServiceConnection.mockResolvedValue({});
  db.closeConnection.mockImplementation(() => undefined);
  delete process.env.DEV_ROLE_OVERRIDE_ENABLED;
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

  it("closes the connection even when executeQuery throws", async () => {
    db.executeQuery.mockRejectedValue(new Error("timeout"));
    const token = makeJwt({ oid: "oid" });
    const req = makeRequest({ authorization: `Bearer ${token}` });

    await rolesForRequest(req);

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
});
