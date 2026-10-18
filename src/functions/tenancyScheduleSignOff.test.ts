/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

type Handler = (
  req: HttpRequest,
  ctx: InvocationContext,
) => Promise<{ status: number; jsonBody?: unknown; headers?: Record<string, string> }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  type Bag = { __tenancyHandlers?: Record<string, Handler> };
  const g = globalThis as unknown as Bag;
  g.__tenancyHandlers = g.__tenancyHandlers ?? {};
  return {
    ...actual,
    app: {
      ...actual.app,
      http: (name: string, opts: { handler: Handler }): void => {
        (g.__tenancyHandlers as Record<string, Handler>)[name] = opts.handler;
      },
    },
  };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    extractToken:         jest.fn().mockReturnValue("mock-token"),
    requireRole:          jest.fn().mockResolvedValue(null),
    oidFromToken:         jest.fn().mockReturnValue("caller-oid-123"),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
    errorResponse:        jest.fn().mockImplementation((msg: string, detail: string) => ({
      status: 500,
      jsonBody: { error: msg, detail },
    })),
  };
});

jest.mock("../db", () => ({
  beginTransaction:    jest.fn().mockResolvedValue(undefined),
  closeConnection:     jest.fn(),
  commitTransaction:   jest.fn().mockResolvedValue(undefined),
  createRequestConnection:    jest.fn(),
  executeQuery:        jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../tenant-register-cache", () => ({
  getCachedTenantList:         jest.fn().mockReturnValue(null),
  setCachedTenantList:         jest.fn(),
  getCachedTenantDetail:       jest.fn().mockReturnValue(null),
  setCachedTenantDetail:       jest.fn(),
  invalidateTenant:            jest.fn(),
  invalidateTenantAndBuilding: jest.fn(),
}));

jest.mock("../planner", () => ({
  resolveActivePlannerTasks: jest.fn().mockResolvedValue(undefined),
}));

// Ledger rows are asserted on the mock, never stored (PLAN WP19b owns storage).
jest.mock("../ledger");
jest.mock("../ledger/actor", () => ({
  resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Test User", role: "accounts", userId: 7 }),
}));

const auth = require("../auth") as {
  extractToken:         jest.Mock;
  requireRole:          jest.Mock;
  oidFromToken:         jest.Mock;
  unauthorizedResponse: jest.Mock;
};
const db = require("../db") as {
  beginTransaction:    jest.Mock;
  closeConnection:     jest.Mock;
  commitTransaction:   jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery:        jest.Mock;
  rollbackTransaction: jest.Mock;
};
const cache = require("../tenant-register-cache") as {
  getCachedTenantList:         jest.Mock;
  getCachedTenantDetail:       jest.Mock;
  invalidateTenant:            jest.Mock;
  invalidateTenantAndBuilding: jest.Mock;
};
const planner = require("../planner") as {
  resolveActivePlannerTasks: jest.Mock;
};

// Trigger the module's app.http registrations so the mock above captures
// every handler by name.
require("./tenancy");
const handlers = (globalThis as unknown as { __tenancyHandlers: Record<string, Handler> }).__tenancyHandlers;

function makeRequest(
  body: unknown,
  query: Record<string, string> = {},
  headers: Record<string, string> = {},
): HttpRequest {
  return {
    json: jest.fn().mockResolvedValue(body),
    query: {
      get: (k: string): string | null => query[k] ?? null,
    },
    headers: { get: (k: string): string | null => headers[k.toLowerCase()] ?? null },
  } as unknown as HttpRequest;
}

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const ledger = require("../ledger") as { record: jest.Mock };
const CONNECTION = { id: "conn" };
const ROW_VERSION = "00000000000007d1";

/** The tenant row upsertRegisterTenant reads under UPDLOCK before an update. */
function lockedRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    BuildingId: 3,
    Expiry: null,
    RowVersion: Buffer.from(ROW_VERSION, "hex"),
    Status: "current",
    TenantId: 7,
    UpdatedAt: new Date("2026-10-01T02:00:00Z"),
    UpdatedByName: "Earlier Editor",
    ...over,
  };
}


const SIGNED_AT = new Date("2026-10-10T01:00:00Z");
const SIGNED = {
  ScheduleSignedOffAt: SIGNED_AT,
  ScheduleSignedOffByName: "Mia Manager",
  ScheduleSignOffNote: "Checked against the lease",
};

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  auth.oidFromToken.mockReturnValue("caller-oid-123");
  db.createRequestConnection.mockResolvedValue(CONNECTION);
  db.beginTransaction.mockResolvedValue(undefined);
  db.commitTransaction.mockResolvedValue(undefined);
  db.rollbackTransaction.mockResolvedValue(undefined);
  ledger.record.mockResolvedValue(undefined);
  cache.getCachedTenantList.mockReturnValue(null);
  cache.getCachedTenantDetail.mockReturnValue(null);
  planner.resolveActivePlannerTasks.mockResolvedValue(undefined);
});

const storedRow = (over: Record<string, unknown> = {}) => [
  { TenantId: 7, BuildingId: 3, LegalName: "Acme", Status: "current", ...over },
];
const sqlRun = (pattern: RegExp) => db.executeQuery.mock.calls.filter((call) => pattern.test(call[1] as string));
const actions = () => ledger.record.mock.calls.map(([, entry]) => entry.action);

describe("upsertRegisterTenant on a signed-off tenancy (PLAN WP24)", () => {
  it("asks for a reason before changing the rent, and changes nothing", async () => {
    db.executeQuery.mockResolvedValueOnce([lockedRow({ ...SIGNED, RentPerAnnum: 100000 })]);
    const res = await handlers.upsertRegisterTenant(makeRequest({ RentPerAnnum: 110000, TenantId: 7 }), ctx);
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "SIGN_OFF_REASON_REQUIRED", signOff: { by: "Mia Manager" } });
    expect(sqlRun(/UPDATE dbo\.Tenants/)).toHaveLength(0);
    expect(ledger.record).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ["Commencement", "2020-02-01", { Commencement: "2020-01-01" }],
    ["Expiry", "2031-06-30", { Expiry: "2030-06-30" }],
    ["RentPerAnnum", 110000, { RentPerAnnum: 100000 }],
    ["ReviewType", "Fixed 3%", { ReviewType: "CPI" }],
    ["FixedReviewPercent", 3.5, { FixedReviewPercent: 3 }],
    ["CpiCapPercent", 6, { CpiCapPercent: 5 }],
    ["CpiFloorPercent", 1, { CpiFloorPercent: 0 }],
    ["ReviewRatchet", true, { ReviewRatchet: false }],
    ["ReviewIntervalMonths", 24, { ReviewIntervalMonths: 12 }],
  ])("clears the sign-off when %s changes, in the same transaction, with the reason ledgered", async (field, value, current) => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow({ ...SIGNED, ...current })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow());
    const res = await handlers.upsertRegisterTenant(
      makeRequest({ [field]: value, SignOffClearReason: "Lease variation received", TenantId: 7 }),
      ctx,
    );
    expect(res.status).toBe(200);
    // One UPDATE does both, so the RowVersion the screen reads back is the final one.
    expect(sqlRun(/UPDATE dbo\.Tenants/)).toHaveLength(1);
    expect(sqlRun(/UPDATE dbo\.Tenants[^]*ScheduleSignedOffAt = NULL/)).toHaveLength(1);
    expect(actions()).toEqual(["schedule.terms_edit", "schedule.sign_off_cleared"]);
    expect(ledger.record.mock.calls[1][1]).toMatchObject({
      reason: "Lease variation received",
      subject: { id: 7, type: "tenancy" },
    });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a name", { LegalName: "Acme Pty Ltd" }],
    ["a comment", { Comments: "Prefers email" }],
    ["option periods", { OptionPeriods: "2 x 5 years" }],
    ["option notice", { OptionNoticeMonths: 6 }],
    ["last review", { LastReviewDate: "2026-01-01" }],
    ["a rent value re-sent unchanged", { RentPerAnnum: 100000 }],
  ])("leaves the sign-off alone when only %s is edited", async (_what, change) => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow({ ...SIGNED, RentPerAnnum: 100000 })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow());
    const res = await handlers.upsertRegisterTenant(makeRequest({ ...change, TenantId: 7 }), ctx);
    expect(res.status).toBe(200);
    expect(sqlRun(/ScheduleSignedOffAt = NULL/)).toHaveLength(0);
    expect(actions()).not.toContain("schedule.sign_off_cleared");
  });

  it("does not ask an unsigned tenancy for anything", async () => {
    db.executeQuery
      .mockResolvedValueOnce([lockedRow({ RentPerAnnum: 100000 })])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(storedRow());
    const res = await handlers.upsertRegisterTenant(makeRequest({ RentPerAnnum: 110000, TenantId: 7 }), ctx);
    expect(res.status).toBe(200);
    expect(actions()).toEqual(["schedule.terms_edit"]);
  });
});

describe("what the read endpoints say about sign-off", () => {
  const ROW = {
    BuildingId: 2,
    Expiry: new Date("2030-06-30T00:00:00Z"),
    LegalName: "Acme Pty Ltd",
    NextReviewDate: new Date("2020-07-01T00:00:00Z"),
    ReviewType: "cpi",
    Status: "current",
    TenantId: 31,
    ...SIGNED,
  };

  it("getReviewsDue tells the widget whether each tenancy is signed off, without the note", async () => {
    db.executeQuery.mockResolvedValueOnce([ROW, { ...ROW, TenantId: 32, ScheduleSignedOffAt: null }]);
    const res = await handlers.getReviewsDue(makeRequest(undefined), ctx);
    const { tenants } = res.jsonBody as { tenants: Array<{ scheduleSignOff: unknown; tenantId: number }> };
    expect(tenants.find((tenant) => tenant.tenantId === 31)?.scheduleSignOff).toEqual({
      at: "2026-10-10T01:00:00.000Z",
      by: "Mia Manager",
      note: null,
    });
    expect(tenants.find((tenant) => tenant.tenantId === 32)?.scheduleSignOff).toBeNull();
    expect(JSON.stringify(res.jsonBody)).not.toContain("Checked against the lease");
  });

  it("getPortfolioOccupancy counts the active tenancies not yet signed off", async () => {
    db.executeQuery
      .mockResolvedValueOnce([
        { ActiveSqm: 80, ActiveTenantCount: 4, AnnualRent: 400000, BuildingId: 5, TotalSqm: 100, UnsignedTenantCount: 3, WaleDenominatorSqm: 0, WaleNumeratorSqmDays: 0 },
      ])
      // WP26c: the portfolio's relief requests and reviews awaiting approval.
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const res = await handlers.getPortfolioOccupancy(makeRequest(undefined), ctx);
    const { buildings } = res.jsonBody as { buildings: Array<{ unsignedTenantCount: number }> };
    expect(buildings[0].unsignedTenantCount).toBe(3);
    const [, sql] = db.executeQuery.mock.calls[0] as [unknown, string];
    expect(sql).toContain("ScheduleSignedOffAt IS NULL");
  });

  it("getPortfolioOccupancy counts neither archived nor vacated tenancies as unsigned", async () => {
    db.executeQuery.mockResolvedValueOnce([]);
    await handlers.getPortfolioOccupancy(makeRequest(undefined), ctx);
    const [, sql] = db.executeQuery.mock.calls[0] as [unknown, string];
    expect(sql).toMatch(/WHERE t\.ArchivedAt IS NULL/);
    expect(sql).toMatch(/t\.Status IN \('current','holdover'\)\s+AND t\.ScheduleSignedOffAt IS NULL/);
  });
});
