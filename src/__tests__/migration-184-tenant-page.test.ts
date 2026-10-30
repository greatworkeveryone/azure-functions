/// <reference types="jest" />
// Migration 184 (tenant page; TR3) is applied by hand: additive, nullable, safe to run twice.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findDestructiveStatements } from "../migrate-files";

const raw = readFileSync(join(__dirname, "..", "..", "migrations", "184_tenant_page.sql"), "utf8");
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 184", () => {
  it("has no destructive statement and rewrites no existing value", () => {
    expect(findDestructiveStatements(raw)).toEqual([]);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN|sp_rename/i);
  });
  it("adds every column, table and index only when it is not there, all nullable or defaulted", () => {
    for (const col of ["SourceKind", "SourceTenantId", "SourceContactId", "TenantCategory", "TriageCategory", "TriageUrgency", "TriageSource"]) {
      expect(code).toMatch(new RegExp(`IF COL_LENGTH\\('dbo\\.WorkRequests', '${col}'\\) IS NULL ALTER TABLE dbo\\.WorkRequests ADD ${col} [A-Z]+(\\(\\d+\\))? NULL;`));
    }
    expect(code).toMatch(/IF COL_LENGTH\('dbo\.Buildings', 'EmergencyPhone'\) IS NULL ALTER TABLE dbo\.Buildings ADD EmergencyPhone NVARCHAR\(50\) NULL/);
    expect(code).toMatch(/IF OBJECT_ID\('dbo\.TenantRequestPhotos', 'U'\) IS NULL\s+BEGIN\s+CREATE TABLE/);
    for (const m of code.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)) expect(code).toContain(`WHERE name = '${m[1]}'`);
  });
  it("keeps photos marked unprocessed by default", () => {
    expect(code).toMatch(/Processed\s+BIT\s+NOT NULL CONSTRAINT \w+ DEFAULT 0/);
  });
});
