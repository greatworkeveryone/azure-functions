/// <reference types="jest" />
import { InvocationContext, type HttpRequest } from "@azure/functions";

jest.mock("@azure/functions", () => {
  const actual = jest.requireActual("@azure/functions");
  return { ...actual, app: { http: jest.fn(), timer: jest.fn() } };
});
jest.mock("../auth", () => {
  const actual = jest.requireActual("../auth");
  return {
    ...actual,
    errorResponse: jest.fn().mockReturnValue({ jsonBody: { error: "Error" }, status: 500 }),
    extractToken: jest.fn().mockReturnValue("mock-token"),
    requireRole: jest.fn().mockResolvedValue(null),
    rolesForRequest: jest.fn().mockResolvedValue(["facilities_manager"]),
    verifiedIdentityFromRequest: jest.fn().mockResolvedValue({ email: "s@rp.com", name: "Simone", oid: "oid-s" }),
  };
});
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  createRequestConnection: jest.fn().mockResolvedValue({}),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../features/flags", () => ({ isFeatureEnabledForRoles: jest.fn().mockResolvedValue(true) }));
jest.mock("../ledger/actor", () => ({ resolveLedgerActor: jest.fn().mockResolvedValue({ kind: "user", name: "Simone", role: "facilities_manager", userId: 7 }) }));

import { archiveTenancyResponsibility } from "./archiveTenancyResponsibility";
import { getRequestResponsibilities } from "./getRequestResponsibilities";
import { getTenancyResponsibilities } from "./getTenancyResponsibilities";
import { saveTenancyResponsibility } from "./saveTenancyResponsibility";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";
import { tradeForRequestCategory } from "../tenancyResponsibilities/parse";

export {};
const db = require("../db") as { commitTransaction: jest.Mock; executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const flags = require("../features/flags") as { isFeatureEnabledForRoles: jest.Mock };
const context = new InvocationContext();
const V1 = Buffer.from("0000000000000001", "hex");
const V2 = Buffer.from("0000000000000002", "hex");

const post = (body: unknown) => ({ headers: new Headers(), json: async () => body, query: new URLSearchParams() }) as unknown as HttpRequest;
const get = (q: string) => ({ headers: new Headers(), json: async () => ({}), query: new URLSearchParams(q) }) as unknown as HttpRequest;
const item = (v: Buffer, over: Record<string, unknown> = {}) => ({
  ArchivedAt: null, ArchivedBy: null, AssetId: null, AssetName: null, Category: "HVAC / mechanical", DrawingRef: null, Item: "Server room split A/C",
  Location: "Level 2", MaintainedBy: "tenant", Note: "secret note", ProjectEventId: null, ProjectTitle: null, ResponsibilityId: 21, RowVersion: v, TenantId: 9, ...over,
});

function world(updateRows: unknown[], wr: Record<string, unknown> | null = null) {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (sql.includes("FROM dbo.WorkRequests")) return wr ? [wr] : [];
    if (sql.includes("FROM dbo.Tenants")) return [{ ArchivedAt: null, BuildingId: 5, EmailOnly: false, IsTest: false, LegalName: "Acme", RowVersion: V1, TenantId: 9 }];
    if (sql.includes("FROM dbo.TenancyResponsibilities r")) return [item(V1), item(V1, { ArchivedAt: new Date(), ResponsibilityId: 22 })];
    if (sql.includes("UPDATE dbo.TenancyResponsibilities")) return updateRows;
    if (sql.includes("INSERT INTO dbo.TenancyResponsibilities")) return [{ ResponsibilityId: 23 }];
    return [];
  });
}
beforeEach(() => {
  db.executeQuery.mockReset();
  db.rollbackTransaction.mockClear();
  flags.isFeatureEnabledForRoles.mockResolvedValue(true);
});

describe("saveTenancyResponsibility", () => {
  const edit = { item: "Server room split A/C", maintainedBy: "owner_oncharge", responsibilityId: 21, rowVersion: V2.toString("base64"), tenantId: 9 };

  it("returns 409 and writes nothing when the version is stale", async () => {
    world([]);
    expect((await saveTenancyResponsibility(post(edit), context)).status).toBe(409);
    expect(ledgerInserts(db.executeQuery)).toEqual([]);
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("edits with the current version and ledgers the change without the note", async () => {
    world([{ ResponsibilityId: 21 }]);
    expect((await saveTenancyResponsibility(post({ ...edit, rowVersion: V1.toString("base64") }), context)).status).toBe(200);
    const [entry] = ledgerInserts(db.executeQuery);
    expect(entry).toMatchObject({ action: "tenancy.responsibility_update", subjectId: "9", subjectType: "tenancy" });
    expect(JSON.stringify(entry)).not.toContain("secret note");
  });

  it("adds an item (201) and refuses a bad owner, a bad category, a missing item or a missing version on edit", async () => {
    world([]);
    expect((await saveTenancyResponsibility(post({ item: "Door closer", maintainedBy: "base_building", tenantId: 9 }), context)).status).toBe(201);
    expect((await saveTenancyResponsibility(post({ item: "x", maintainedBy: "landlord", tenantId: 9 }), context)).status).toBe(400);
    expect((await saveTenancyResponsibility(post({ category: "Plumbing", item: "x", maintainedBy: "tenant", tenantId: 9 }), context)).status).toBe(400);
    expect((await saveTenancyResponsibility(post({ maintainedBy: "tenant", tenantId: 9 }), context)).status).toBe(400);
    expect((await saveTenancyResponsibility(post({ item: "x", maintainedBy: "tenant", responsibilityId: 21, tenantId: 9 }), context)).status).toBe(400);
  });

  it("is not available while the tenancyResponsibilities flag is off", async () => {
    flags.isFeatureEnabledForRoles.mockResolvedValue(false);
    world([]);
    expect((await saveTenancyResponsibility(post(edit), context)).status).toBe(404);
    expect(flags.isFeatureEnabledForRoles.mock.calls[0][0]).toBe("tenancyResponsibilities");
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("archiveTenancyResponsibility", () => {
  it("archives (never deletes), and a stale version is a 409", async () => {
    world([{ ResponsibilityId: 21 }]);
    expect((await archiveTenancyResponsibility(post({ responsibilityId: 21, rowVersion: V1.toString("base64"), tenantId: 9 }), context)).status).toBe(200);
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "tenancy.responsibility_archive" });
    expect(db.executeQuery.mock.calls.some((c) => /DELETE/i.test(String(c[1])))).toBe(false);
    world([]);
    expect((await archiveTenancyResponsibility(post({ responsibilityId: 21, rowVersion: V2.toString("base64"), tenantId: 9 }), context)).status).toBe(409);
  });
});

describe("reading", () => {
  it("lists a tenancy's items", async () => {
    world([]);
    const res = await getTenancyResponsibilities(get("tenantId=9"), context);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { items: unknown[] }).items).toHaveLength(2);
    expect((await getTenancyResponsibilities(get("tenantId=x"), context)).status).toBe(400);
  });

  it("answers a request's live items and mapped category, and nothing for a request with no tenancy", async () => {
    world([], { LegalName: "Acme", RequestCategory: "air_conditioning", SourceTenantId: 9 });
    const res = await getRequestResponsibilities(get("workRequestId=31"), context);
    expect(res.jsonBody).toMatchObject({ category: "HVAC / mechanical", tenancyName: "Acme", tenantId: 9 });
    expect((res.jsonBody as { items: unknown[] }).items).toHaveLength(1);
    world([], { LegalName: null, RequestCategory: null, SourceTenantId: null });
    expect((await getRequestResponsibilities(get("workRequestId=31"), context)).jsonBody).toMatchObject({ items: [], tenantId: null });
    world([], null);
    expect((await getRequestResponsibilities(get("workRequestId=31"), context)).status).toBe(404);
  });

  it("maps the tenant page's categories to trades", () => {
    expect(tradeForRequestCategory("plumbing")).toBe("Hydraulic");
    expect(tradeForRequestCategory("other")).toBeNull();
    expect(tradeForRequestCategory(null)).toBeNull();
  });
});
