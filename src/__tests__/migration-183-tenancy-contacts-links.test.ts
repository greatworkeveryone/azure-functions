/// <reference types="jest" />
// Migration 183 (TenancyContacts, TenantLinks, Tenants.EmailOnly; TR2) is applied by hand: additive,
// nullable or defaulted, safe to run twice, and it never stores a token (only a 32-byte hash).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findDestructiveStatements } from "../migrate-files";

const raw = readFileSync(join(__dirname, "..", "..", "migrations", "183_tenancy_contacts_links.sql"), "utf8");
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 183", () => {
  it("has no destructive statement and rewrites no existing value", () => {
    expect(findDestructiveStatements(raw)).toEqual([]);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN|sp_rename/i);
  });

  it("creates each table, column and index only when it is not there", () => {
    expect(code).toMatch(/IF COL_LENGTH\('dbo\.Tenants', 'EmailOnly'\) IS NULL\s+ALTER TABLE dbo\.Tenants ADD EmailOnly BIT NOT NULL CONSTRAINT \w+ DEFAULT 0/);
    expect(code).toMatch(/IF OBJECT_ID\('dbo\.TenancyContacts', 'U'\) IS NULL\s+BEGIN\s+CREATE TABLE dbo\.TenancyContacts/);
    expect(code).toMatch(/IF OBJECT_ID\('dbo\.TenantLinks', 'U'\) IS NULL\s+BEGIN\s+CREATE TABLE dbo\.TenantLinks/);
    const creates = [...code.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)].map((m) => m[1]);
    for (const name of creates) expect(code).toContain("WHERE name = '" + name + "'");
  });

  it("stores a hash, never a token, and archives instead of deleting", () => {
    expect(code).toContain("TokenHash     BINARY(32)    NOT NULL");
    expect(code).not.toMatch(/\bToken\s+(N?VAR)?CHAR/i);
    expect(code).toContain("UX_TenantLinks_TokenHash");
    expect(code).toContain("ArchivedAt         DATETIME2     NULL");
    expect(code).toContain("RowVersion         ROWVERSION    NOT NULL");
  });

  it("seeds a contact only for a tenancy that has never had one, so a second run adds nothing", () => {
    expect(code).toMatch(/INSERT INTO dbo\.TenancyContacts[\s\S]*NOT EXISTS \(SELECT 1 FROM dbo\.TenancyContacts c WHERE c\.TenantId = t\.TenantId\)/);
  });
});
