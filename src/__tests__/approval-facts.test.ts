/// <reference types="jest" />
// R13's Admin facts (the variance margin and cap) and the picker of managers who
// could approve an amount themselves (R2, R13). DB mocked; the real ledger runs.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { ledgerInserts } from "./fixtures/ledgerCalls";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Error" }, status: 500 }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn(),
    rolesForRequest: jest.fn(),
    unauthorizedResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Unauthorized" }, status: 401 }),
    verifiedIdentityFromRequest: jest.fn(),
  };
});
jest.mock("../moneyGate", () => ({ requireMoneyContext: jest.fn().mockResolvedValue(null) }));
jest.mock("../approval-limits-db", () => ({ getCachedApprovalLimits: jest.fn() }));

const auth = require("../auth") as { requireRole: jest.Mock; rolesForRequest: jest.Mock; verifiedIdentityFromRequest: jest.Mock };
const db = require("../db") as { beginTransaction: jest.Mock; commitTransaction: jest.Mock; createRequestConnection: jest.Mock; executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const limitsDb = require("../approval-limits-db") as { getCachedApprovalLimits: jest.Mock };
const gate = require("../moneyGate") as { requireMoneyContext: jest.Mock };
type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ jsonBody?: unknown; status?: number }>;
const { setApprovalFact } = require("../functions/approval-facts") as { setApprovalFact: Handler };
const { getApprovalCandidates } = require("../functions/getApprovalCandidates") as { getApprovalCandidates: Handler };
const { isMoneyGatedRoute } = require("../money-gated-routes") as { isMoneyGatedRoute: (route: string) => boolean };

type Route = { match: RegExp; rows?: Record<string, unknown>[] };
function mockSql(routes: Route[]): void {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => routes.find((r) => r.match.test(sql))?.rows ?? []);
}
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body) }) as unknown as HttpRequest;
const get = (query: Record<string, string>) => ({ headers: { get: () => null }, query: new URLSearchParams(query) }) as unknown as HttpRequest;
const APP_USER: Route = { match: /FROM dbo\.AppUsers WHERE EntraOid/, rows: [{ UserID: 21 }] };

beforeEach(() => {
  jest.clearAllMocks();
  auth.requireRole.mockResolvedValue(null);
  auth.rolesForRequest.mockResolvedValue(["admin"]);
  auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "ada@example.com", name: "Ada Admin", oid: "ada-oid" });
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  db.createRequestConnection.mockResolvedValue({ id: "connection" });
});

describe("setApprovalFact", () => {
  it("is behind the money-action gate", () => {
    expect(isMoneyGatedRoute("setApprovalFact")).toBe(true);
  });

  it("changes the margin and ledgers approval_fact.change (an exception) with before and after, in one transaction", async () => {
    mockSql([APP_USER, { match: /FROM dbo\.ApprovalFacts WITH \(UPDLOCK, HOLDLOCK\)/, rows: [{ FactValue: 10 }] }]);

    const res = await setApprovalFact(post({ factKey: "po_variance_margin_percent", value: 7.5 }), ctx);

    expect(res).toEqual({ jsonBody: { factKey: "po_variance_margin_percent", ok: true, value: 7.5 }, status: 200 });
    expect(gate.requireMoneyContext).toHaveBeenCalled();
    expect(ledgerInserts(db.executeQuery)).toEqual([
      expect.objectContaining({
        action: "approval_fact.change",
        after: { factKey: "po_variance_margin_percent", value: 7.5 },
        before: { factKey: "po_variance_margin_percent", value: 10 },
        isException: true,
        subjectId: "po_variance_margin_percent",
        subjectType: "approval_limit",
      }),
    ]);
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it("re-saving the same value writes nothing", async () => {
    mockSql([APP_USER, { match: /FROM dbo\.ApprovalFacts WITH/, rows: [{ FactValue: 1000 }] }]);
    await setApprovalFact(post({ factKey: "po_variance_cap", value: 1000 }), ctx);
    expect(ledgerInserts(db.executeQuery)).toEqual([]);
    expect(db.executeQuery.mock.calls.some((c: unknown[]) => /MERGE dbo\.ApprovalFacts/.test(String(c[1])))).toBe(false);
  });

  it.each([
    [{ factKey: "director_threshold", value: 1 }],
    [{ factKey: "po_variance_margin_percent", value: 101 }],
    [{ factKey: "po_variance_cap", value: -1 }],
    [{ factKey: "po_variance_cap", value: 10.005 }],
    [{ factKey: "po_variance_cap", value: "1000" }],
  ])("refuses %p with 400", async (body) => {
    expect((await setApprovalFact(post(body), ctx)).status).toBe(400);
  });

  it("is admin only", async () => {
    auth.rolesForRequest.mockResolvedValue(["director"]);
    expect((await setApprovalFact(post({ factKey: "po_variance_cap", value: 500 }), ctx)).status).toBe(403);
  });
});

describe("getApprovalCandidates", () => {
  const USERS: Route = {
    match: /FROM dbo\.AppUsers WHERE IsActive = 1 AND Role IS NOT NULL/,
    rows: [
      { DisplayName: "Ada Admin", Email: "ada@example.com", Role: "facilities_manager", UserID: 1 },
      { DisplayName: "Mo Manager", Email: "mo@example.com", Role: "facilities_manager", UserID: 30 },
      { DisplayName: "Fi Facilities", Email: "fi@example.com", Role: "facilities", UserID: 31 },
      { DisplayName: "Adam Admin", Email: "adam@example.com", Role: "admin", UserID: 32 },
      { DisplayName: "Dee Director", Email: "dee@example.com", Role: "director", UserID: 33 },
      { DisplayName: "Al Accounts", Email: "al@example.com", Role: "accounts", UserID: 34 },
    ],
  };

  beforeEach(() => {
    limitsDb.getCachedApprovalLimits.mockResolvedValue([
      { MaxApprovalAmount: 5000, RoleName: "facilities" },
      { MaxApprovalAmount: 5000, RoleName: "accounts" },
      { MaxApprovalAmount: 20000, RoleName: "facilities_manager" },
      { MaxApprovalAmount: 50000, RoleName: "admin" },
      { MaxApprovalAmount: null, RoleName: "director" },
    ]);
    mockSql([USERS]);
  });

  it("lists only people who could approve the amount themselves, never the caller or admin", async () => {
    const res = await getApprovalCandidates(get({ amount: "4500", subject: "quote" }), ctx);
    expect(res.jsonBody).toEqual({
      candidates: [
        { name: "Al Accounts", role: "accounts", userId: 34 },
        { name: "Dee Director", role: "director", userId: 33 },
        { name: "Mo Manager", role: "facilities_manager", userId: 30 },
      ],
    });
  });

  it("narrows as the amount rises", async () => {
    const res = await getApprovalCandidates(get({ amount: "12000", subject: "purchase_order" }), ctx);
    expect((res.jsonBody as { candidates: { userId: number }[] }).candidates.map((c) => c.userId)).toEqual([33, 30]);
  });

  it.each([[{ amount: "100", subject: "job" }], [{ amount: "abc", subject: "quote" }], [{ subject: "quote" }]])("400 for %p", async (query) => {
    expect((await getApprovalCandidates(get(query), ctx)).status).toBe(400);
  });
});
