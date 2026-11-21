/// <reference types="jest" />
// SECA-02 / D5: a grant of director, cfo or admin waits for a second person.
import { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Error" }, status: 500 }),
    extractToken: jest.fn().mockReturnValue("t"),
    requireRole: jest.fn().mockResolvedValue(null),
    rolesForRequest: jest.fn().mockResolvedValue(["admin"]),
    unauthorizedResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Unauthorized" }, status: 401 }),
    verifiedIdentityFromRequest: jest.fn(),
  };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn(),
  createServiceRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../sentry", () => ({ Sentry: { captureException: jest.fn(), captureMessage: jest.fn() } }));

const auth = require("../auth") as { rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as { createServiceRequestConnection: jest.Mock; executeQuery: jest.Mock; commitTransaction: jest.Mock; rollbackTransaction: jest.Mock; beginTransaction: jest.Mock };
const { upsertAppUser } = require("./users") as { upsertAppUser: (r: HttpRequest, c: InvocationContext) => Promise<{ jsonBody?: any; status?: number }> };
const { decideRoleGrant } = require("./roleGrants") as { decideRoleGrant: (r: HttpRequest, c: InvocationContext) => Promise<{ jsonBody?: any; status?: number }> };
const { _resetRateLimitForTests } = require("../rateLimit") as { _resetRateLimitForTests: () => void };
const { twoPersonGrantEnabled, needsSecondPerson, grantDecisionRefusal } = require("../roleGrants") as typeof import("../roleGrants");

const req = (body: unknown) => ({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body) }) as unknown as HttpRequest;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const sqls = () => db.executeQuery.mock.calls.map((c: unknown[]) => String(c[1]));
const ledgerActions = () =>
  db.executeQuery.mock.calls
    .filter((c: unknown[]) => /INSERT INTO dbo\.DecisionLedger/.test(String(c[1])))
    .map((c: unknown[]) => Object.fromEntries((c[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value])).Action);

function mockSql(rows: Record<string, Record<string, unknown>[]>): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    const hit = Object.entries(rows).find(([re]) => new RegExp(re).test(sql));
    return hit ? hit[1] : /OUTPUT INSERTED\.GrantID/.test(sql) ? [{ GrantID: 31 }] : [];
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset();
  _resetRateLimitForTests();
  delete process.env.PRIVILEGED_GRANT_TWO_PERSON;
  auth.rolesForRequest.mockResolvedValue(["admin"]);
  auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "a@co.com", name: "Alex Admin", oid: "oid-admin" });
  db.createServiceRequestConnection.mockResolvedValue({});
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
});

describe("the setting and the rule", () => {
  it("is on unless it says false", () => {
    expect(twoPersonGrantEnabled({})).toBe(true);
    expect(twoPersonGrantEnabled({ PRIVILEGED_GRANT_TWO_PERSON: "true" })).toBe(true);
    expect(twoPersonGrantEnabled({ PRIVILEGED_GRANT_TWO_PERSON: "banana" })).toBe(true);
    expect(twoPersonGrantEnabled({ PRIVILEGED_GRANT_TWO_PERSON: "false" })).toBe(false);
  });
  it("applies to a move to director, cfo or admin only", () => {
    expect(needsSecondPerson("facilities", "director")).toBe(true);
    expect(needsSecondPerson(null, "admin")).toBe(true);
    expect(needsSecondPerson("director", "director")).toBe(false);
    expect(needsSecondPerson("director", "facilities")).toBe(false);
    expect(needsSecondPerson("facilities", "director", false)).toBe(false);
  });
  it("lets the requester withdraw, and no one on a say-so of their own", () => {
    const grant = { requestedByOid: "r", targetOid: "t" };
    expect(grantDecisionRefusal("withdraw", "r", ["admin"], grant)).toBeNull();
    expect(grantDecisionRefusal("withdraw", "x", ["director"], grant)).not.toBeNull();
    expect(grantDecisionRefusal("confirm", "r", ["admin"], grant)).toMatch(/you asked/);
    expect(grantDecisionRefusal("confirm", "t", ["director"], grant)).toMatch(/for yourself/);
    expect(grantDecisionRefusal("confirm", "x", ["cfo"], grant)).not.toBeNull();
    expect(grantDecisionRefusal("confirm", "x", ["director"], grant)).toBeNull();
  });
});

describe("upsertAppUser granting director", () => {
  const existing = { "SELECT Role, Email, EntraOid, IsActive": [{ Email: "p@co.com", EntraOid: "oid-p", IsActive: true, Role: "facilities_manager" }] };

  it("records the request as pending and leaves the role as it was", async () => {
    mockSql(existing);

    const res = await upsertAppUser(req({ role: "director", userId: 7 }), ctx);

    expect(res.status).toBe(202);
    expect(res.jsonBody.pendingGrant).toEqual({ grantId: 31, role: "director" });
    const update = db.executeQuery.mock.calls.find((c: unknown[]) => /UPDATE dbo\.AppUsers/.test(String(c[1])));
    expect(Object.fromEntries((update![2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value])).Role).toBe("facilities_manager");
    expect(sqls().some((s) => /INSERT INTO dbo\.PendingRoleGrants/.test(s))).toBe(true);
    expect(ledgerActions()).toEqual(["user.role_grant_requested"]);
  });

  it("with the setting off, applies it at once as before", async () => {
    process.env.PRIVILEGED_GRANT_TWO_PERSON = "false";
    mockSql(existing);

    const res = await upsertAppUser(req({ role: "director", userId: 7 }), ctx);

    expect(res.status).toBe(200);
    expect(sqls().some((s) => /INSERT INTO dbo\.PendingRoleGrants/.test(s))).toBe(false);
    expect(ledgerActions()).toEqual(["user.role_change"]);
  });

  it("an invite naming director starts with no role and a pending request", async () => {
    mockSql({ "SELECT 1 AS Hit": [], "OUTPUT INSERTED\\.UserID": [{ UserID: 55 }] });

    const res = await upsertAppUser(req({ email: "new@co.com", role: "director" }), ctx);

    expect(res.status).toBe(202);
    const insert = db.executeQuery.mock.calls.find((c: unknown[]) => /INSERT INTO dbo\.AppUsers/.test(String(c[1])));
    expect(Object.fromEntries((insert![2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value])).Role).toBeNull();
    expect(ledgerActions()).toEqual(["user.role_grant_requested"]);
  });

  it("a change to a lower role is not held", async () => {
    mockSql(existing);
    expect((await upsertAppUser(req({ role: "accounts", userId: 7 }), ctx)).status).toBe(200);
  });
});

describe("decideRoleGrant", () => {
  const pending = (over: Record<string, unknown> = {}, requester: Record<string, unknown> | null = { IsActive: true, Role: "admin" }) => ({
    "FROM dbo\\.PendingRoleGrants g": [{ CurrentRole: "facilities_manager", GrantID: 31, PreviousRole: "facilities_manager", RequestedByOid: "oid-admin", RequestedRole: "director", Status: "pending", TargetActive: true, TargetEmail: "p@co.com", TargetOid: "oid-p", TargetUserID: 7, ...over }],
    "SELECT Role, IsActive FROM dbo\\.AppUsers WHERE EntraOid": requester ? [requester] : [],
  });
  const asDirector = () => {
    auth.rolesForRequest.mockResolvedValue(["director"]);
    auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "d@co.com", name: "Dana Director", oid: "oid-dir" });
  };

  it("the person who asked cannot confirm it, and nothing changes", async () => {
    mockSql(pending());
    const res = await decideRoleGrant(req({ decision: "confirm", grantId: 31 }), ctx);
    expect(res.status).toBe(403);
    expect(sqls().some((s) => /UPDATE dbo\.AppUsers/.test(s))).toBe(false);
  });

  it("the person being granted cannot confirm their own", async () => {
    asDirector();
    auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "p@co.com", name: "Pat", oid: "oid-p" });
    mockSql(pending());
    expect((await decideRoleGrant(req({ decision: "confirm", grantId: 31 }), ctx)).status).toBe(403);
  });

  it("a different director confirms: the role is applied and both steps are in the ledger", async () => {
    asDirector();
    mockSql(pending());

    const res = await decideRoleGrant(req({ decision: "confirm", grantId: 31 }), ctx);

    expect(res.status).toBe(200);
    expect(sqls().some((s) => /UPDATE dbo\.AppUsers SET Role/.test(s))).toBe(true);
    expect(ledgerActions()).toEqual(["user.role_change", "user.role_grant_confirmed"]);
  });

  it("a decline leaves the role alone", async () => {
    asDirector();
    mockSql(pending());
    expect((await decideRoleGrant(req({ decision: "decline", grantId: 31 }), ctx)).status).toBe(200);
    expect(sqls().some((s) => /UPDATE dbo\.AppUsers/.test(s))).toBe(false);
    expect(ledgerActions()).toEqual(["user.role_grant_declined"]);
  });

  it("the requester can withdraw it", async () => {
    mockSql(pending());
    expect((await decideRoleGrant(req({ decision: "withdraw", grantId: 31 }), ctx)).status).toBe(200);
    expect(ledgerActions()).toEqual(["user.role_grant_withdrawn"]);
  });

  it("a request already dealt with is a 409", async () => {
    asDirector();
    mockSql(pending({ Status: "confirmed" }));
    expect((await decideRoleGrant(req({ decision: "confirm", grantId: 31 }), ctx)).status).toBe(409);
  });

  // REV-08: confirming acts on the facts as they are now.
  describe("a request that has gone stale is closed, not applied", () => {
    const appliedRole = () => sqls().some((s) => /UPDATE dbo\.AppUsers SET Role/.test(s));
    const closed = () => sqls().some((s) => /SET Status = N'superseded'/.test(s));

    it.each([
      ["the person's account was switched off", pending({ TargetActive: false })],
      ["their role changed since it was asked", pending({ CurrentRole: "accounts" })],
      ["the person who asked is no longer an admin", pending({}, { IsActive: true, Role: "facilities" })],
      ["the person who asked is switched off", pending({}, { IsActive: false, Role: "admin" })],
      ["the person who asked is gone", pending({}, null)],
    ])("%s", async (_name, rows) => {
      asDirector();
      mockSql(rows);
      const res = await decideRoleGrant(req({ decision: "confirm", grantId: 31 }), ctx);
      expect(res).toMatchObject({ jsonBody: { code: "role_grant_stale" }, status: 409 });
      expect(appliedRole()).toBe(false);
      expect(closed()).toBe(true);
      expect(ledgerActions()).toEqual([]);
    });

    it("does not demote the last active admin", async () => {
      asDirector();
      mockSql({ ...pending({ CurrentRole: "admin", PreviousRole: "admin", RequestedRole: "director" }), "SELECT COUNT\\(\\*\\) AS Remaining": [{ Remaining: 0 }] });
      const res = await decideRoleGrant(req({ decision: "confirm", grantId: 31 }), ctx);
      expect(res).toMatchObject({ jsonBody: { error: "Cannot demote the last active admin." }, status: 409 });
      expect(appliedRole()).toBe(false);
    });

    it("a decline or withdrawal still works on a request that has gone stale", async () => {
      asDirector();
      mockSql(pending({ TargetActive: false }));
      expect((await decideRoleGrant(req({ decision: "decline", grantId: 31 }), ctx)).status).toBe(200);
    });
  });

  it("confirming a reactivation switches the account back on as well", async () => {
    asDirector();
    mockSql(pending({ CurrentRole: "director", PreviousRole: "director", RequestedRole: "director", TargetActive: false }));
    expect((await decideRoleGrant(req({ decision: "confirm", grantId: 31 }), ctx)).status).toBe(200);
    expect(sqls().some((s) => /UPDATE dbo\.AppUsers SET Role = @Role, IsActive = 1/.test(s))).toBe(true);
  });
});

describe("upsertAppUser: older requests and reactivation (REV-08)", () => {
  const user = (over: Record<string, unknown>) => ({ "SELECT Role, Email, EntraOid, IsActive": [{ Email: "p@co.com", EntraOid: "oid-p", IsActive: true, Role: "facilities_manager", ...over }] });
  const params = (re: RegExp) => Object.fromEntries((db.executeQuery.mock.calls.find((c: unknown[]) => re.test(String(c[1])))![2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value]));

  it("a change to a lower role closes the older pending request", async () => {
    mockSql(user({}));
    expect((await upsertAppUser(req({ role: "accounts", userId: 7 }), ctx)).status).toBe(200);
    expect(sqls().some((s) => /UPDATE dbo\.PendingRoleGrants SET Status = N'superseded'/.test(s))).toBe(true);
  });

  it("switching a deactivated director back on takes a second person: the account stays off", async () => {
    mockSql(user({ IsActive: false, Role: "director" }));
    const res = await upsertAppUser(req({ isActive: true, userId: 7 }), ctx);
    expect(res.status).toBe(202);
    expect(params(/UPDATE dbo\.AppUsers/)).toMatchObject({ IsActive: false, Role: "director" });
    expect(ledgerActions()).toEqual(["user.role_grant_requested"]);
  });

  it("switching a deactivated non-privileged user back on is immediate", async () => {
    mockSql(user({ IsActive: false }));
    const res = await upsertAppUser(req({ isActive: true, userId: 7 }), ctx);
    expect(res.status).toBe(200);
    expect(params(/UPDATE dbo\.AppUsers/)).toMatchObject({ IsActive: true });
  });
});
