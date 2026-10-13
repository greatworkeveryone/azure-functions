/// <reference types="jest" />
import { HttpRequest, InvocationContext } from "@azure/functions";

type Handler = (
  req: HttpRequest,
  ctx: InvocationContext,
) => Promise<{ status: number; jsonBody?: unknown }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  type Bag = { __recomputeHandlers?: Record<string, Handler> };
  const g = globalThis as unknown as Bag;
  g.__recomputeHandlers = g.__recomputeHandlers ?? {};
  return {
    ...actual,
    app: {
      ...actual.app,
      http: (name: string, opts: { handler: Handler }): void => {
        (g.__recomputeHandlers as Record<string, Handler>)[name] = opts.handler;
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
    nameFromToken: jest.fn().mockReturnValue("Ada Admin"),
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

jest.mock("../tenant-register-cache", () => ({ invalidateTenantAndBuilding: jest.fn() }));

// Ledger rows are asserted on the mock, never stored (PLAN WP19b owns storage).
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
const cache = require("../tenant-register-cache") as { invalidateTenantAndBuilding: jest.Mock };

require("./recomputeNextReviewDates");
const handler = (globalThis as unknown as { __recomputeHandlers: Record<string, Handler> }).__recomputeHandlers
  .recomputeNextReviewDates;

const makeRequest = (body?: unknown): HttpRequest =>
  ({
    headers: { get: (): null => null },
    json: body === undefined ? jest.fn().mockRejectedValue(new Error("no body")) : jest.fn().mockResolvedValue(body),
  }) as unknown as HttpRequest;
const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;

const COMMENCEMENT = (id: string, date: string) =>
  JSON.stringify([{ baseRentPerAnnum: 100000, effectiveFrom: date, id, methodKind: "commencement", ratePercent: 0 }]);

/** Two tenancies the derivation moves, one already right, one with nothing to derive from. */
const tenancies = () => [
  {
    BuildingId: 3,
    Commencement: new Date("2020-07-01T00:00:00Z"),
    LegalName: "Drifted Pty Ltd",
    NextReviewDate: new Date("2027-08-15T00:00:00Z"),
    ReviewIntervalMonths: 12,
    ScheduledRateSteps: JSON.stringify([
      { baseRentPerAnnum: 100000, effectiveFrom: "2020-07-01", id: "a1", methodKind: "commencement", ratePercent: 0 },
      { effectiveFrom: "2026-07-01", id: "a2", methodKind: "fixed", ratePercent: 3 },
    ]),
    TenantId: 11,
  },
  {
    BuildingId: 4,
    Commencement: new Date("2025-03-01T00:00:00Z"),
    LegalName: "Blank Date Co",
    NextReviewDate: null,
    ReviewIntervalMonths: 12,
    ScheduledRateSteps: COMMENCEMENT("b1", "2025-03-01"),
    TenantId: 12,
  },
  {
    BuildingId: 3,
    Commencement: new Date("2025-03-01T00:00:00Z"),
    LegalName: "Already Right",
    NextReviewDate: new Date("2026-03-01T00:00:00Z"),
    ReviewIntervalMonths: 12,
    ScheduledRateSteps: COMMENCEMENT("c1", "2025-03-01"),
    TenantId: 13,
  },
  { BuildingId: 5, Commencement: null, LegalName: "No Basis", NextReviewDate: null, TenantId: 14 },
];

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  db.createRequestConnection.mockResolvedValue({ id: "conn" });
  ledger.newCorrelationId.mockReturnValue("corr-recompute");
});

async function dryRun() {
  db.executeQuery.mockResolvedValueOnce(tenancies());
  const res = await handler(makeRequest(), ctx);
  return res.jsonBody as {
    changes: Array<{ from: string | null; tenantId: number; to: string }>;
    notDerivable: number;
    planId: string;
    unchanged: number;
  };
}

describe("recomputeNextReviewDates", () => {
  it("returns 401 without a token", async () => {
    auth.extractToken.mockReturnValue(null);
    expect((await handler(makeRequest(), ctx)).status).toBe(401);
  });

  it("is admin-only", async () => {
    auth.requireRole.mockResolvedValue({ status: 403, jsonBody: { error: "Forbidden" } });
    const res = await handler(makeRequest({ apply: true, planId: "x" }), ctx);
    expect(res.status).toBe(403);
    expect(auth.requireRole).toHaveBeenCalledWith(expect.anything(), ["admin"]);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("dry run: lists every change and writes nothing", async () => {
    const plan = await dryRun();
    expect(plan.changes).toEqual([
      { buildingId: 3, from: "2027-08-15", legalName: "Drifted Pty Ltd", tenantId: 11, to: "2027-07-01" },
      { buildingId: 4, from: null, legalName: "Blank Date Co", tenantId: 12, to: "2026-03-01" },
    ]);
    expect(plan.unchanged).toBe(1);
    expect(plan.notDerivable).toBe(1);
    expect(plan.planId).toMatch(/^[0-9a-f]{32}$/);
    const sql = db.executeQuery.mock.calls[0][1] as string;
    expect(sql).toMatch(/Status <> 'vacated'/);
    expect(sql).not.toMatch(/UPDLOCK/);
    expect(db.beginTransaction).not.toHaveBeenCalled();
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("apply: changes exactly the dry run's rows in one transaction, one ledger row each under one CorrelationId", async () => {
    const { planId } = await dryRun();
    jest.clearAllMocks();
    db.createRequestConnection.mockResolvedValue({ id: "conn" });
    ledger.newCorrelationId.mockReturnValue("corr-recompute");
    db.executeQuery.mockResolvedValueOnce(tenancies()).mockResolvedValue([]);
    const res = await handler(makeRequest({ apply: true, planId }), ctx);
    expect(res.status).toBe(200);
    expect(res.jsonBody).toMatchObject({ applied: 2, correlationId: "corr-recompute" });
    expect(db.beginTransaction).toHaveBeenCalledTimes(1);
    expect(db.executeQuery.mock.calls[0][1]).toMatch(/WITH \(UPDLOCK, ROWLOCK\)/);
    const updates = db.executeQuery.mock.calls.filter(([, sql]: [unknown, string]) => sql.includes("UPDATE dbo.Tenants"));
    expect(updates.map(([, , params]) => params.find((p: { name: string }) => p.name === "TenantId").value)).toEqual([11, 12]);
    expect(ledger.record).toHaveBeenCalledTimes(2);
    expect(ledger.record.mock.calls[0][1]).toMatchObject({
      action: "schedule.recompute_next_review",
      actor: { name: "Ada Admin", role: "admin" },
      after: { nextReviewDate: "2027-07-01" },
      before: { nextReviewDate: "2027-08-15" },
      buildingId: 3,
      correlationId: "corr-recompute",
      subject: { id: 11, type: "tenancy" },
      tenantId: 11,
    });
    expect(ledger.record.mock.calls[1][1]).toMatchObject({ correlationId: "corr-recompute", tenantId: 12 });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(11, 3);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(12, 4);
  });

  it("apply: refuses a plan that no longer matches, writing nothing", async () => {
    const { planId } = await dryRun();
    jest.clearAllMocks();
    db.createRequestConnection.mockResolvedValue({ id: "conn" });
    const moved = tenancies();
    moved[1].NextReviewDate = new Date("2026-03-01T00:00:00Z");
    db.executeQuery.mockResolvedValueOnce(moved);
    const res = await handler(makeRequest({ apply: true, planId }), ctx);
    expect(res.status).toBe(409);
    expect((res.jsonBody as { changes: unknown[] }).changes).toHaveLength(1);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("apply: returns 401 when the caller's token doesn't verify for the ledger", async () => {
    const actorModule = require("../ledger/actor") as { resolveLedgerActor: jest.Mock };
    actorModule.resolveLedgerActor.mockResolvedValueOnce(null);
    const res = await handler(makeRequest({ apply: true, planId: "abc" }), ctx);
    expect(res.status).toBe(401);
    expect(db.beginTransaction).not.toHaveBeenCalled();
  });

  it("apply: needs the planId from a dry run", async () => {
    const res = await handler(makeRequest({ apply: true }), ctx);
    expect(res.status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("apply: rolls everything back when a ledger write fails", async () => {
    const { planId } = await dryRun();
    jest.clearAllMocks();
    db.createRequestConnection.mockResolvedValue({ id: "conn" });
    db.executeQuery.mockResolvedValueOnce(tenancies()).mockResolvedValue([]);
    ledger.record.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("ledger unavailable"));
    const res = await handler(makeRequest({ apply: true, planId }), ctx);
    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(cache.invalidateTenantAndBuilding).not.toHaveBeenCalled();
  });
});
