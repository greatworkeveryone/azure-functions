/// <reference types="jest" />
// Data review S2-3: an expiry edited by hand closes the open lease events dated
// for the old one, in the edit's own transaction and ledgered, so they no longer
// block warnings, lapse or a renewal referral for the new expiry, and a stale
// referral's escalation ends.
import { HttpRequest, InvocationContext } from "@azure/functions";

type Handler = (req: HttpRequest, ctx: InvocationContext) => Promise<{ status: number; jsonBody?: unknown }>;

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  const g = globalThis as unknown as { __expiryEditHandlers?: Record<string, Handler> };
  g.__expiryEditHandlers = g.__expiryEditHandlers ?? {};
  return {
    ...actual,
    app: { ...actual.app, http: (name: string, opts: { handler: Handler }) => ((g.__expiryEditHandlers as Record<string, Handler>)[name] = opts.handler) },
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
jest.mock("../escalation", () => ({ concludeForSubject: jest.fn().mockResolvedValue([]), raise: jest.fn() }));

const db = jest.requireMock("../db") as { commitTransaction: jest.Mock; executeQuery: jest.Mock };
const ledger = jest.requireMock("../ledger") as { record: jest.Mock };
const escalation = jest.requireMock("../escalation") as { concludeForSubject: jest.Mock };
require("../functions/tenancy");
const handlers = (globalThis as unknown as { __expiryEditHandlers: Record<string, Handler> }).__expiryEditHandlers;

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const request = (body: unknown) => ({ headers: { get: () => null }, json: jest.fn().mockResolvedValue(body), query: { get: () => null } }) as unknown as HttpRequest;
const LOCKED = { BuildingId: 3, Expiry: new Date("2027-06-30T00:00:00Z"), RowVersion: Buffer.from("00000000000007d1", "hex"), Status: "current", TenantId: 7, UpdatedAt: new Date() };
const OPEN_EVENTS = [
  { LeaseEventId: "ev-1", LeaseExpiry: new Date("2027-06-30T00:00:00Z"), State: "window_open", Type: "option_exercise" },
  { LeaseEventId: "rn-1", LeaseExpiry: new Date("2027-06-30T00:00:00Z"), State: "referred", Type: "renewal" },
];

function database(tableExists: boolean) {
  return async (_c: unknown, sql: string) => {
    if (sql.includes("WITH (UPDLOCK, ROWLOCK) WHERE t.TenantId = @TenantId")) return [LOCKED];
    if (sql.includes("OBJECT_ID('dbo.LeaseEvents'")) return [{ Id: tableExists ? 991 : null }];
    if (sql.includes("FROM dbo.LeaseEvents")) return OPEN_EVENTS;
    if (sql.includes("UPDATE dbo.LeaseEvents")) return [{ LeaseEventId: "moved" }];
    if (/FROM dbo\.Tenants t WHERE TenantId = @Id/.test(sql)) return [{ ...LOCKED, Expiry: new Date("2028-06-30T00:00:00Z"), LegalName: "Acme" }];
    return [];
  };
}
const calls = () => db.executeQuery.mock.calls.map((call) => String(call[1]));

beforeEach(() => jest.clearAllMocks());

it("closes the open events of the old expiry before the edit commits, ledgered, and ends their escalations after", async () => {
  db.executeQuery.mockImplementation(database(true));
  const res = await handlers.upsertRegisterTenant(request({ Expiry: "2028-06-30", TenantId: 7 }), ctx);
  expect(res.status).toBeLessThan(300);
  const moves = calls().filter((sql) => sql.includes("UPDATE dbo.LeaseEvents"));
  expect(moves).toHaveLength(2);
  expect(moves[0]).toMatch(/State = @To/);
  const select = calls().find((sql) => sql.includes("FROM dbo.LeaseEvents"));
  expect(select).toMatch(/LeaseExpiry = @OldExpiry/);
  const updateOrder = db.executeQuery.mock.invocationCallOrder[calls().findIndex((sql) => sql.includes("UPDATE dbo.LeaseEvents"))];
  expect(updateOrder).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
  const cancels = ledger.record.mock.calls.map((call) => call[1]).filter((entry) => entry.action === "lease_event.cancel");
  expect(cancels.map((entry) => entry.subject.id)).toEqual(["ev-1", "rn-1"]);
  expect(cancels[0].reason).toMatch(/30\/06\/2027 to 30\/06\/2028/);
  expect(escalation.concludeForSubject.mock.calls.map((call) => call[1].subjectId)).toEqual(["ev-1", "rn-1"]);
});

it("touches no lease event when the expiry isn't changed", async () => {
  db.executeQuery.mockImplementation(database(true));
  await handlers.upsertRegisterTenant(request({ Comments: "Called", TenantId: 7 }), ctx);
  expect(calls().some((sql) => sql.includes("LeaseEvents"))).toBe(false);
});

it("saves the edit on a database without migration 106", async () => {
  db.executeQuery.mockImplementation(database(false));
  const res = await handlers.upsertRegisterTenant(request({ Expiry: "2028-06-30", TenantId: 7 }), ctx);
  expect(res.status).toBeLessThan(300);
  expect(calls().some((sql) => sql.includes("FROM dbo.LeaseEvents") || sql.includes("UPDATE dbo.LeaseEvents"))).toBe(false);
});
