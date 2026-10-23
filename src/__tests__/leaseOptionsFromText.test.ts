/// <reference types="jest" />
// Data review S2-4: one source of truth for options. Editing the option text
// re-derives the structured counts (migration 106) in the same transaction,
// ledgered, and never raises the options remaining above what remains.
import { HttpRequest, InvocationContext } from "@azure/functions";
import { deriveOptionsFromText } from "../leaseEvents/optionText";

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status: number; jsonBody?: unknown }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  const g = globalThis as unknown as { __optionTextHandlers?: Record<string, Handler> };
  g.__optionTextHandlers = g.__optionTextHandlers ?? {};
  return {
    ...actual,
    app: { ...actual.app, http: (name: string, opts: { handler: Handler }) => ((g.__optionTextHandlers as Record<string, Handler>)[name] = opts.handler) },
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
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Ann Accounts", role: "accounts", userId: 7 }) }));

const db = jest.requireMock("../db") as { executeQuery: jest.Mock };
const ledger = jest.requireMock("../ledger") as { record: jest.Mock };
require("../functions/tenancy");
const handlers = (globalThis as unknown as { __optionTextHandlers: Record<string, Handler> }).__optionTextHandlers;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const request = (body: unknown) => ({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: { get: () => null } }) as unknown as HttpRequest;

describe("deriveOptionsFromText", () => {
  const recorded = { remaining: 1, termMonths: 60, total: 2 };
  it("records a readable grant, keeping what remains when that is fewer", () => {
    expect(deriveOptionsFromText("2 x 5 years", { remaining: null, termMonths: null, total: null })).toEqual({ remaining: 2, termMonths: 60, total: 2 });
    expect(deriveOptionsFromText("2 x 5 years", recorded)).toEqual({ remaining: 1, termMonths: 60, total: 2 });
    expect(deriveOptionsFromText("1 x 5 years", { remaining: 2, termMonths: 60, total: 2 })).toEqual({ remaining: 1, termMonths: 60, total: 1 });
  });

  it("treats a recorded none (0 of 0) as not recorded, so the text can set the counts again (data recheck S2)", () => {
    expect(deriveOptionsFromText("2 x 5 years", { remaining: 0, termMonths: null, total: 0 })).toEqual({ remaining: 2, termMonths: 60, total: 2 });
    // Options taken from a real grant still never come back.
    expect(deriveOptionsFromText("2 x 5 years", { remaining: 0, termMonths: 60, total: 2 })).toEqual({ remaining: 0, termMonths: 60, total: 2 });
  });

  it("reads Nil and blank as no options, and leaves the counts alone for text it can't read", () => {
    expect(deriveOptionsFromText("Nil", recorded)).toEqual({ remaining: 0, termMonths: null, total: 0 });
    expect(deriveOptionsFromText("  ", recorded)).toEqual({ remaining: 0, termMonths: null, total: 0 });
    expect(deriveOptionsFromText("At the landlord's discretion", recorded)).toBeNull();
  });
});

const LOCKED = { BuildingId: 3, Expiry: null, OptionPeriods: "2 x 5 years", RowVersion: Buffer.from("00000000000007d1", "hex"), Status: "current", TenantId: 7, UpdatedAt: new Date() };

function database(with106: boolean) {
  return async (_c: unknown, sql: string) => {
    if (sql.includes("WITH (UPDLOCK, ROWLOCK) WHERE t.TenantId = @TenantId")) return [LOCKED];
    if (sql.includes("COL_LENGTH('dbo.Tenants', 'OptionsRemaining')")) return [{ Len: with106 ? 4 : null }];
    if (sql.includes("SELECT OptionsTotal, OptionsRemaining, OptionTermMonths FROM dbo.Tenants")) return [{ OptionsRemaining: 2, OptionsTotal: 2, OptionTermMonths: 60 }];
    if (/FROM dbo\.Tenants t WHERE TenantId = @Id/.test(sql)) return [{ ...LOCKED, LegalName: "Acme" }];
    return [];
  };
}
const updateSql = () => db.executeQuery.mock.calls.map((call) => String(call[1])).find((sql) => sql.startsWith("UPDATE dbo.Tenants"));

beforeEach(() => jest.clearAllMocks());

it("an edit to Nil sets the counts to none in the same update, ledgered", async () => {
  db.executeQuery.mockImplementation(database(true));
  const res = await handlers.upsertRegisterTenant(request({ OptionPeriods: "Nil", TenantId: 7 }), ctx);
  expect(res.status).toBeLessThan(300);
  expect(updateSql()).toMatch(/OptionPeriods = @OptionPeriods[\s\S]*OptionsTotal = @OptionsTotal, OptionsRemaining = @OptionsRemaining, OptionTermMonths = @OptionTermMonths/);
  const params = db.executeQuery.mock.calls.find((call) => String(call[1]).startsWith("UPDATE dbo.Tenants"))?.[2] as Array<{ name: string; value: unknown }>;
  expect(Object.fromEntries(params.map((p) => [p.name, p.value]))).toMatchObject({ OptionsRemaining: 0, OptionsTotal: 0, OptionTermMonths: null });
  const entry = ledger.record.mock.calls.map((call) => call[1]).find((row) => row.ruleApplied === "options_from_text");
  expect(entry).toMatchObject({ action: "schedule.terms_edit", after: { optionsRemaining: 0, optionsTotal: 0 }, before: { optionsRemaining: 2, optionsTotal: 2 } });
});

it("leaves the counts alone on a database without 106", async () => {
  db.executeQuery.mockImplementation(database(false));
  const res = await handlers.upsertRegisterTenant(request({ OptionPeriods: "Nil", TenantId: 7 }), ctx);
  expect(res.status).toBeLessThan(300);
  expect(updateSql()).not.toMatch(/OptionsRemaining/);
});
