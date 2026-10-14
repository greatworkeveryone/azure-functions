/// <reference types="jest" />
// getDecisions (Decisions & exceptions): the role gate, the filters it turns into
// SQL, paging, sort, and the CSV export. The DB is mocked; auth uses the real
// requireRole through the dev-override header and an unsigned JWT.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { TYPES } from "tedious";
import { clearRoleCache } from "../auth";
import { getDecisions } from "../functions/getDecisions";
import { DECISIONS_CSV_HEADERS } from "../ledger/csv";
import { MAX_LIST_ROWS } from "../pagination";

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

const warn = jest.fn();
const ctx = { error: jest.fn(), log: jest.fn(), warn } as unknown as InvocationContext;

type SqlParam = { name: string; options?: unknown; type: unknown; value: unknown };
type SqlCall = [unknown, string, SqlParam[]];
const calls = (): SqlCall[] => db.executeQuery.mock.calls as SqlCall[];
const dataQuery = (): SqlCall => calls()[0];

function ledgerRow(id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    LedgerId: String(id),
    OccurredAt: new Date("2026-10-13T14:29:00Z"),
    Action: "approval_limit.change",
    SubjectType: "approval_limit",
    SubjectId: "accounts",
    TenantId: null,
    JobId: null,
    BuildingId: null,
    ActorUserId: 3,
    ActorName: "Ada Admin",
    ActorRole: "admin",
    ActorKind: "user",
    AttributedUserId: null,
    AttributedName: null,
    AttributedRole: null,
    Reason: null,
    Before: '{"maxApprovalAmount":1000}',
    After: '{"maxApprovalAmount":5000}',
    Computed: null,
    FinancialImpact: null,
    RuleApplied: null,
    CorrelationId: "6F9619FF-8B86-D011-B42D-00C04FC964FF",
    IsException: true,
    ...overrides,
  };
}

const get = (query: Record<string, string> = {}, roles = "director") => getDecisions(makeRequest(query, authHeaders(roles)), ctx);

beforeEach(() => {
  jest.clearAllMocks();
  clearRoleCache();
  db.createRequestConnection.mockResolvedValue({});
  db.executeQuery.mockResolvedValue([]);
  process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
  process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
});

describe("who may open Decisions & exceptions", () => {
  it("answers 401 without a token", async () => {
    expect((await getDecisions(makeRequest({}, {}), ctx)).status).toBe(401);
  });

  it("lets directors, the CFO and admin in", async () => {
    expect((await get({}, "director")).status).toBe(200);
    expect((await get({}, "cfo")).status).toBe(200);
    expect((await get({}, "admin")).status).toBe(200);
  });

  it.each(["accounts", "accounts_manager", "facilities", "facilities_manager", "user"])("answers 403 for %s without querying", async (role) => {
    const res = await get({}, role);
    expect(res.status).toBe(403);
    expect(db.createRequestConnection).not.toHaveBeenCalled();
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("filters", () => {
  it("refuses a bad filter with 400 before querying", async () => {
    const bad: Record<string, string>[] = [
      { from: "13/10/2026" },
      { to: "2026-02-30" },
      { from: "2026-10-14", to: "2026-10-13" },
      { actorUserId: "x" },
      { action: "A B" },
      { sort: "amount" },
      { format: "xml" },
    ];
    for (const query of bad) {
      const res = await get(query);
      expect(res.status).toBe(400);
    }
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("has no WHERE at all with no filters", async () => {
    await get();
    expect(dataQuery()[1]).not.toMatch(/WHERE/);
    expect(dataQuery()[2]).toEqual([]);
  });

  it("turns every filter into a bound parameter", async () => {
    await get({
      action: "quote.approve",
      actorUserId: "7",
      buildingId: "5",
      exceptionsOnly: "true",
      from: "2026-10-01",
      tenantId: "42",
      to: "2026-10-13",
    });

    const [, sql, params] = dataQuery();
    expect(sql).toMatch(
      /WHERE OccurredAt >= @From AND OccurredAt < @To AND ActorUserId = @ActorUserId AND Action = @Action AND BuildingId = @BuildingId AND TenantId = @TenantId AND IsException = 1/,
    );
    const byName = Object.fromEntries(params.map((p) => [p.name, p]));
    expect(byName.ActorUserId).toMatchObject({ type: TYPES.Int, value: 7 });
    expect(byName.BuildingId).toMatchObject({ type: TYPES.Int, value: 5 });
    expect(byName.TenantId).toMatchObject({ type: TYPES.Int, value: 42 });
    expect(byName.Action).toMatchObject({ type: TYPES.NVarChar, value: "quote.approve" });
  });

  it("reads from and to as whole Darwin days, whatever the server clock says", async () => {
    await get({ from: "2026-10-01", to: "2026-10-13" });

    const byName = Object.fromEntries(dataQuery()[2].map((p) => [p.name, p]));
    expect((byName.From.value as Date).toISOString()).toBe("2026-09-30T14:30:00.000Z");
    expect((byName.To.value as Date).toISOString()).toBe("2026-10-13T14:30:00.000Z");
  });

  it("matches a domain with an action prefix ending in a dot", async () => {
    await get({ action: "schedule." });

    const [, sql, params] = dataQuery();
    expect(sql).toMatch(/Action LIKE @ActionPrefix ESCAPE '\\'/);
    expect(params).toEqual([{ name: "ActionPrefix", type: TYPES.NVarChar, value: "schedule.%" }]);
  });
});

describe("sort", () => {
  it("defaults to newest first", async () => {
    await get();
    expect(dataQuery()[1]).toMatch(/ORDER BY OccurredAt DESC, LedgerId DESC/);
  });

  it("sorts by dollar impact, largest first, newest breaking ties", async () => {
    await get({ sort: "impact" });
    expect(dataQuery()[1]).toMatch(/ORDER BY FinancialImpact DESC, OccurredAt DESC, LedgerId DESC/);
  });
});

describe("paging", () => {
  it("pages with OFFSET/FETCH, counts the unpaged total, and echoes page and pageSize", async () => {
    db.executeQuery.mockResolvedValueOnce([ledgerRow(2), ledgerRow(1)]).mockResolvedValueOnce([{ Total: 137 }]);

    const res = await get({ page: "3", pageSize: "25" });

    expect(res.status).toBe(200);
    const body = res.jsonBody as { items: unknown[]; page: number; pageSize: number; total: number };
    expect(body.items).toHaveLength(2);
    expect([body.total, body.page, body.pageSize]).toEqual([137, 3, 25]);
    expect(dataQuery()[1]).toMatch(/OFFSET 50 ROWS FETCH NEXT 25 ROWS ONLY/);
    expect(dataQuery()[1]).not.toMatch(/\bTOP\b/);
    expect(calls()[1][1]).toMatch(/SELECT COUNT\(\*\) AS Total FROM dbo\.DecisionLedger/);
  });

  it("counts with the same filters as the page", async () => {
    db.executeQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ Total: 0 }]);

    await get({ exceptionsOnly: "true", page: "1", pageSize: "10", tenantId: "42" });

    expect(calls()[1][1]).toMatch(/WHERE TenantId = @TenantId AND IsException = 1/);
    expect(calls()[1][2]).toEqual(dataQuery()[2]);
  });

  it("clamps the page size to the shared maximum", async () => {
    db.executeQuery.mockResolvedValueOnce([]).mockResolvedValueOnce([{ Total: 0 }]);
    const res = await get({ page: "1", pageSize: "100000" });
    expect((res.jsonBody as { pageSize: number }).pageSize).toBe(200);
  });

  it("without paging, returns up to the shared ceiling in one list and does not count", async () => {
    db.executeQuery.mockResolvedValueOnce([ledgerRow(2), ledgerRow(1)]);

    const res = await get();

    expect(dataQuery()[1]).toMatch(new RegExp(`SELECT TOP ${MAX_LIST_ROWS} `));
    expect(calls()).toHaveLength(1);
    expect(res.jsonBody).toMatchObject({ page: 1, pageSize: 2, total: 2 });
    expect(res.jsonBody).not.toHaveProperty("truncated");
  });

  it("says so when the ceiling cut the list short", async () => {
    db.executeQuery.mockResolvedValueOnce(Array.from({ length: MAX_LIST_ROWS }, (_, i) => ledgerRow(i + 1)));

    const res = await get();

    expect((res.jsonBody as { truncated?: boolean }).truncated).toBe(true);
    expect(warn).toHaveBeenCalled();
  });
});

describe("JSON rows", () => {
  it("returns DecisionRow items, attribution included", async () => {
    db.executeQuery.mockResolvedValueOnce([
      ledgerRow(8, {
        Action: "quote.approve_attributed",
        AttributedName: "Mo Manager",
        AttributedRole: "facilities_manager",
        AttributedUserId: 12,
        FinancialImpact: 1234.5,
        IsException: false,
        SubjectId: "5",
        SubjectType: "quote",
      }),
    ]);

    const res = await get();

    const [item] = (res.jsonBody as { items: Record<string, unknown>[] }).items;
    expect(item).toMatchObject({
      action: "quote.approve_attributed",
      actor: { kind: "user", name: "Ada Admin", role: "admin", userId: 3 },
      attributedTo: { name: "Mo Manager", role: "facilities_manager", userId: 12 },
      before: { maxApprovalAmount: 1000 },
      financialImpact: 1234.5,
      isException: false,
      ledgerId: 8,
      occurredAt: "2026-10-13T14:29:00.000Z",
    });
  });

  it("answers 500 and closes the connection when the query fails", async () => {
    db.executeQuery.mockRejectedValue(new Error("boom"));
    const res = await get();
    expect(res.status).toBe(500);
    expect(db.closeConnection).toHaveBeenCalledTimes(1);
  });
});

describe("CSV export", () => {
  beforeEach(() => {
    // Only the clock: a fixed "now" for the file name, real timers for everything else.
    jest.useFakeTimers({
      doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout", "setInterval", "clearInterval", "queueMicrotask", "hrtime", "performance"],
      now: new Date("2026-10-13T15:00:00Z"), // already 14 October in Darwin
    });
  });
  afterEach(() => jest.useRealTimers());

  it("returns text/csv with a Darwin-dated file name and a header row", async () => {
    db.executeQuery.mockResolvedValueOnce([ledgerRow(2), ledgerRow(1)]);

    const res = await get({ exceptionsOnly: "true", format: "csv" });

    expect(res.status).toBe(200);
    expect(res.headers).toMatchObject({
      "Access-Control-Expose-Headers": "Content-Disposition",
      "Content-Disposition": 'attachment; filename="decisions-20261014.csv"',
      "Content-Type": "text/csv; charset=utf-8",
    });
    const lines = (res.body as string).replace("\uFEFF", "").split("\r\n");
    expect(lines[0]).toBe(DECISIONS_CSV_HEADERS.join(","));
    expect(lines).toHaveLength(4); // header, two rows, trailing empty
    expect(lines[1]).toContain("13/10/2026 23:59");
  });

  it("applies the same filters and sort as the screen", async () => {
    await get({ format: "csv", from: "2026-10-01", sort: "impact", tenantId: "42" });

    const [, sql, params] = dataQuery();
    expect(sql).toMatch(/WHERE OccurredAt >= @From AND TenantId = @TenantId/);
    expect(sql).toMatch(/ORDER BY FinancialImpact DESC/);
    expect(params.map((p) => p.name)).toEqual(["From", "TenantId"]);
  });

  it("exports every matching row: paging parameters are ignored", async () => {
    await get({ format: "csv", page: "2", pageSize: "10" });

    expect(dataQuery()[1]).not.toMatch(/OFFSET/);
    expect(dataQuery()[1]).toMatch(new RegExp(`SELECT TOP ${MAX_LIST_ROWS + 1} `));
    expect(calls()).toHaveLength(1);
  });

  it("refuses rather than hand over an incomplete audit file", async () => {
    db.executeQuery.mockResolvedValueOnce(Array.from({ length: MAX_LIST_ROWS + 1 }, (_, i) => ledgerRow(i + 1)));

    const res = await get({ format: "csv" });

    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/More than 5000 decisions match/);
    expect(res.body).toBeUndefined();
  });

  it("exports exactly the ceiling without complaint", async () => {
    db.executeQuery.mockResolvedValueOnce(Array.from({ length: MAX_LIST_ROWS }, (_, i) => ledgerRow(i + 1)));
    expect((await get({ format: "csv" })).status).toBe(200);
  });

  it("is director-only like the screen", async () => {
    expect((await get({ format: "csv" }, "accounts_manager")).status).toBe(403);
  });
});
