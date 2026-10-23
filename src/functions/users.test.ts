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
  beginTransaction:               jest.fn(),
  closeConnection:                jest.fn(),
  commitTransaction:              jest.fn(),
  createRequestConnection:        jest.fn(),
  createServiceRequestConnection: jest.fn(),
  executeQuery:                   jest.fn(),
  rollbackTransaction:            jest.fn(),
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
  beginTransaction:               jest.Mock;
  closeConnection:                jest.Mock;
  commitTransaction:              jest.Mock;
  createServiceRequestConnection: jest.Mock;
  executeQuery:                   jest.Mock;
  rollbackTransaction:            jest.Mock;
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
const { upsertAppUser, registerSelf } = require("./users") as {
  upsertAppUser: (req: HttpRequest, ctx: InvocationContext) => Promise<{ status: number; jsonBody?: unknown }>;
  registerSelf:  (req: HttpRequest, ctx: InvocationContext) => Promise<{ status: number; jsonBody?: unknown }>;
};

beforeEach(() => {
  jest.clearAllMocks();
  rateLimit._resetRateLimitForTests();
  db.createServiceRequestConnection.mockResolvedValue({});
  db.closeConnection.mockImplementation(() => undefined);
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
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

describe("upsertAppUser decision ledger (WP19b)", () => {
  type SqlCall = [unknown, string, { name: string; value: unknown }[]];
  const callsMatching = (needle: string): SqlCall[] =>
    (db.executeQuery.mock.calls as SqlCall[]).filter(([, sql]) => sql.includes(needle));
  const paramValue = (call: SqlCall, name: string) => call[2].find((p) => p.name === name)?.value;

  /** Call order of every executeQuery whose SQL contains `needle`. */
  const orderOf = (needle: string): number[] =>
    (db.executeQuery.mock.calls as SqlCall[])
      .map(([, sql], i) => (sql.includes(needle) ? db.executeQuery.mock.invocationCallOrder[i] : -1))
      .filter((n) => n >= 0);

  beforeEach(() => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    auth.requireRole.mockResolvedValue(null);
  });

  describe("changing a role", () => {
    const changeRole = () => {
      db.executeQuery
        .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
        .mockResolvedValueOnce([{ Role: "user", Email: "x@co.com", EntraOid: "target-oid" }])
        .mockResolvedValueOnce([]) // UPDATE
        .mockResolvedValueOnce([]); // audit
      return upsertAppUser(makeRequest({ userId: 7, role: "facilities" }), ctx);
    };

    it("writes the ledger row, with the person who decided and both roles", async () => {
      const res = await changeRole();

      expect(res.status).toBe(200);
      const [ledger] = callsMatching("INSERT INTO dbo.DecisionLedger");
      expect(ledger).toBeDefined();
      expect(paramValue(ledger, "Action")).toBe("user.role_change");
      expect(paramValue(ledger, "SubjectType")).toBe("app_user");
      expect(paramValue(ledger, "SubjectId")).toBe("7");
      expect(paramValue(ledger, "ActorName")).toBe("Test User");
      expect(paramValue(ledger, "ActorRole")).toBe("admin");
      expect(paramValue(ledger, "ActorUserId")).toBe(3);
      expect(paramValue(ledger, "IsException")).toBe(true);
      expect(JSON.parse(paramValue(ledger, "Before") as string)).toEqual({ role: "user" });
      expect(JSON.parse(paramValue(ledger, "After") as string)).toEqual({ role: "facilities" });
    });

    it("runs the UPDATE, the audit row and the ledger row inside one transaction, then commits", async () => {
      await changeRole();

      const begun = db.beginTransaction.mock.invocationCallOrder[0];
      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      for (const write of ["UPDATE dbo.AppUsers", "INSERT INTO dbo.UserRoleAudit", "INSERT INTO dbo.DecisionLedger"]) {
        const [at] = orderOf(write);
        expect(at).toBeGreaterThan(begun);
        expect(at).toBeLessThan(committed);
      }
      expect(db.rollbackTransaction).not.toHaveBeenCalled();
    });

    it("rolls the role change back when the ledger write fails: no ledger row, no decision", async () => {
      db.executeQuery
        .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
        .mockResolvedValueOnce([{ Role: "user", Email: "x@co.com", EntraOid: "target-oid" }])
        .mockResolvedValueOnce([]) // UPDATE
        .mockResolvedValueOnce([]) // audit
        .mockRejectedValueOnce(new Error("ledger unavailable")); // ledger INSERT

      const res = await upsertAppUser(makeRequest({ userId: 7, role: "facilities" }), ctx);

      expect(res.status).toBe(500);
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      // Both of the other writes were inside the transaction that was rolled back.
      const begun = db.beginTransaction.mock.invocationCallOrder[0];
      const rolledBack = db.rollbackTransaction.mock.invocationCallOrder[0];
      for (const write of ["UPDATE dbo.AppUsers", "INSERT INTO dbo.UserRoleAudit"]) {
        const [at] = orderOf(write);
        expect(at).toBeGreaterThan(begun);
        expect(at).toBeLessThan(rolledBack);
      }
    });

    it("refuses to continue (and rolls back) when the ledger entry itself is invalid", async () => {
      auth.rolesForRequest.mockResolvedValue([]);
      auth.requireRole.mockResolvedValue(null);
      db.executeQuery
        .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
        .mockResolvedValueOnce([{ Role: "user", Email: "x@co.com", EntraOid: "target-oid" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const res = await upsertAppUser(makeRequest({ userId: 7, role: "facilities" }), ctx);

      expect(res.status).toBe(500);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(callsMatching("INSERT INTO dbo.DecisionLedger")).toHaveLength(0);
    });
  });

  describe("changing activation", () => {
    const updateParam = (name: string) => paramValue(callsMatching("UPDATE dbo.AppUsers")[0], name);
    const activationRows = () => callsMatching("INSERT INTO dbo.DecisionLedger").filter((c) => paramValue(c, "Action") === "user.activation_change");

    it("ledgers a deactivation with no role change, and writes no role audit row", async () => {
      db.executeQuery
        .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
        .mockResolvedValueOnce([{ Role: "facilities", Email: "x@co.com", EntraOid: "target-oid", IsActive: true }])
        .mockResolvedValueOnce([]) // UPDATE
        .mockResolvedValueOnce([]); // ledger

      const res = await upsertAppUser(makeRequest({ userId: 7, role: "facilities", isActive: false }), ctx);

      expect(res.status).toBe(200);
      expect(updateParam("IsActive")).toBe(false);
      expect(callsMatching("INSERT INTO dbo.UserRoleAudit")).toHaveLength(0);
      const [ledger] = callsMatching("INSERT INTO dbo.DecisionLedger");
      expect(paramValue(ledger, "Action")).toBe("user.activation_change");
      expect(paramValue(ledger, "SubjectType")).toBe("app_user");
      expect(paramValue(ledger, "SubjectId")).toBe("7");
      expect(paramValue(ledger, "ActorName")).toBe("Test User");
      expect(paramValue(ledger, "ActorUserId")).toBe(3);
      expect(paramValue(ledger, "IsException")).toBe(true);
      expect(JSON.parse(paramValue(ledger, "Before") as string)).toEqual({ isActive: true });
      expect(JSON.parse(paramValue(ledger, "After") as string)).toEqual({ isActive: false });
      const begun = db.beginTransaction.mock.invocationCallOrder[0];
      const committed = db.commitTransaction.mock.invocationCallOrder[0];
      const [at] = orderOf("INSERT INTO dbo.DecisionLedger");
      expect(at).toBeGreaterThan(begun);
      expect(at).toBeLessThan(committed);
    });

    it("ledgers a reactivation", async () => {
      db.executeQuery
        .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
        .mockResolvedValueOnce([{ Role: "facilities", Email: "x@co.com", EntraOid: "target-oid", IsActive: false }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await upsertAppUser(makeRequest({ userId: 7, role: "facilities", isActive: true }), ctx);

      const [ledger] = activationRows();
      expect(JSON.parse(paramValue(ledger, "Before") as string)).toEqual({ isActive: false });
      expect(JSON.parse(paramValue(ledger, "After") as string)).toEqual({ isActive: true });
    });

    it("keeps a deactivated account deactivated when an edit omits isActive, and ledgers only the role", async () => {
      db.executeQuery
        .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
        .mockResolvedValueOnce([{ Role: "user", Email: "x@co.com", EntraOid: "target-oid", IsActive: false }])
        .mockResolvedValueOnce([]) // UPDATE
        .mockResolvedValueOnce([]) // audit
        .mockResolvedValueOnce([]); // ledger

      const res = await upsertAppUser(makeRequest({ userId: 7, role: "facilities" }), ctx);

      expect(res.status).toBe(200);
      expect(updateParam("IsActive")).toBe(false);
      expect(activationRows()).toHaveLength(0);
      expect(callsMatching("INSERT INTO dbo.DecisionLedger")).toHaveLength(1);
    });

    it("keeps an active account active when an edit omits isActive", async () => {
      db.executeQuery
        .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
        .mockResolvedValueOnce([{ Role: "user", Email: "x@co.com", EntraOid: "target-oid", IsActive: true }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      await upsertAppUser(makeRequest({ userId: 7, role: "facilities" }), ctx);

      expect(updateParam("IsActive")).toBe(true);
      expect(activationRows()).toHaveLength(0);
    });

    it("writes both ledger rows, in one transaction, when role and activation both change", async () => {
      db.executeQuery
        .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
        .mockResolvedValueOnce([{ Role: "user", Email: "x@co.com", EntraOid: "target-oid", IsActive: true }])
        .mockResolvedValueOnce([]) // UPDATE
        .mockResolvedValueOnce([]) // audit
        .mockResolvedValueOnce([]) // role ledger
        .mockResolvedValueOnce([]); // activation ledger

      const res = await upsertAppUser(makeRequest({ userId: 7, role: "facilities", isActive: false }), ctx);

      expect(res.status).toBe(200);
      expect(callsMatching("INSERT INTO dbo.DecisionLedger").map((c) => paramValue(c, "Action"))).toEqual(["user.role_change", "user.activation_change"]);
      expect(db.commitTransaction).toHaveBeenCalledTimes(1);
      expect(db.rollbackTransaction).not.toHaveBeenCalled();
    });

    it("rolls the deactivation back when the ledger write fails: no ledger row, no decision", async () => {
      db.executeQuery
        .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
        .mockResolvedValueOnce([{ Role: "facilities", Email: "x@co.com", EntraOid: "target-oid", IsActive: true }])
        .mockResolvedValueOnce([]) // UPDATE
        .mockRejectedValueOnce(new Error("ledger unavailable")); // ledger INSERT

      const res = await upsertAppUser(makeRequest({ userId: 7, role: "facilities", isActive: false }), ctx);

      expect(res.status).toBe(500);
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      const [updateAt] = orderOf("UPDATE dbo.AppUsers");
      expect(updateAt).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
      expect(updateAt).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    });

    it("writes no ledger row when neither role nor activation changes", async () => {
      db.executeQuery
        .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
        .mockResolvedValueOnce([{ Role: "facilities", Email: "x@co.com", EntraOid: "target-oid", IsActive: false }])
        .mockResolvedValueOnce([]); // UPDATE

      const res = await upsertAppUser(makeRequest({ userId: 7, role: "facilities", isActive: false }), ctx);

      expect(res.status).toBe(200);
      expect(callsMatching("INSERT INTO dbo.DecisionLedger")).toHaveLength(0);
      expect(callsMatching("INSERT INTO dbo.UserRoleAudit")).toHaveLength(0);
      expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it("refuses a non-boolean isActive before touching the database", async () => {
      const res = await upsertAppUser(makeRequest({ userId: 7, role: "facilities", isActive: "false" }), ctx);

      expect(res.status).toBe(400);
      expect(callsMatching("UPDATE dbo.AppUsers")).toHaveLength(0);
      expect(db.beginTransaction).not.toHaveBeenCalled();
    });
  });

  it("leaves the role untouched on an edit that omits it (no audit or role ledger row)", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
      .mockResolvedValueOnce([{ Role: "facilities", Email: "x@co.com", EntraOid: "target-oid", IsActive: true }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const res = await upsertAppUser(makeRequest({ userId: 7, isActive: false }), ctx);

    expect(res.status).toBe(200);
    expect(paramValue(callsMatching("UPDATE dbo.AppUsers")[0], "Role")).toBe("facilities");
    expect(callsMatching("INSERT INTO dbo.UserRoleAudit")).toHaveLength(0);
    const ledger = callsMatching("INSERT INTO dbo.DecisionLedger");
    expect(ledger).toHaveLength(1);
    expect(JSON.parse(paramValue(ledger[0], "After") as string)).toEqual({ isActive: false });
  });

  describe("the last active admin", () => {
    const target = { Role: "admin", Email: "boss@co.com", EntraOid: "boss-oid", IsActive: true };

    it("cannot be deactivated", async () => {
      db.executeQuery
        .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
        .mockResolvedValueOnce([target])
        .mockResolvedValueOnce([{ Remaining: 0 }]);

      const res = await upsertAppUser(makeRequest({ userId: 7, isActive: false }), ctx);

      expect(res.status).toBe(409);
      expect(callsMatching("UPDATE dbo.AppUsers")).toHaveLength(0);
      expect(db.beginTransaction).not.toHaveBeenCalled();
    });

    it("cannot be demoted", async () => {
      db.executeQuery
        .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
        .mockResolvedValueOnce([target])
        .mockResolvedValueOnce([{ Remaining: 0 }]);

      const res = await upsertAppUser(makeRequest({ userId: 7, role: "director" }), ctx);

      expect(res.status).toBe(409);
    });

    it("can be deactivated when another active admin remains", async () => {
      db.executeQuery
        .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
        .mockResolvedValueOnce([target])
        .mockResolvedValueOnce([{ Remaining: 1 }])
        .mockResolvedValue([]);

      const res = await upsertAppUser(makeRequest({ userId: 7, isActive: false }), ctx);

      expect(res.status).toBe(200);
    });
  });

  it("ledgers clearing a role (null) as a change", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
      .mockResolvedValueOnce([{ Role: "facilities", Email: "x@co.com", EntraOid: "target-oid" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    await upsertAppUser(makeRequest({ userId: 7, role: null }), ctx);

    const [ledger] = callsMatching("INSERT INTO dbo.DecisionLedger");
    expect(JSON.parse(paramValue(ledger, "Before") as string)).toEqual({ role: "facilities" });
    expect(JSON.parse(paramValue(ledger, "After") as string)).toEqual({ role: null });
  });

  describe("inviting a user with a role", () => {
    const invite = () => {
      db.executeQuery
        .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
        .mockResolvedValueOnce([]) // duplicate-email check
        .mockResolvedValueOnce([{ UserID: 99 }]) // INSERT
        .mockResolvedValueOnce([]); // audit
      return upsertAppUser(makeRequest({ email: "jane@co.com", role: "facilities" }), ctx);
    };

    it("ledgers the initial role against the new user's id", async () => {
      const res = await invite();

      expect(res.status).toBe(201);
      const [ledger] = callsMatching("INSERT INTO dbo.DecisionLedger");
      expect(paramValue(ledger, "SubjectId")).toBe("99");
      expect(JSON.parse(paramValue(ledger, "Before") as string)).toEqual({ role: null });
      expect(JSON.parse(paramValue(ledger, "After") as string)).toEqual({ role: "facilities" });
      expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    });

    it("rolls the invite back when the ledger write fails", async () => {
      db.executeQuery
        .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ UserID: 99 }])
        .mockResolvedValueOnce([])
        .mockRejectedValueOnce(new Error("ledger unavailable"));

      const res = await upsertAppUser(makeRequest({ email: "jane@co.com", role: "facilities" }), ctx);

      expect(res.status).toBe(500);
      expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
      expect(db.commitTransaction).not.toHaveBeenCalled();
      const begun = db.beginTransaction.mock.invocationCallOrder[0];
      const rolledBack = db.rollbackTransaction.mock.invocationCallOrder[0];
      const [insertAt] = orderOf("INSERT INTO dbo.AppUsers");
      expect(insertAt).toBeGreaterThan(begun);
      expect(insertAt).toBeLessThan(rolledBack);
    });
  });

  it("writes no ledger row for an invite without a role", async () => {
    db.executeQuery
      .mockResolvedValueOnce([{ UserID: 3, DisplayName: "Admin User" }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ UserID: 99 }]);

    const res = await upsertAppUser(makeRequest({ email: "jane@co.com" }), ctx);

    expect(res.status).toBe(201);
    expect(callsMatching("INSERT INTO dbo.DecisionLedger")).toHaveLength(0);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
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
