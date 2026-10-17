/// <reference types="jest" />
// The tenancy adapter: a person can escalate a tenancy by hand (any.manual),
// the inbox links to /tenancy/{tenantId}, and only readers of tenancies see these.
import type { Connection } from "tedious";
import { TYPES } from "tedious";
import { getAdapter, registeredSubjectTypes, requireAdapter } from "./registry";
import { tenancyAdapter } from "./tenancy";
import { manualPolicyKey } from "../manual";
import "./index";

jest.mock("../../db", () => ({ executeQuery: jest.fn() }));
jest.mock("../policies", () => ({ getPolicy: jest.fn() }));
const db = require("../../db") as { executeQuery: jest.Mock };
const { getPolicy } = require("../policies") as { getPolicy: jest.Mock };

const conn = {} as Connection;
const viewer = (...roles: string[]) => ({ name: "Ann", roles, userId: 7 });
const ref = (subjectId: string) => ({ policyKey: "any.manual", subjectId, subjectType: "tenancy" });

const row = (over: Record<string, unknown> = {}) => ({
  ArchivedAt: null,
  BuildingId: 5,
  BuildingName: "Tower A",
  LegalName: "Acme Pty Ltd",
  Status: "current",
  TenantId: 42,
  TradingName: null,
  ...over,
});

beforeEach(() => {
  jest.clearAllMocks();
  db.executeQuery.mockReset();
});

describe("registration", () => {
  it("is registered with the engine's registry alongside jobs and system", () => {
    expect(registeredSubjectTypes()).toEqual(expect.arrayContaining(["job", "system", "tenancy"]));
    expect(getAdapter("tenancy")).toBe(tenancyAdapter);
    expect(requireAdapter("tenancy").subjectType).toBe("tenancy");
  });

  it("uses the any.manual policy for a manual escalation, since the tenancy has no policy of its own", async () => {
    getPolicy.mockImplementation(async (_c: unknown, key: string) => (key === "any.manual" ? { active: true } : null));
    await expect(manualPolicyKey(conn, "tenancy")).resolves.toBe("any.manual");
    expect(getPolicy).toHaveBeenCalledWith(conn, "tenancy.manual");
  });
});

describe("the deep link", () => {
  it("is /tenancy/{tenantId}", () => {
    expect(tenancyAdapter.deepLink("42")).toBe("/tenancy/42");
  });

  it("can't be bent into another path", () => {
    expect(tenancyAdapter.deepLink("42/../../admin")).toBe("/tenancy/42%2F..%2F..%2Fadmin");
  });
});

describe("who sees these", () => {
  it.each(["accounts", "accounts_manager", "admin", "cfo", "director"])("shows them to %s, a reader of tenancies", (role) => {
    expect(tenancyAdapter.visibleTo(viewer(role), ref("42"))).toBe(true);
  });

  it.each(["facilities", "facilities_manager", "user", ""])("hides them from %j", (role) => {
    expect(tenancyAdapter.visibleTo(viewer(role), ref("42"))).toBe(false);
  });

  it("reads the role however it is cased, and any of several", () => {
    expect(tenancyAdapter.visibleTo(viewer("Accounts_Manager"), ref("42"))).toBe(true);
    expect(tenancyAdapter.visibleTo(viewer("facilities", "director"), ref("42"))).toBe(true);
    expect(tenancyAdapter.visibleTo(viewer(), ref("42"))).toBe(false);
  });
});

describe("describing the tenancy", () => {
  it("names the tenant and the building, and carries the ids the inbox row needs", async () => {
    db.executeQuery.mockResolvedValue([row({ TradingName: "Acme Trading" })]);

    const summary = await tenancyAdapter.loadSummary(conn, "42");

    expect(summary).toEqual({
      buildingId: 5,
      context: { buildingName: "Tower A", status: "current", tenantId: 42, tenantName: "Acme Trading" },
      summary: "Tenancy · Acme Trading · Tower A",
    });
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toContain("WHERE t.TenantId = @TenantId");
    expect(params).toEqual([{ name: "TenantId", type: TYPES.Int, value: 42 }]);
  });

  it("falls back to the legal name, and copes with no building", async () => {
    db.executeQuery.mockResolvedValue([row({ BuildingId: null, BuildingName: null })]);
    expect(await tenancyAdapter.loadSummary(conn, "42")).toMatchObject({
      buildingId: null,
      summary: "Tenancy · Acme Pty Ltd",
    });
  });

  it("is null for a tenancy that doesn't exist, or an id that isn't one", async () => {
    db.executeQuery.mockResolvedValue([]);
    expect(await tenancyAdapter.loadSummary(conn, "42")).toBeNull();
    for (const bad of ["abc", "0", "-3", "4.2", "42 OR 1=1", "", "99999999999"]) {
      expect(await tenancyAdapter.loadSummary(conn, bad)).toBeNull();
    }
    expect(db.executeQuery).toHaveBeenCalledTimes(1);
  });
});

describe("whether there is still something to escalate", () => {
  it("is true while the tenancy is live: current, holdover or pending", async () => {
    for (const status of ["current", "holdover", "pending"]) {
      db.executeQuery.mockResolvedValue([row({ Status: status })]);
      expect(await tenancyAdapter.isConditionActive(conn, ref("42"), new Date())).toBe(true);
    }
  });

  it("is false once the tenancy is vacated, gone, or the id isn't one", async () => {
    db.executeQuery.mockResolvedValue([row({ Status: "vacated" })]);
    expect(await tenancyAdapter.isConditionActive(conn, ref("42"), new Date())).toBe(false);
    db.executeQuery.mockResolvedValue([]);
    expect(await tenancyAdapter.isConditionActive(conn, ref("42"), new Date())).toBe(false);
    expect(await tenancyAdapter.isConditionActive(conn, ref("nope"), new Date())).toBe(false);
  });

  it("is false once the tenancy is archived (D4), whatever its status, so a new escalation is refused and an open one clears", async () => {
    const archivedAt = new Date("2026-10-01T00:00:00Z");
    for (const status of ["current", "holdover", "pending", "vacated"]) {
      db.executeQuery.mockResolvedValue([row({ ArchivedAt: archivedAt, Status: status })]);
      expect(await tenancyAdapter.isConditionActive(conn, ref("42"), new Date())).toBe(false);
    }
  });

  it("is true again once an archived tenancy is restored", async () => {
    db.executeQuery.mockResolvedValue([row({ ArchivedAt: new Date("2026-10-01T00:00:00Z") })]);
    expect(await tenancyAdapter.isConditionActive(conn, ref("42"), new Date())).toBe(false);
    db.executeQuery.mockResolvedValue([row({ ArchivedAt: null })]);
    expect(await tenancyAdapter.isConditionActive(conn, ref("42"), new Date())).toBe(true);
  });

  it("reads the archive stamp from the tenancy, by parameter", async () => {
    db.executeQuery.mockResolvedValue([row()]);
    await tenancyAdapter.isConditionActive(conn, ref("42"), new Date());
    const [, sql, params] = db.executeQuery.mock.calls[0];
    expect(sql).toContain("t.ArchivedAt");
    expect(params).toEqual([{ name: "TenantId", type: TYPES.Int, value: 42 }]);
  });
});

describe("the ledger scope", () => {
  it("scopes the escalation's ledger rows to the tenancy", () => {
    expect(tenancyAdapter.ledgerScope?.({ context: null, subjectId: "42" })).toEqual({ tenantId: 42 });
    expect(tenancyAdapter.ledgerScope?.({ context: null, subjectId: "nope" })).toEqual({ tenantId: null });
  });
});
