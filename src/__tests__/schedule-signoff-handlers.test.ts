/// <reference types="jest" />
import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn() } };
});

jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Error" }, status: 500 }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    rolesForRequest: jest.fn().mockResolvedValue(["accounts_manager"]),
    unauthorizedResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Unauthorized" }, status: 401 }),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "m@rp.com", name: "Mia Manager", oid: "oid-mia" }),
  };
});

jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn().mockResolvedValue([]),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../ledger");
jest.mock("../ledger/actor", () => ({
  resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Mia Manager", role: "accounts_manager", userId: 9 }),
}));
jest.mock("../tenant-register-cache", () => ({ invalidateTenantAndBuilding: jest.fn() }));

import { AppRole } from "../auth";
import { requireSignOffRole, SIGN_OFF_ROLES } from "../scheduleSignOff";
import "../functions/signOffTenancySchedule";
import "../functions/revokeTenancyScheduleSignOff";

type Handler = (request: HttpRequest, context: InvocationContext) => Promise<HttpResponseInit>;
const handlers = new Map<string, Handler>(
  (app.http as unknown as jest.Mock).mock.calls.map(([name, options]: [string, { handler: Handler }]) => [name, options.handler]),
);
const signOff = (body: unknown) => handlers.get("signOffTenancySchedule")!(jsonRequest(body), context);
const revoke = (body: unknown) => handlers.get("revokeTenancyScheduleSignOff")!(jsonRequest(body), context);

const auth = require("../auth") as {
  extractToken: jest.Mock;
  requireRole: jest.Mock;
  rolesForRequest: jest.Mock;
  verifiedIdentityFromRequest: jest.Mock;
};
const db = require("../db") as {
  beginTransaction: jest.Mock;
  commitTransaction: jest.Mock;
  executeQuery: jest.Mock;
  rollbackTransaction: jest.Mock;
};
const ledger = require("../ledger") as { record: jest.Mock };
const cache = require("../tenant-register-cache") as { invalidateTenantAndBuilding: jest.Mock };
const realAuth = jest.requireActual("../auth") as typeof import("../auth");

const context = { error: jest.fn(), log: jest.fn(), warn: jest.fn() } as unknown as InvocationContext;
const FORBIDDEN = { jsonBody: { error: "Forbidden" }, status: 403 };
const jsonRequest = (body: unknown): HttpRequest =>
  ({ headers: { get: () => null }, json: async () => body, query: { get: () => null } }) as unknown as HttpRequest;

const UNSIGNED = { BuildingId: 5, ScheduleSignedOffAt: null, ScheduleVersion: 3, Status: "current", TenantId: 1 };
const SIGNED = {
  ...UNSIGNED,
  ScheduleSignedOffAt: new Date("2026-10-10T01:00:00Z"),
  ScheduleSignedOffByName: "Ann Accounts",
  ScheduleSignOffNote: "Checked",
};

/** Answers the lock query with `locked`, and the sign-off UPDATE's OUTPUT with what it would write. */
function answer(locked: Record<string, unknown> | null) {
  db.executeQuery.mockImplementation(async (_conn: unknown, sql: string, params: Array<{ name: string; value: unknown }> = []) => {
    if (/WITH \(UPDLOCK/.test(sql)) return locked ? [locked] : [];
    if (/OUTPUT INSERTED/.test(sql)) {
      const value = (name: string) => params.find((param) => param.name === name)?.value;
      return [
        {
          RowVersion: Buffer.from("0b", "hex"),
          ScheduleSignedOffAt: new Date("2026-10-14T03:00:00Z"),
          ScheduleSignedOffByName: value("SignedOffByName"),
          ScheduleSignOffNote: value("Note"),
        },
      ];
    }
    return [];
  });
}
const sqlRun = (pattern: RegExp) => db.executeQuery.mock.calls.filter((call) => pattern.test(call[1] as string));
const paramOf = (call: unknown[], name: string) => (call[2] as Array<{ name: string; value: unknown }>).find((p) => p.name === name)?.value;

beforeEach(() => {
  jest.clearAllMocks();
  auth.extractToken.mockReturnValue("mock-token");
  auth.requireRole.mockResolvedValue(null);
  auth.rolesForRequest.mockResolvedValue(["accounts_manager"]);
  auth.verifiedIdentityFromRequest.mockResolvedValue({ email: "m@rp.com", name: "Mia Manager", oid: "oid-mia" });
  ledger.record.mockResolvedValue(undefined);
  db.executeQuery.mockResolvedValue([]);
});

describe("who may sign a schedule off", () => {
  it("is accounts managers, the CFO and directors", () => {
    expect([...SIGN_OFF_ROLES]).toEqual([AppRole.ACCOUNTS_APPROVAL, AppRole.CFO, AppRole.DIRECTOR]);
  });

  it("is checked by both handlers, after the token and before any database work", async () => {
    auth.extractToken.mockReturnValue(null);
    expect((await signOff({ TenantId: 1 })).status).toBe(401);
    expect((await revoke({ Reason: "x", TenantId: 1 })).status).toBe(401);
    auth.extractToken.mockReturnValue("mock-token");
    auth.requireRole.mockResolvedValue(FORBIDDEN);
    expect((await signOff({ TenantId: 1 })).status).toBe(403);
    expect(auth.requireRole).toHaveBeenLastCalledWith(expect.anything(), SIGN_OFF_ROLES);
    expect((await revoke({ Reason: "x", TenantId: 1 })).status).toBe(403);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("refuses a caller whose only role is admin: signing off is an accountable statement, not a technical power", async () => {
    auth.rolesForRequest.mockResolvedValue(["admin"]);
    expect((await signOff({ TenantId: 1 })).status).toBe(403);
    expect((await revoke({ Reason: "x", TenantId: 1 })).status).toBe(403);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it.each(["director", "cfo", "accounts_manager"])("admits an admin who is also %s", async (role) => {
    auth.rolesForRequest.mockResolvedValue(["admin", role]);
    answer(UNSIGNED);
    expect((await signOff({ TenantId: 1 })).status).toBe(200);
  });

  it("the real role check admits those three and nobody else, admin included", async () => {
    const names = ["DEV_ROLE_OVERRIDE_ENABLED", "AZURE_FUNCTIONS_ENVIRONMENT", "WEBSITE_INSTANCE_ID"] as const;
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    process.env.DEV_ROLE_OVERRIDE_ENABLED = "true";
    process.env.AZURE_FUNCTIONS_ENVIRONMENT = "Development";
    delete process.env.WEBSITE_INSTANCE_ID;
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
    auth.requireRole.mockImplementation(realAuth.requireRole);
    auth.rolesForRequest.mockImplementation(realAuth.rolesForRequest);
    try {
      const result: string[] = [];
      for (const role of ["admin", "director", "cfo", "accounts_manager", "accounts", "facilities_manager", "facilities", "user"]) {
        realAuth.clearRoleCache();
        const request = { headers: { get: (key: string) => (key.toLowerCase() === "x-dev-roles" ? role : null) } } as unknown as HttpRequest;
        if ((await requireSignOffRole(request)) === null) result.push(role);
      }
      expect(result).toEqual(["director", "cfo", "accounts_manager"]);
    } finally {
      jest.restoreAllMocks();
      for (const name of names) {
        const before = original[name];
        if (before === undefined) delete process.env[name];
        else process.env[name] = before;
      }
    }
  });
});

describe("signOffTenancySchedule", () => {
  it("signs the schedule off as the verified caller and ledgers it in the same transaction", async () => {
    answer(UNSIGNED);
    const res = await signOff({ BuildingId: 5, Note: "  Checked against the lease  ", ScheduleVersion: 3, TenantId: 1 });
    expect(res.status).toBe(200);
    const [update] = sqlRun(/UPDATE dbo\.Tenants/);
    expect(update[1]).toContain("ScheduleSignedOffAt = SYSUTCDATETIME()");
    expect(paramOf(update, "SignedOffById")).toBe("oid-mia");
    expect(paramOf(update, "SignedOffByName")).toBe("Mia Manager");
    expect(paramOf(update, "Note")).toBe("Checked against the lease");
    expect(ledger.record).toHaveBeenCalledTimes(1);
    expect(ledger.record.mock.calls[0][1]).toMatchObject({
      action: "schedule.sign_off",
      actor: { name: "Mia Manager" },
      buildingId: 5,
      subject: { id: 1, type: "tenancy" },
      tenantId: 1,
    });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
    expect(res.jsonBody).toMatchObject({
      scheduleSignOff: { at: "2026-10-14T03:00:00.000Z", by: "Mia Manager", note: "Checked against the lease" },
      scheduleVersion: 3,
    });
  });

  it("needs a tenancy", async () => {
    expect((await signOff({})).status).toBe(400);
    expect((await signOff({ TenantId: "1; DROP" })).status).toBe(400);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("answers 404 for a tenancy that is not there, or not in that building", async () => {
    answer(null);
    expect((await signOff({ TenantId: 1 })).status).toBe(404);
    answer(UNSIGNED);
    expect((await signOff({ BuildingId: 99, TenantId: 1 })).status).toBe(404);
    expect(sqlRun(/UPDATE dbo\.Tenants/)).toHaveLength(0);
  });

  it("will not sign off a vacated tenancy: there is no schedule to verify", async () => {
    answer({ ...UNSIGNED, Status: "vacated" });
    const res = await signOff({ TenantId: 1 });
    expect(res.status).toBe(409);
    expect(sqlRun(/UPDATE dbo\.Tenants/)).toHaveLength(0);
  });

  it("will not sign off an archived tenancy: it is out of the register, so restore it first (409, nothing written)", async () => {
    answer({ ...UNSIGNED, ArchivedAt: new Date("2026-10-14T00:00:00Z") });
    const res = await signOff({ TenantId: 1 });
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "TENANCY_ARCHIVED" });
    expect((res.jsonBody as { error: string }).error).toMatch(/archived/i);
    expect(sqlRun(/UPDATE dbo\.Tenants/)).toHaveLength(0);
    expect(ledger.record).not.toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(db.rollbackTransaction).toHaveBeenCalled();
  });

  it("locks the row with its ArchivedAt, so the refusal is decided under the lock", async () => {
    answer(UNSIGNED);
    await signOff({ TenantId: 1 });
    expect(sqlRun(/WITH \(UPDLOCK/)[0][1]).toContain("ArchivedAt");
  });

  it("an unarchived tenancy that was signed off before it was archived is still signed off, not asked again", async () => {
    answer({ ...SIGNED, ArchivedAt: null });
    const res = await signOff({ TenantId: 1 });
    expect(res.jsonBody).toMatchObject({ code: "ALREADY_SIGNED_OFF" });
  });

  it("will not sign off what is already signed off, and says by whom", async () => {
    answer(SIGNED);
    const res = await signOff({ TenantId: 1 });
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "ALREADY_SIGNED_OFF" });
    expect((res.jsonBody as { error: string }).error).toContain("Ann Accounts");
    expect(sqlRun(/UPDATE dbo\.Tenants/)).toHaveLength(0);
  });

  it("refuses to sign off a schedule that changed since the person looked at it", async () => {
    answer({ ...UNSIGNED, ScheduleVersion: 4, UpdatedByName: "Bob Editor" });
    const res = await signOff({ ScheduleVersion: 3, TenantId: 1 });
    expect(res.status).toBe(409);
    expect((res.jsonBody as { error: string }).error).toContain("Bob Editor");
    expect(sqlRun(/UPDATE dbo\.Tenants/)).toHaveLength(0);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("keeps a note to 500 characters", async () => {
    answer(UNSIGNED);
    await signOff({ Note: "x".repeat(900), TenantId: 1 });
    expect(String(paramOf(sqlRun(/UPDATE dbo\.Tenants/)[0], "Note"))).toHaveLength(500);
  });

  it("rolls the sign-off back when the ledger write fails", async () => {
    answer(UNSIGNED);
    ledger.record.mockRejectedValueOnce(new Error("ledger down"));
    const res = await signOff({ TenantId: 1 });
    expect(res.status).toBe(500);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
    expect(cache.invalidateTenantAndBuilding).not.toHaveBeenCalled();
  });

  it("refuses a caller whose identity cannot be verified", async () => {
    auth.verifiedIdentityFromRequest.mockResolvedValue(null);
    expect((await signOff({ TenantId: 1 })).status).toBe(401);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("revokeTenancyScheduleSignOff", () => {
  it("clears the sign-off and ledgers the reason", async () => {
    answer(SIGNED);
    const res = await revoke({ BuildingId: 5, Reason: "  Lease was renegotiated  ", TenantId: 1 });
    expect(res.status).toBe(200);
    expect(sqlRun(/ScheduleSignedOffAt = NULL/)).toHaveLength(1);
    expect(ledger.record.mock.calls[0][1]).toMatchObject({
      action: "schedule.sign_off_revoke",
      reason: "Lease was renegotiated",
      subject: { id: 1, type: "tenancy" },
    });
    expect(ledger.record.mock.calls[0][1].before.signOff).toMatchObject({ by: "Ann Accounts" });
    expect(db.commitTransaction).toHaveBeenCalledTimes(1);
    expect(cache.invalidateTenantAndBuilding).toHaveBeenCalledWith(1, 5);
    expect(res.jsonBody).toMatchObject({ scheduleSignOff: null });
  });

  it.each([undefined, "", "   ", 42])("needs a reason (%j)", async (Reason) => {
    answer(SIGNED);
    const res = await revoke({ Reason, TenantId: 1 });
    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toMatch(/reason/i);
    expect(sqlRun(/UPDATE dbo\.Tenants/)).toHaveLength(0);
  });

  it("will not take the sign-off back from an archived tenancy either: restore it first", async () => {
    answer({ ...SIGNED, ArchivedAt: new Date("2026-10-14T00:00:00Z") });
    const res = await revoke({ Reason: "x", TenantId: 1 });
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "TENANCY_ARCHIVED" });
    expect(sqlRun(/UPDATE dbo\.Tenants/)).toHaveLength(0);
    expect(ledger.record).not.toHaveBeenCalled();
  });

  it("says so when there is nothing to revoke", async () => {
    answer(UNSIGNED);
    const res = await revoke({ Reason: "x", TenantId: 1 });
    expect(res.status).toBe(409);
    expect(res.jsonBody).toMatchObject({ code: "NOT_SIGNED_OFF" });
  });

  it("answers 404 for a tenancy that is not there", async () => {
    answer(null);
    expect((await revoke({ Reason: "x", TenantId: 1 })).status).toBe(404);
  });
});
