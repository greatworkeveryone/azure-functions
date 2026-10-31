/// <reference types="jest" />
jest.mock("../db", () => ({
  beginTransaction: jest.fn().mockResolvedValue(undefined),
  commitTransaction: jest.fn().mockResolvedValue(undefined),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn().mockResolvedValue(undefined),
}));

import type { Connection } from "tedious";
import { AppRole } from "../auth";
import { ledgerInserts } from "../__tests__/fixtures/ledgerCalls";
import { parseAustralianPhone } from "./phone";
import { afterHoursProblem, EDIT_AFTER_HOURS_ROLES, saveAfterHours } from "./afterHours";

const db = require("../db") as { executeQuery: jest.Mock };
const conn = {} as Connection;
const actor = { kind: "user", name: "Simone", role: "facilities_manager", userId: 7 } as const;

describe("after-hours phone validation", () => {
  it.each(["08 8941 1234", "(08) 8941 1234", "0412 345 678", "1800 555 000", "1300 123 456", "13 11 66", "+61 8 8941 1234", "+61 412 345 678", " 08  8941 1234 "])("accepts %s", (v) => {
    expect(parseAustralianPhone(v)).not.toBeNull();
  });
  it.each(["", "000", "131", "12345", "abc", "08 8941 123", "+44 20 7946 0958", "0412 345 6789", "08-8941-1234x", "1 800 555 000 000", null, 7])("refuses %s", (v) => {
    expect(parseAustralianPhone(v)).toBeNull();
  });
  it("keeps single spaces as typed", () => {
    expect(parseAustralianPhone(" 08  8941   1234 ")).toBe("08 8941 1234");
  });
  it("is edited by admin, director and the facilities manager only", () => {
    expect([...EDIT_AFTER_HOURS_ROLES]).toEqual([AppRole.ADMIN, AppRole.DIRECTOR, AppRole.FACILITIES_APPROVAL]);
  });
});

describe("saving and the page gate", () => {
  beforeEach(() => db.executeQuery.mockReset());

  it("ledgers the old and new company number", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (sql.includes("SELECT SettingValue FROM dbo.OrgSettings WITH") ? [{ SettingValue: "08 8941 0000" }] : []));
    expect(await saveAfterHours(conn, { actor, buildingId: null, phone: "08 8941 1234" })).toEqual({ ok: true });
    const [entry] = ledgerInserts(db.executeQuery);
    expect(entry).toMatchObject({ action: "settings.after_hours_set" });
    expect(entry.before).toMatchObject({ phone: "08 8941 0000", scope: "company" });
    expect(entry.after).toMatchObject({ phone: "08 8941 1234", scope: "company" });
  });

  it("refuses a number that is not Australian, before touching the database", async () => {
    const r = await saveAfterHours(conn, { actor, buildingId: null, phone: "+44 20 7946 0958" });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(db.executeQuery).not.toHaveBeenCalled();
  });

  it("clears a building override with null and ledgers it against the building", async () => {
    db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (sql.includes("WITH (UPDLOCK, HOLDLOCK) WHERE BuildingID") ? [{ BuildingName: "Tower One", EmergencyPhone: "0412 345 678" }] : []));
    expect(await saveAfterHours(conn, { actor, buildingId: 5, phone: null })).toEqual({ ok: true });
    const [entry] = ledgerInserts(db.executeQuery);
    expect(entry.before).toMatchObject({ phone: "0412 345 678", scope: "building" });
    expect(entry.after).toMatchObject({ phone: null });
  });

  it("blocks the tenant page until a company number exists or every building with tenants has its own", async () => {
    const rows = (company: string | null, buildings: { BuildingName: string; EmergencyPhone: string | null }[]) =>
      db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => (sql.includes("FROM dbo.OrgSettings") ? (company ? [{ SettingValue: company }] : []) : sql.includes("FROM dbo.Buildings b") ? buildings : []));
    rows(null, []);
    expect(await afterHoursProblem(conn)).toMatch(/after-hours phone number/);
    rows(null, [{ BuildingName: "Tower One", EmergencyPhone: "08 8941 1234" }, { BuildingName: "Annex", EmergencyPhone: null }]);
    expect(await afterHoursProblem(conn)).toMatch(/Annex/);
    rows(null, [{ BuildingName: "Tower One", EmergencyPhone: "08 8941 1234" }]);
    expect(await afterHoursProblem(conn)).toBeNull();
    rows("08 8941 1234", []);
    expect(await afterHoursProblem(conn)).toBeNull();
  });
});
