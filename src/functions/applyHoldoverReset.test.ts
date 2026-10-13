/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

type Handler = (
  req: HttpRequest,
  ctx: InvocationContext,
) => Promise<{ status: number; jsonBody?: unknown }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  type Bag = { __holdoverHandlers?: Record<string, Handler> };
  const g = globalThis as unknown as Bag;
  g.__holdoverHandlers = g.__holdoverHandlers ?? {};
  return {
    ...actual,
    app: {
      ...actual.app,
      http: (name: string, opts: { handler: Handler }): void => {
        (g.__holdoverHandlers as Record<string, Handler>)[name] = opts.handler;
      },
    },
  };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockImplementation((msg: string) => ({ status: 500, jsonBody: { error: msg } })),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    oidFromToken: jest.fn().mockReturnValue("admin-oid"),
    requireRole: jest.fn().mockResolvedValue(null),
    unauthorizedResponse: jest.fn().mockReturnValue({ status: 401, jsonBody: { error: "Unauthorized" } }),
  };
});

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("../darwinDate", () => ({
  ...jest.requireActual("../darwinDate"),
  todayInDarwin: () => "2026-10-14",
}));

jest.mock("../tenant-register-cache", () => ({ invalidateTenantAndBuilding: jest.fn() }));

// Ledger rows are asserted on the mock, never stored.
jest.mock("../ledger");
jest.mock("../ledger/actor", () => ({
  resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Ada Admin", role: "admin", userId: 1 }),
}));

const auth = require("../auth") as { extractToken: jest.Mock; requireRole: jest.Mock };
const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  createRequestConnection: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const ledger = require("../ledger") as { newCorrelationId: jest.Mock; record: jest.Mock };
const actorModule = require("../ledger/actor") as { resolveLedgerActor: jest.Mock };
const cache = require("../tenant-register-cache") as { invalidateTenantAndBuilding: jest.Mock };

require("./applyHoldoverReset");
const handler = (globalThis as unknown as { __holdoverHandlers: Record<string, Handler> }).__holdoverHandlers
  .applyHoldoverReset;

const makeRequest = (body: unknown): HttpRequest =>
  ({ headers: { get: (): null => null }, json: jest.fn().mockResolvedValue(body) }) as unknown as HttpRequest;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const CONNECTION = { id: "conn" };

const lockedRows = () => [
  { BuildingId: 3, Expiry: new Date("2027-06-30T00:00:00Z"), LegalName: "Still Leasing", Status: "holdover", TenantId: 11 },
  { BuildingId: 3, Expiry: new Date("2027-06-30T00:00:00Z"), LegalName: "Already Fixed", Status: "current", TenantId: 12 },
  { BuildingId: 4, Expiry: new Date("2026-10-13T00:00:00Z"), LegalName: "Lapsed Again", Status: "holdover", TenantId: 13 },
  { BuildingId: 4, Expiry: new Date("2026-10-14T00:00:00Z"), LegalName: "Ends Today", Status: "holdover", TenantId: 15 },
];

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  db.createRequestConnection.mockResolvedValue(CONNECTION);
  ledger.newCorrelationId.mockReturnValue("corr-holdover");
});

describe("applyHoldoverReset", () => {
  it("returns 401 without a token", async () => {
    auth.extractToken.mockReturnValue(null);
    expect((await handler(makeRequest({ TenantIds: [11] }), ctx)).status).toBe(401);
  });

  it("is admin-only", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handler(makeRequest({ TenantIds: [11] }), ctx);
    expect(res.status).toBe(403);
    expect(auth.requireRole).toHaveBeenCalledWith(expect.anything(), ["admin"]);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it.each([
    ["no body", undefined],
    ["no ids", {}],
    ["an empty list", { TenantIds: [] }],
    ["'all'", { TenantIds: "all" }],
    ["a non-integer id", { TenantIds: [11, 1.5] }],
    ["a negative id", { TenantIds: [-2] }],
  ])("refuses %s — the admin picks rows, never 'all'", async (_label, body) => {
    const res = await handler(makeRequest(body), ctx);
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("re-checks each picked row in one transaction: resets the ones still stuck, skips and reports the rest", async () => {
    db.executeQuery.mockResolvedValueOnce(lockedRows()).mockResolvedValue([]);
    const res = await handler(makeRequest({ Reason: "Expiry extended", TenantIds: [11, 12, 13, 14, 15] }), ctx);
    expect(res.status).toBe(200);
    const body = res.jsonBody as {
      reset: Array<{ tenantId: number }>;
      skipped: Array<{ reason: string; tenantId: number }>;
    };
    expect(body.reset.map((row) => row.tenantId)).toEqual([11, 15]);
    expect(body.skipped).toEqual([
      { reason: "not_holdover", tenantId: 12 },
      { reason: "expiry_passed", tenantId: 13 },
      { reason: "not_found", tenantId: 14 },
    ]);
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.executeQuery.mock.calls[0][1]).toMatch(/WITH \(UPDLOCK, ROWLOCK\)/);
    const updates = db.executeQuery.mock.calls.filter(([, sql]: [unknown, string]) => sql.includes("UPDATE dbo.Tenants"));
    expect(updates).toHaveLength(2);
    expect(updates[0][1]).toMatch(/Status = 'current'[\s\S]*WHERE TenantId = @TenantId AND Status = 'holdover'/);
    expect(ctx.log).toHaveBeenCalledWith("applyHoldoverReset: 2 of 5 reset to current, 3 skipped");
  });

  it("writes one tenancy.holdover_reset ledger row per reset tenancy, inside the transaction", async () => {
    db.executeQuery.mockResolvedValueOnce(lockedRows()).mockResolvedValue([]);
    await handler(makeRequest({ TenantIds: [11, 12, 15] }), ctx);
    expect(ledger.record).toHaveBeenCalledTimes(2);
    const [tx, entry] = ledger.record.mock.calls[0];
    expect(tx).toBe(CONNECTION);
    expect(entry).toEqual({
      action: "tenancy.holdover_reset",
      actor: { kind: "user", name: "Ada Admin", role: "admin", userId: 1 },
      after: { status: "current" },
      before: { expiry: "2027-06-30", status: "holdover" },
      buildingId: 3,
      correlationId: "corr-holdover",
      reason: null,
      subject: { id: 11, type: "tenancy" },
      tenantId: 11,
    });
    expect(ledger.record.mock.calls[1][1]).toMatchObject({ correlationId: "corr-holdover", tenantId: 15 });
    const order = (fn: jest.Mock, call = 0) => fn.mock.invocationCallOrder[call];
    expect(order(ledger.record, 1)).toBeLessThan(order(db.commitTransaction));
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(11, 3);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(15, 4);
  });

  it("rolls every reset back when a ledger write fails", async () => {
    db.executeQuery.mockResolvedValueOnce(lockedRows()).mockResolvedValue([]);
    ledger.record.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("ledger unavailable"));
    const res = await handler(makeRequest({ TenantIds: [11, 15] }), ctx);
    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(cache.invalidateTenantAndBuilding).not.toHaveBeenCalled();
  });

  it("returns 401 when the caller's token doesn't verify for the ledger", async () => {
    actorModule.resolveLedgerActor.mockResolvedValueOnce(null);
    const res = await handler(makeRequest({ TenantIds: [11] }), ctx);
    expect(res.status).toBe(401);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("registers tenancy.holdover_reset in the ledger's action registry", () => {
    const { ledgerActionDefinition } = jest.requireActual("../ledger/actions") as {
      ledgerActionDefinition: (code: string) => unknown;
    };
    expect(ledgerActionDefinition("tenancy.holdover_reset")).toEqual({
      exception: false,
      reasonRequired: false,
      subjects: ["tenancy"],
    });
  });
});
