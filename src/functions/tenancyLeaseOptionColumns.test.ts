/// <reference types="jest" />
// Data review S2-1: the register, a tenant's detail, the reviews feed and a
// save's re-read name the migration-106 option columns. On a database without
// 106 they must still work, reading the options as unknown, and a save must not
// commit and then answer 500.
import { HttpRequest, InvocationContext } from "@azure/functions";

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status: number; jsonBody?: unknown }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  const g = globalThis as unknown as { __optionColumnHandlers?: Record<string, Handler> };
  g.__optionColumnHandlers = g.__optionColumnHandlers ?? {};
  return {
    ...actual,
    app: { ...actual.app, http: (name: string, opts: { handler: Handler }) => ((g.__optionColumnHandlers as Record<string, Handler>)[name] = opts.handler) },
  };
});
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("mock-token"),
  oidFromToken: jest.fn().mockReturnValue("caller-oid"),
  requireRole: jest.fn().mockResolvedValue(null),
  rolesForRequest: jest.fn().mockResolvedValue(["accounts"]),
}));
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../tenant-register-cache", () => ({
  getCachedTenantDetail: jest.fn().mockReturnValue(null),
  getCachedTenantList: jest.fn().mockReturnValue(null),
  invalidateTenant: jest.fn(),
  invalidateTenantAndBuilding: jest.fn(),
  setCachedTenantDetail: jest.fn(),
  setCachedTenantList: jest.fn(),
}));
jest.mock("../planner", () => ({ resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../ledger");
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Ann", role: "accounts", userId: 7 }) }));

const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
require("./tenancy");
const handlers = (globalThis as unknown as { __optionColumnHandlers: Record<string, Handler> }).__optionColumnHandlers;
const { resetLeaseOptionColumns } = jest.requireActual("../leaseOptionColumns") as { resetLeaseOptionColumns: () => void };

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const request = (body: unknown, query: Record<string, string> = {}) =>
  ({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: { get: (k: string) => query[k] ?? null } }) as unknown as HttpRequest;

const TENANT = { BuildingId: 5, LegalName: "Acme Pty Ltd", RentPerAnnum: 50000, RowVersion: Buffer.from("00000000000007d1", "hex"), Status: "current", TenantId: 7 };
const namesRealColumn = (sql: string) => /\bOptions(Total|Remaining)\b|\bOptionTermMonths\b/.test(sql.replace(/AS Options(Total|Remaining)|AS OptionTermMonths/g, "")) && !sql.includes("COL_LENGTH");
let failures = 0;

const invalidColumn = (name: string) => Object.assign(new Error(`Invalid column name '${name}'.`), { number: 207 });

/** A database without migration 106, as tedious 18 reports it: one 207 per unknown column, so
 *  three of them, wrapped in an AggregateError with no number of its own (data recheck S2-1). */
function databaseWithout106(sql: string): unknown[] {
  if (sql.includes("COL_LENGTH('dbo.Tenants', 'OptionsRemaining')")) return [{ Len: null }];
  if (namesRealColumn(sql)) {
    failures += 1;
    throw new AggregateError([invalidColumn("OptionsTotal"), invalidColumn("OptionsRemaining"), invalidColumn("OptionTermMonths")]);
  }
  if (/FROM dbo\.Tenants t WHERE (BuildingId = @BuildingId|TenantId = @TenantId|TenantId = @Id)/.test(sql)) return [TENANT];
  if (sql.includes("INSERT INTO dbo.Tenants")) return [{ TenantId: 7 }];
  return [];
}

beforeEach(() => {
  jest.clearAllMocks();
  resetLeaseOptionColumns();
  failures = 0;
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => databaseWithout106(sql));
});

describe("without migration 106", () => {
  it("lists the register, reading the options as unknown", async () => {
    const res = await handlers.getRegisterTenants(request(null, { buildingId: "5" }), ctx);
    expect(res.status).toBe(200);
    const tenant = (res.jsonBody as { tenants: Array<Record<string, unknown>> }).tenants[0];
    expect(tenant).toMatchObject({ legalName: "Acme Pty Ltd" });
    expect(tenant.optionsRemaining).toBeUndefined();
  });

  it("reads a tenant's detail and the reviews feed", async () => {
    expect((await handlers.getRegisterTenant(request(null, { tenantId: "7" }), ctx)).status).toBe(200);
    expect((await handlers.getReviewsDue(request(null, {}), ctx)).status).toBe(200);
  });

  it("saves a new tenancy and answers with it, instead of committing and then failing", async () => {
    const res = await handlers.upsertRegisterTenant(request({ BuildingId: 5, LegalName: "Acme Pty Ltd" }), ctx);
    expect(res.status).toBeLessThan(300);
    expect(db.executeQuery.mock.calls.filter((call) => String(call[1]).includes("INSERT INTO dbo.Tenants"))).toHaveLength(1);
  });

  it("learns once: later reads go straight to the columns it has", async () => {
    await handlers.getRegisterTenants(request(null, { buildingId: "5" }), ctx);
    const after = failures;
    await handlers.getRegisterTenant(request(null, { tenantId: "7" }), ctx);
    expect(failures).toBe(after);
  });
});

describe("isMissingLeaseOptionColumn", () => {
  const { isMissingLeaseOptionColumn } = jest.requireActual("../leaseOptionColumns") as { isMissingLeaseOptionColumn: (error: unknown) => boolean };
  it("knows tedious's AggregateError of the three option columns, and a lone 207 for one", () => {
    expect(isMissingLeaseOptionColumn(new AggregateError([invalidColumn("OptionsTotal"), invalidColumn("OptionsRemaining"), invalidColumn("OptionTermMonths")]))).toBe(true);
    expect(isMissingLeaseOptionColumn(invalidColumn("OptionTermMonths"))).toBe(true);
  });

  it("rethrows anything else: a mixed batch, another column, another error, an empty batch", () => {
    expect(isMissingLeaseOptionColumn(new AggregateError([invalidColumn("OptionsTotal"), invalidColumn("GstBasis")]))).toBe(false);
    expect(isMissingLeaseOptionColumn(invalidColumn("OptionsTotalX"))).toBe(false);
    expect(isMissingLeaseOptionColumn(Object.assign(new Error("Deadlock"), { number: 1205 }))).toBe(false);
    expect(isMissingLeaseOptionColumn(new AggregateError([]))).toBe(false);
  });

  it("lets a mixed failure through the register as the error it is", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
      if (namesRealColumn(sql)) throw new AggregateError([invalidColumn("OptionsTotal"), invalidColumn("GstBasis")]);
      return [];
    });
    expect((await handlers.getRegisterTenants(request(null, { buildingId: "5" }), ctx)).status).toBe(500);
  });
});

describe("with migration 106", () => {
  it("names the real columns and passes their values on", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
      /FROM dbo\.Tenants t WHERE TenantId = @TenantId/.test(sql) ? [{ ...TENANT, OptionsRemaining: 1, OptionsTotal: 2, OptionTermMonths: 60 }] : [],
    );
    const res = await handlers.getRegisterTenant(request(null, { tenantId: "7" }), ctx);
    expect((res.jsonBody as { tenant: unknown }).tenant).toMatchObject({ optionsRemaining: 1, optionsTotal: 2, optionTermMonths: 60 });
    expect(db.executeQuery.mock.calls.some((call) => /OptionsRemaining, OptionTermMonths/.test(String(call[1])) || /OptionsTotal, OptionsRemaining/.test(String(call[1])))).toBe(true);
  });
});
