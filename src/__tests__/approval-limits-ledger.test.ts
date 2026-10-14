/// <reference types="jest" />
// setApprovalLimit writes a decision-ledger row in the same transaction as the
// limit it changes (WP19b). The DB layer is mocked; auth flows through the real
// rolesForRequest / verifiedIdentityFromRequest paths using the dev-override
// header and an unsigned JWT, as inspections-ops.test.ts does.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { clearRoleCache } from "../auth";
import { setApprovalLimit } from "../functions/approval-limits";

jest.mock("../db", () => ({
  beginTransaction:        jest.fn(),
  closeConnection:         jest.fn(),
  commitTransaction:       jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery:            jest.fn(),
  rollbackTransaction:     jest.fn(),
}));

jest.mock("../approval-limits-db", () => ({ invalidateApprovalLimitsCache: jest.fn() }));

const db = require("../db") as {
  beginTransaction:        jest.Mock;
  closeConnection:         jest.Mock;
  commitTransaction:       jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery:            jest.Mock;
  rollbackTransaction:     jest.Mock;
};
const limitsCache = require("../approval-limits-db") as { invalidateApprovalLimitsCache: jest.Mock };

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function authHeaders(roles: string): Record<string, string> {
  return {
    authorization: `Bearer ${makeJwt({ name: "Ada Admin", oid: "oid-ada", preferred_username: "ada@example.com" })}`,
    "x-dev-roles": roles,
  };
}

function makeRequest(body: unknown, headers: Record<string, string> = authHeaders("admin")): HttpRequest {
  return {
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as HttpRequest;
}

function makeContext(): InvocationContext {
  return { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
}

type Row = Record<string, unknown>;
type SqlParam = { name: string; options?: { precision?: number; scale?: number }; type: unknown; value: unknown };
type SqlCall = [unknown, string, SqlParam[]];

const LOCK_READ = "WITH (UPDLOCK, HOLDLOCK) WHERE RoleName";

/** Routes executeQuery by SQL substring; unmatched statements return []. */
function mockDb(routes: { match: string; rows?: Row[]; reject?: Error }[]): void {
  db.executeQuery.mockImplementation(async (_conn: unknown, sql: string) => {
    for (const r of routes) {
      if (sql.includes(r.match)) {
        if (r.reject) throw r.reject;
        return r.rows ?? [];
      }
    }
    return [];
  });
}

const callsMatching = (needle: string): SqlCall[] =>
  (db.executeQuery.mock.calls as SqlCall[]).filter(([, sql]) => sql.includes(needle));
const param = (call: SqlCall, name: string): SqlParam | undefined => call[2].find((p) => p.name === name);
const orderOf = (needle: string): number => {
  const i = (db.executeQuery.mock.calls as SqlCall[]).findIndex(([, sql]) => sql.includes(needle));
  return db.executeQuery.mock.invocationCallOrder[i];
};

const ADA = { match: "FROM dbo.AppUsers WHERE EntraOid", rows: [{ UserID: 3 }] };

beforeEach(() => {
  jest.clearAllMocks();
  clearRoleCache();
  db.createRequestConnection.mockResolvedValue({});
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
  mockDb([ADA]);
});

describe("setApprovalLimit gate", () => {
  it("is admin-only: a director is refused and nothing is touched", async () => {
    const res = await setApprovalLimit(makeRequest({ MaxApprovalAmount: 5000, RoleName: "accounts" }, authHeaders("director")), makeContext());

    expect(res.status).toBe(403);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("answers 401 without a token", async () => {
    const res = await setApprovalLimit(makeRequest({ MaxApprovalAmount: 5000, RoleName: "accounts" }, {}), makeContext());
    expect(res.status).toBe(401);
  });

  it("validates the body before starting a transaction", async () => {
    for (const body of [{ MaxApprovalAmount: 5, RoleName: " " }, { MaxApprovalAmount: -1, RoleName: "accounts" }, { MaxApprovalAmount: "5", RoleName: "accounts" }]) {
      const res = await setApprovalLimit(makeRequest(body), makeContext());
      expect(res.status).toBe(400);
    }
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });
});

describe("changing an existing limit", () => {
  const raise = () => {
    mockDb([ADA, { match: LOCK_READ, rows: [{ MaxApprovalAmount: 1000 }] }]);
    return setApprovalLimit(makeRequest({ MaxApprovalAmount: 5000, RoleName: "accounts" }), makeContext());
  };

  it("records who changed it, from what, to what", async () => {
    const res = await raise();

    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ maxApprovalAmount: 5000, ok: true, roleName: "accounts" });
    const [ledger] = callsMatching("INSERT INTO dbo.DecisionLedger");
    expect(param(ledger, "Action")?.value).toBe("approval_limit.change");
    expect(param(ledger, "SubjectType")?.value).toBe("approval_limit");
    expect(param(ledger, "SubjectId")?.value).toBe("accounts");
    expect(param(ledger, "ActorName")?.value).toBe("Ada Admin");
    expect(param(ledger, "ActorRole")?.value).toBe("admin");
    expect(param(ledger, "ActorUserId")?.value).toBe(3);
    expect(param(ledger, "IsException")?.value).toBe(true);
    expect(JSON.parse(param(ledger, "Before")?.value as string)).toEqual({ maxApprovalAmount: 1000 });
    expect(JSON.parse(param(ledger, "After")?.value as string)).toEqual({ maxApprovalAmount: 5000 });
  });

  it("reads the old value under a lock, merges, and ledgers, all inside one transaction that commits", async () => {
    await raise();

    const begun = db.beginTransaction.mock.invocationCallOrder[0];
    const committed = db.commitTransaction.mock.invocationCallOrder[0];
    const read = orderOf(LOCK_READ);
    const merge = orderOf("MERGE dbo.ApprovalLimits");
    const ledger = orderOf("INSERT INTO dbo.DecisionLedger");
    expect(begun).toBeLessThan(read);
    expect(read).toBeLessThan(merge);
    expect(merge).toBeLessThan(ledger);
    expect(ledger).toBeLessThan(committed);
    expect(db.rollbackTransaction).not.toHaveBeenCalled();
    expect(limitsCache.invalidateApprovalLimitsCache).toHaveBeenCalledTimes(1);
  });

  it("rolls the limit back when the ledger write fails: no ledger row, no decision", async () => {
    mockDb([ADA, { match: LOCK_READ, rows: [{ MaxApprovalAmount: 1000 }] }, { match: "INSERT INTO dbo.DecisionLedger", reject: new Error("ledger unavailable") }]);

    const res = await setApprovalLimit(makeRequest({ MaxApprovalAmount: 5000, RoleName: "accounts" }), makeContext());

    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    // The MERGE ran inside the transaction that was rolled back.
    expect(orderOf("MERGE dbo.ApprovalLimits")).toBeGreaterThan(db.beginTransaction.mock.invocationCallOrder[0]);
    expect(orderOf("MERGE dbo.ApprovalLimits")).toBeLessThan(db.rollbackTransaction.mock.invocationCallOrder[0]);
    // The cached limits still describe the pre-change world.
    expect(limitsCache.invalidateApprovalLimitsCache).not.toHaveBeenCalled();
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("rolls back when the MERGE itself fails, writing no ledger row", async () => {
    mockDb([ADA, { match: LOCK_READ, rows: [{ MaxApprovalAmount: 1000 }] }, { match: "MERGE dbo.ApprovalLimits", reject: new Error("deadlock") }]);

    const res = await setApprovalLimit(makeRequest({ MaxApprovalAmount: 5000, RoleName: "accounts" }), makeContext());

    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(callsMatching("INSERT INTO dbo.DecisionLedger")).toHaveLength(0);
  });

  it("ledgers a move to unlimited (null) and from it", async () => {
    mockDb([ADA, { match: LOCK_READ, rows: [{ MaxApprovalAmount: 1000 }] }]);
    await setApprovalLimit(makeRequest({ MaxApprovalAmount: null, RoleName: "accounts" }), makeContext());
    let [ledger] = callsMatching("INSERT INTO dbo.DecisionLedger");
    expect(JSON.parse(param(ledger, "After")?.value as string)).toEqual({ maxApprovalAmount: null });

    jest.clearAllMocks();
    mockDb([ADA, { match: LOCK_READ, rows: [{ MaxApprovalAmount: null }] }]);
    await setApprovalLimit(makeRequest({ MaxApprovalAmount: 2500, RoleName: "accounts" }), makeContext());
    [ledger] = callsMatching("INSERT INTO dbo.DecisionLedger");
    expect(JSON.parse(param(ledger, "Before")?.value as string)).toEqual({ maxApprovalAmount: null });
    expect(JSON.parse(param(ledger, "After")?.value as string)).toEqual({ maxApprovalAmount: 2500 });
  });

  it("writes no ledger row when re-saving the value the role already has", async () => {
    mockDb([ADA, { match: LOCK_READ, rows: [{ MaxApprovalAmount: 1000 }] }]);

    const res = await setApprovalLimit(makeRequest({ MaxApprovalAmount: 1000, RoleName: "accounts" }), makeContext());

    expect(res.status).toBe(200);
    expect(callsMatching("INSERT INTO dbo.DecisionLedger")).toHaveLength(0);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("sends the amount with cents (DECIMAL 18,2) and settles on whole cents", async () => {
    mockDb([ADA, { match: LOCK_READ, rows: [{ MaxApprovalAmount: 1000 }] }]);

    const res = await setApprovalLimit(makeRequest({ MaxApprovalAmount: 1234.567, RoleName: "accounts" }), makeContext());

    const [merge] = callsMatching("MERGE dbo.ApprovalLimits");
    expect(param(merge, "MaxApprovalAmount")).toMatchObject({ options: { precision: 18, scale: 2 }, type: TYPES.Decimal, value: 1234.57 });
    expect(res.jsonBody).toMatchObject({ maxApprovalAmount: 1234.57 });
    const [ledger] = callsMatching("INSERT INTO dbo.DecisionLedger");
    expect(JSON.parse(param(ledger, "After")?.value as string)).toEqual({ maxApprovalAmount: 1234.57 });
  });
});

describe("setting a limit for a role that has none yet", () => {
  it("ledgers the first value with no 'before'", async () => {
    mockDb([ADA, { match: LOCK_READ, rows: [] }]);

    const res = await setApprovalLimit(makeRequest({ MaxApprovalAmount: 750, RoleName: "cfo" }), makeContext());

    expect(res.status).toBe(200);
    const [ledger] = callsMatching("INSERT INTO dbo.DecisionLedger");
    expect(param(ledger, "Before")?.value).toBeNull();
    expect(JSON.parse(param(ledger, "After")?.value as string)).toEqual({ maxApprovalAmount: 750 });
  });
});

describe("a role name the ledger can't hold", () => {
  it("is refused with a 400 and rolled back, not saved without its ledger row", async () => {
    mockDb([ADA, { match: LOCK_READ, rows: [] }]);

    const res = await setApprovalLimit(makeRequest({ MaxApprovalAmount: 750, RoleName: "x".repeat(65) }), makeContext());

    expect(res.status).toBe(400);
    expect(res.jsonBody).toEqual({ error: expect.stringMatching(/longer than 64/) });
    expect(db.rollbackTransaction).toHaveBeenCalledTimes(1);
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(callsMatching("INSERT INTO dbo.DecisionLedger")).toHaveLength(0);
  });
});
