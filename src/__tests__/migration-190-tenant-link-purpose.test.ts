/// <reference types="jest" />
// Migration 190 (link purpose + OrgSettings) is applied by hand: additive, defaulted, safe to run twice.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findDestructiveStatements } from "../migrate-files";

const raw = readFileSync(join(__dirname, "..", "..", "migrations", "190_tenant_link_purpose.sql"), "utf8");
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 190", () => {
  it("has no destructive statement and rewrites no existing value", () => {
    expect(findDestructiveStatements(raw)).toEqual([]);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN|sp_rename/i);
  });
  it("adds Purpose NOT NULL with default 'requests', so existing rows become requests", () => {
    expect(code).toMatch(/IF COL_LENGTH\('dbo\.TenantLinks', 'Purpose'\) IS NULL\s+ALTER TABLE dbo\.TenantLinks ADD Purpose NVARCHAR\(30\) NOT NULL CONSTRAINT DF_TenantLinks_Purpose DEFAULT N'requests'/);
  });
  it("guards the CHECK constraint and the new table", () => {
    expect(code).toMatch(/IF NOT EXISTS \(SELECT 1 FROM sys\.check_constraints WHERE name = 'CK_TenantLinks_Purpose'/);
    expect(code).toMatch(/CHECK \(Purpose IN \(N'requests'\)\)/);
    expect(code).toMatch(/IF OBJECT_ID\('dbo\.OrgSettings', 'U'\) IS NULL\s+BEGIN\s+CREATE TABLE dbo\.OrgSettings/);
  });
});
