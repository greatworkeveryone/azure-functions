/// <reference types="jest" />
// getDecisionHistory: who may ask about which subject, what it asks the ledger,
// and what comes back. The DB is mocked; auth uses the real requireRole through
// the dev-override header and an unsigned JWT (same harness as inspections-ops).
import { HttpRequest, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { clearRoleCache } from "../auth";
import { getDecisionHistory } from "../functions/getDecisionHistory";
import { historyReadRoles } from "../ledger/historyRoles";

jest.mock("../db", () => ({
  closeConnection:         jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery:            jest.fn(),
}));

const db = require("../db") as { closeConnection: jest.Mock; createRequestConnection: jest.Mock; executeQuery: jest.Mock };

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (obj: unknown) =>
    Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `${encode({ alg: "none" })}.${encode(payload)}.sig`;
}

function authHeaders(roles: string): Record<string, string> {
  return {
    authorization: `Bearer ${makeJwt({ name: "Test User", oid: "oid-tester", preferred_username: "t@example.com" })}`,
    "x-dev-roles": roles,
  };
}

function makeRequest(query: Record<string, string>, headers: Record<string, string>): HttpRequest {
  return {
    headers: { get: (key: string) => headers[key.toLowerCase()] ?? null },
    query: new URLSearchParams(query),
  } as unknown as HttpRequest;
}

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

type SqlCall = [unknown, string, { name: string; type: unknown; value: unknown }[]];
const lastQuery = (): SqlCall => db.executeQuery.mock.calls.at(-1) as SqlCall;

function ledgerRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    LedgerId: "17",
    OccurredAt: new Date("2026-10-13T01:00:00Z"),
    Action: "quote.approve_attributed",
    SubjectType: "quote",
    SubjectId: "5",
    TenantId: null,
    JobId: 99,
    BuildingId: 4,
    ActorUserId: 11,
    ActorName: "Fay Staff",
    ActorRole: "facilities",
    ActorKind: "user",
    AttributedUserId: 12,
    AttributedName: "Mo Manager",
    AttributedRole: "facilities_manager",
    Reason: null,
    Before: null,
    After: '{"status":"approved"}',
    Computed: null,
    FinancialImpact: null,
    RuleApplied: null,
    CorrelationId: "6F9619FF-8B86-D011-B42D-00C04FC964FF",
    IsException: false,
    ...overrides,
  };
}

const ask = (query: Record<string, string>, roles = "director") => getDecisionHistory(makeRequest(query, authHeaders(roles)), ctx);

beforeEach(() => {
  jest.clearAllMocks();
  clearRoleCache();
  db.createRequestConnection.mockResolvedValue({});
  db.executeQuery.mockResolvedValue([]);
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  delete process.env.AZURE_FUNCTIONS_ENVIRONMENT;
});

describe("authentication and validation", () => {
  it("answers 401 without a token", async () => {
    const res = await getDecisionHistory(makeRequest({ subjectId: "1", subjectType: "job" }, {}), ctx);
    expect(res.status).toBe(401);
  });

  it.each(["", "Job", "job space", "1job", "x".repeat(33), "job';--"])("answers 400 for subjectType %j", async (subjectType) => {
    const res = await ask({ subjectId: "1", subjectType });
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("answers 400 for a missing or over-long subjectId", async () => {
    expect((await ask({ subjectType: "quote" })).status).toBe(400);
    expect((await ask({ subjectId: "x".repeat(65), subjectType: "quote" })).status).toBe(400);
  });

  it.each([["job", "abc"], ["job", "1.5"], ["job", "0"], ["job", "99999999999"], ["tenancy", "-4"], ["tenancy", "7 OR 1=1"]])(
    "answers 400 for a %s id of %j",
    async (subjectType, subjectId) => {
      const res = await ask({ subjectId, subjectType });
      expect(res.status).toBe(400);
      expect(db.executeQuery).not.toHaveBeenCalled();
    },
  );
});

describe("who may read which history (each list mirrors that subject's own read endpoint)", () => {
  const allowed = async (subjectType: string, role: string) =>
    (await ask({ subjectId: "5", subjectType }, role)).status === 200;

  it("job history: the roles that can read a job", async () => {
    for (const role of ["admin", "director", "facilities", "facilities_manager", "accounts", "accounts_manager"]) {
      expect(await allowed("job", role)).toBe(true);
    }
    expect(await allowed("job", "user")).toBe(false);
  });

  it("tenancy history: the roles that can read a tenancy (accounts side, directors, admin)", async () => {
    for (const role of ["admin", "director", "accounts", "accounts_manager"]) {
      expect(await allowed("tenancy", role)).toBe(true);
    }
    for (const role of ["facilities", "facilities_manager", "user"]) {
      expect(await allowed("tenancy", role)).toBe(false);
    }
  });

  it("quote, invoice and purchase order history: whoever reads those documents", async () => {
    for (const subject of ["quote", "invoice", "purchase_order"]) {
      expect(await allowed(subject, "facilities")).toBe(true);
      expect(await allowed(subject, "accounts_manager")).toBe(true);
      expect(await allowed(subject, "user")).toBe(false);
    }
  });

  it("payment history: accounts side and directors only, as getPayments", async () => {
    expect(await allowed("payment", "accounts")).toBe(true);
    expect(await allowed("payment", "director")).toBe(true);
    expect(await allowed("payment", "facilities")).toBe(false);
    expect(await allowed("payment", "facilities_manager")).toBe(false);
  });

  it("a subject with no read endpoint of its own yet is director-only (admin passes)", async () => {
    for (const subject of ["billing_run", "app_user", "approval_limit", "escalation"]) {
      expect(await allowed(subject, "director")).toBe(true);
      expect(await allowed(subject, "admin")).toBe(true);
      expect(await allowed(subject, "accounts_manager")).toBe(false);
      expect(await allowed(subject, "facilities")).toBe(false);
    }
  });

  it("does not trust a subjectType that names an Object.prototype member", async () => {
    expect(historyReadRoles("constructor")).toEqual(["director"]);
    expect(await allowed("constructor", "accounts")).toBe(false);
    expect(await allowed("constructor", "director")).toBe(true);
  });

  it("refuses before querying anything when the role is wrong", async () => {
    const res = await ask({ subjectId: "5", subjectType: "tenancy" }, "facilities");
    expect(res.status).toBe(403);
    expect(db.executeQuery).not.toHaveBeenCalled();
    expect(db.createRequestConnection).not.toHaveBeenCalled();
  });
});

describe("what it asks the ledger", () => {
  it("tenancy: the tenancy's own rows OR rows scoped to that tenant", async () => {
    await ask({ subjectId: "42", subjectType: "tenancy" });

    const [, sql, params] = lastQuery();
    expect(sql).toMatch(/WHERE \(SubjectType = @SubjectType AND SubjectId = @SubjectId\) OR TenantId = @ScopeId/);
    expect(params).toEqual([
      { name: "SubjectType", type: TYPES.NVarChar, value: "tenancy" },
      { name: "SubjectId", type: TYPES.NVarChar, value: "42" },
      { name: "ScopeId", type: TYPES.Int, value: 42 },
    ]);
  });

  it("job: the job's own rows OR rows scoped to that job", async () => {
    await ask({ subjectId: "99", subjectType: "job" });

    const [, sql, params] = lastQuery();
    expect(sql).toMatch(/WHERE \(SubjectType = @SubjectType AND SubjectId = @SubjectId\) OR JobId = @ScopeId/);
    expect(params.find((p) => p.name === "ScopeId")).toEqual({ name: "ScopeId", type: TYPES.Int, value: 99 });
  });

  it("anything else: exactly that subject, nothing wider", async () => {
    await ask({ subjectId: "accounts", subjectType: "approval_limit" });

    const [, sql, params] = lastQuery();
    expect(sql).toMatch(/WHERE SubjectType = @SubjectType AND SubjectId = @SubjectId\s+ORDER BY/);
    expect(sql).not.toMatch(/\bOR\b/);
    expect(params.map((p) => p.name)).toEqual(["SubjectType", "SubjectId"]);
  });

  it("returns the newest 200, newest first, from the ledger table, with no SELECT *", async () => {
    await ask({ subjectId: "5", subjectType: "quote" });

    const [, sql] = lastQuery();
    expect(sql).toMatch(/SELECT TOP 200 /);
    expect(sql).toMatch(/FROM dbo\.DecisionLedger/);
    expect(sql).toMatch(/ORDER BY OccurredAt DESC, LedgerId DESC/);
    expect(sql).not.toMatch(/SELECT\s+\*/);
  });

  it("binds the id and type instead of writing them into the statement", async () => {
    await ask({ subjectId: "o'brien", subjectType: "approval_limit" });
    expect(lastQuery()[1]).not.toContain("brien");
  });
});

describe("what comes back", () => {
  it("is { items } only, mapped to DecisionRow, with attribution", async () => {
    db.executeQuery.mockResolvedValue([ledgerRow()]);

    const res = await ask({ subjectId: "99", subjectType: "job" }, "facilities");

    expect(res.status).toBe(200);
    expect(Object.keys(res.jsonBody as object)).toEqual(["items"]);
    expect((res.jsonBody as { items: unknown[] }).items).toEqual([
      {
        action: "quote.approve_attributed",
        actor: { kind: "user", name: "Fay Staff", role: "facilities", userId: 11 },
        after: { status: "approved" },
        attributedTo: { name: "Mo Manager", role: "facilities_manager", userId: 12 },
        before: null,
        buildingId: 4,
        computed: null,
        correlationId: "6f9619ff-8b86-d011-b42d-00c04fc964ff",
        financialImpact: null,
        isException: false,
        jobId: 99,
        ledgerId: 17,
        occurredAt: "2026-10-13T01:00:00.000Z",
        reason: null,
        ruleApplied: null,
        subjectId: "5",
        subjectType: "quote",
        tenantId: null,
      },
    ]);
  });

  it("returns an empty list for a subject with no history", async () => {
    const res = await ask({ subjectId: "5", subjectType: "job" });
    expect(res.jsonBody).toEqual({ items: [] });
  });

  it("answers 500 and still closes the connection when the query fails", async () => {
    db.executeQuery.mockRejectedValue(new Error("boom"));

    const res = await ask({ subjectId: "5", subjectType: "job" });

    expect(res.status).toBe(500);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});
