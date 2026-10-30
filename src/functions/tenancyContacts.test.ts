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

import { archiveTenancyContact } from "./archiveTenancyContact";
import { getTenancyContacts } from "./getTenancyContacts";
import { saveTenancyContact } from "./saveTenancyContact";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";

export {};
const db = require("../db") as { commitTransaction: jest.Mock; executeQuery: jest.Mock; rollbackTransaction: jest.Mock };
const flags = require("../features/flags") as { isFeatureEnabledForRoles: jest.Mock };
const context = new InvocationContext();
const V1 = Buffer.from("0000000000000001", "hex");
const V2 = Buffer.from("0000000000000002", "hex");

const post = (body: unknown) => ({ headers: new Headers(), json: async () => body, query: new URLSearchParams() }) as unknown as HttpRequest;
const get = (q: string) => ({ headers: new Headers(), json: async () => ({}), query: new URLSearchParams(q) }) as unknown as HttpRequest;
const contact = (v: Buffer, over: Record<string, unknown> = {}) => ({
  ArchivedAt: null, ArchivedBy: null, AuthorisedForCosts: false, ContactId: 11, Email: "pat@acme.test", IsEscalation: false, LinkId: null,
  Name: "Pat", Phone: null, ReportsIssues: true, RowVersion: v, TenantId: 9, ...over,
});

function world(updateRows: unknown[]) {
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    if (sql.includes("FROM dbo.Tenants")) return [{ ArchivedAt: null, BuildingId: 5, EmailOnly: false, IsTest: false, LegalName: "Acme", RowVersion: V1, TenantId: 9 }];
    if (sql.includes("FROM dbo.TenancyContacts c")) return [contact(V1)];
    if (sql.includes("UPDATE dbo.TenancyContacts")) return updateRows;
    if (sql.includes("INSERT INTO dbo.TenancyContacts")) return [{ ContactId: 12 }];
    return [];
  });
}
beforeEach(() => {
  db.executeQuery.mockReset();
  db.rollbackTransaction.mockClear();
  flags.isFeatureEnabledForRoles.mockResolvedValue(true);
});

describe("saveTenancyContact", () => {
  const edit = { contactId: 11, email: "Pat@Acme.test", name: "Pat", reportsIssues: true, rowVersion: V2.toString("base64"), tenantId: 9 };

  it("returns 409 and writes nothing when the version is stale", async () => {
    world([]);
    const res = await saveTenancyContact(post(edit), context);
    expect(res.status).toBe(409);
    expect(ledgerInserts(db.executeQuery)).toEqual([]);
    expect(db.rollbackTransaction).toHaveBeenCalled();
    expect(db.commitTransaction).not.toHaveBeenCalled();
  });

  it("edits with the current version, lower-cases the email and ledgers the change without the address", async () => {
    world([{ ContactId: 11 }]);
    const res = await saveTenancyContact(post({ ...edit, rowVersion: V1.toString("base64") }), context);
    expect(res.status).toBe(200);
    const [entry] = ledgerInserts(db.executeQuery);
    expect(entry).toMatchObject({ action: "tenancy.contact_update", subjectId: "9", subjectType: "tenancy" });
    expect(JSON.stringify(entry)).not.toContain("acme.test");
  });

  it("adds a contact (201) and refuses an invalid email or a missing version on edit", async () => {
    world([]);
    expect((await saveTenancyContact(post({ name: "Lee", tenantId: 9 }), context)).status).toBe(201);
    expect((await saveTenancyContact(post({ email: "nope", name: "Lee", tenantId: 9 }), context)).status).toBe(400);
    expect((await saveTenancyContact(post({ contactId: 11, name: "Lee", tenantId: 9 }), context)).status).toBe(400);
  });

  it("is not available while the tenantLinks flag is off", async () => {
    flags.isFeatureEnabledForRoles.mockResolvedValue(false);
    world([]);
    expect((await saveTenancyContact(post(edit), context)).status).toBe(404);
    expect(db.executeQuery).not.toHaveBeenCalled();
  });
});

describe("archiveTenancyContact", () => {
  it("archives (never deletes), and a stale version is a 409", async () => {
    world([{ ContactId: 11 }]);
    const ok = await archiveTenancyContact(post({ contactId: 11, rowVersion: V1.toString("base64"), tenantId: 9 }), context);
    expect(ok.status).toBe(200);
    expect(ledgerInserts(db.executeQuery)[0]).toMatchObject({ action: "tenancy.contact_archive" });
    expect(db.executeQuery.mock.calls.some((c) => /DELETE/i.test(String(c[1])))).toBe(false);
    world([]);
    expect((await archiveTenancyContact(post({ contactId: 11, rowVersion: V2.toString("base64"), tenantId: 9 }), context)).status).toBe(409);
  });
});

describe("getTenancyContacts", () => {
  it("seeds on first read and returns contacts with their link status and the tenancy version", async () => {
    world([]);
    const res = await getTenancyContacts(get("tenantId=9"), context);
    expect(res.status).toBe(200);
    expect((res.jsonBody as { tenancyRowVersion: string; contacts: { linkStatus: string }[] }).tenancyRowVersion).toBe(V1.toString("base64"));
    expect((res.jsonBody as { contacts: { linkStatus: string }[] }).contacts[0].linkStatus).toBe("none");
    expect(db.executeQuery.mock.calls.some((c) => String(c[1]).includes("NOT EXISTS (SELECT 1 FROM dbo.TenancyContacts"))).toBe(true);
    expect((await getTenancyContacts(get("tenantId=x"), context)).status).toBe(400);
  });
});
