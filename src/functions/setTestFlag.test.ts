/// <reference types="jest" />
// D9: only an admin flips a record's test flag after it is created; the
// frontend asks them to confirm. The change and its ledger row commit together.
import type { HttpRequest, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), storageQueue: jest.fn(), timer: jest.fn() } };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../auth", () => ({
  ...jest.requireActual("../auth"),
  extractToken: jest.fn().mockReturnValue("tok"),
  requireRole: jest.fn().mockResolvedValue(null),
}));
jest.mock("../ledger", () => ({ record: jest.fn().mockResolvedValue(undefined) }));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Ada Admin", role: "admin", userId: 1 }) }));
jest.mock("../tenant-register-cache", () => ({ invalidateTenantAndBuilding: jest.fn() }));

import { AppRole } from "../auth";
import { setTestFlag, SET_TEST_FLAG_SQL } from "./setTestFlag";

const auth = require("../auth") as { requireRole: jest.Mock };
const db = require("../db") as Record<"beginTransaction" | "commitTransaction" | "executeQuery" | "rollbackTransaction", jest.Mock>;
const ledger = require("../ledger") as { record: jest.Mock };
const cache = require("../tenant-register-cache") as { invalidateTenantAndBuilding: jest.Mock };

const ctx = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const post = (body: unknown) => ({ headers: { get: () => null }, json: async () => body }) as unknown as HttpRequest;

beforeEach(() => {
  jest.clearAllMocks();
  auth.requireRole.mockResolvedValue(null);
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) =>
    /WITH \(UPDLOCK, HOLDLOCK\)/.test(sql) ? [{ BuildingId: 3, IsTest: false, TenantId: null }] : [],
  );
});

describe("setTestFlag", () => {
  it("is for admins only", async () => {
    await setTestFlag(post({ Id: 9, IsTest: true, Kind: "job" }), ctx);
    expect(auth.requireRole.mock.calls[0][1]).toEqual([AppRole.ADMIN]);
    auth.requireRole.mockResolvedValue({ jsonBody: { error: "Forbidden" }, status: 403 });
    expect((await setTestFlag(post({ Id: 9, IsTest: true, Kind: "job" }), ctx)).status).toBe(403);
  });

  it.each([{ Id: 9, Kind: "job" }, { Id: 9, IsTest: "yes", Kind: "job" }, { IsTest: true, Kind: "job" }, { Id: 9, IsTest: true, Kind: "quote" }])(
    "refuses %p (400) before touching the database",
    async (body) => {
      expect((await setTestFlag(post(body), ctx)).status).toBe(400);
      expect(db.executeQuery).not.toHaveBeenCalled();
    },
  );

  it.each(["job", "tenancy", "inspection", "key", "vacancy"] as const)("flips a %s, locked, and ledgers it in the same transaction", async (kind) => {
    const res = await setTestFlag(post({ Id: 9, IsTest: true, Kind: kind }), ctx);
    expect(res.status).toBe(200);
    const update = db.executeQuery.mock.calls.find((c: unknown[]) => c[1] === SET_TEST_FLAG_SQL[kind].update);
    expect(update?.[2]).toEqual(expect.arrayContaining([expect.objectContaining({ name: "IsTest", value: true }), expect.objectContaining({ name: "Id", value: 9 })]));
    expect(SET_TEST_FLAG_SQL[kind].read).toMatch(/WITH \(UPDLOCK, HOLDLOCK\)/);
    expect(ledger.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ action: "test_data.flag", after: { isTest: true }, before: { isTest: false }, subject: { id: 9, type: kind } }),
    );
    expect(ledger.record.mock.invocationCallOrder[0]).toBeLessThan(db.commitTransaction.mock.invocationCallOrder[0]);
  });

  it("answers 404 for a missing record and 409 when it is already that way, writing nothing", async () => {
    db.executeQuery.mockResolvedValue([]);
    expect((await setTestFlag(post({ Id: 9, IsTest: true, Kind: "job" }), ctx)).status).toBe(404);
    db.executeQuery.mockResolvedValue([{ BuildingId: 3, IsTest: true }]);
    expect((await setTestFlag(post({ Id: 9, IsTest: true, Kind: "job" }), ctx)).status).toBe(409);
    expect(ledger.record).not.toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("refreshes the register when a tenancy changes", async () => {
    await setTestFlag(post({ Id: 9, IsTest: true, Kind: "tenancy" }), ctx);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(9, 3);
  });
});
