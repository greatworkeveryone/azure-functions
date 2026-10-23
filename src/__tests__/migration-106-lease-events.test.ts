/// <reference types="jest" />
// Migration 106 runs by hand in production and at startup on the local Docker
// database, so it must be additive and safe to run twice (database-safety
// rules). A regex tripwire over the raw file; it was also applied twice to the
// local review database (SQL Server 2022) when it was built.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEASE_EVENT_STATES, OPEN_LEASE_EVENT_STATES } from "../leaseEventMachine";

const raw = readFileSync(join(__dirname, "..", "..", "migrations", "106_lease_events.sql"), "utf8");
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const batches = code.split(/^GO\s*$/im).map((b) => b.trim()).filter(Boolean);

describe("106_lease_events.sql is additive and safe to run twice", () => {
  it("contains nothing destructive and rewrites no row", () => {
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|MERGE|UPDATE|INSERT)\b/i);
    expect(code).not.toMatch(/\bALTER\s+COLUMN\b|\bsp_rename\b/i);
    expect(raw).not.toMatch(/^--\s*DESTRUCTIVE:/im);
  });

  it("puts every CREATE and ALTER behind an existence guard in its own batch", () => {
    const ddl = batches.filter((batch) => /\b(CREATE|ALTER)\b/i.test(batch));
    expect(ddl).toHaveLength(8);
    for (const batch of ddl) {
      expect(batch).toMatch(/^IF\s+(NOT\s+EXISTS|COL_LENGTH|OBJECT_ID)\b/i);
      expect(batch.match(/\b(CREATE\s+(UNIQUE\s+)?(TABLE|INDEX)|ALTER\s+TABLE)\b/gi)).toHaveLength(1);
    }
  });

  it("adds the three option columns as nullable INTs, each guarded by COL_LENGTH", () => {
    for (const column of ["OptionsTotal", "OptionsRemaining", "OptionTermMonths"]) {
      expect(code).toContain(`IF COL_LENGTH('dbo.Tenants', '${column}') IS NULL`);
      expect(code).toMatch(new RegExp(`ALTER TABLE dbo\\.Tenants ADD ${column} INT NULL;`));
    }
    expect(code).toMatch(/IF COL_LENGTH\('dbo\.Vacancies', 'AvailableFrom'\) IS NULL\s+ALTER TABLE dbo\.Vacancies ADD AvailableFrom DATE NULL;/);
  });

  it("creates LeaseEvents with a rowversion, archive columns and every machine state in its check", () => {
    expect(code).toMatch(/IF OBJECT_ID\('dbo\.LeaseEvents', 'U'\) IS NULL\s+CREATE TABLE dbo\.LeaseEvents/);
    expect(code).toMatch(/Version\s+ROWVERSION\s+NOT NULL/);
    expect(code).toMatch(/ArchivedAt\s+DATETIME2\s+NULL/);
    expect(code).toMatch(/ArchivedBy\s+NVARCHAR\(200\)\s+NULL/);
    const stateCheck = code.match(/CK_LeaseEvents_State CHECK \(State IN \(([\s\S]*?)\)\)/)?.[1] ?? "";
    const states = [...stateCheck.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort();
    expect(states).toEqual([...LEASE_EVENT_STATES].sort());
  });

  it("allows one open event of each type per tenancy: the index filter is the machine's open states", () => {
    const filter = code.match(/UX_LeaseEvents_OpenPerType[\s\S]*?ON dbo\.LeaseEvents \(TenantId, Type\)\s+WHERE State IN \(([^)]*)\)/)?.[1] ?? "";
    expect([...filter.matchAll(/'(\w+)'/g)].map((m) => m[1]).sort()).toEqual([...OPEN_LEASE_EVENT_STATES].sort());
  });
});
