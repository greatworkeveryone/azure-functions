/// <reference types="jest" />
// Migration 186 (TenantNotices, the request_attendance / request_completed drafts; TR4) is applied by hand:
// additive, guarded, safe to run twice, and the unique (JobId, Event) index is what makes a notice go once.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findDestructiveStatements } from "../migrate-files";

const raw = readFileSync(join(__dirname, "..", "..", "migrations", "186_tenant_notices.sql"), "utf8");
const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 186", () => {
  it("has no destructive statement and rewrites no existing value", () => {
    expect(findDestructiveStatements(raw)).toEqual([]);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i);
    expect(code).not.toMatch(/ALTER\s+COLUMN|sp_rename/i);
  });

  it("creates the table and every index only when absent, with a unique (JobId, Event)", () => {
    expect(code).toMatch(/IF OBJECT_ID\(N'dbo\.TenantNotices', N'U'\) IS NULL\s+BEGIN\s+CREATE TABLE dbo\.TenantNotices/);
    expect(code).toMatch(/CREATE UNIQUE INDEX UX_TenantNotices_JobEvent ON dbo\.TenantNotices \(JobId, Event\)/);
    for (const name of [...code.matchAll(/CREATE (?:UNIQUE )?INDEX (\w+)/g)].map((m) => m[1])) expect(code).toContain("WHERE name = '" + name + "'");
  });

  it("seeds both templates once, as drafts, and only when the slug is absent", () => {
    for (const slug of ["request-attendance", "request-completed"]) {
      expect(code).toContain("IF NOT EXISTS (SELECT 1 FROM dbo.Procedures WHERE Slug = N'" + slug + "')");
      expect(code).toContain("IF NOT EXISTS (SELECT 1 FROM dbo.ProcedureVersions WHERE Slug = N'" + slug + "')");
    }
    expect([...code.matchAll(/N'draft'/g)]).toHaveLength(2);
    expect(code).not.toMatch(/N'published'/);
  });

  it("keeps the seeded body valid JSON that names only fields the merge catalogue knows, with a droppable link paragraph", () => {
    const blocks = [...code.matchAll(/N'(\[\{"id"[\s\S]*?\}\])',\s*N'draft'/g)].map((m) => JSON.parse(m[1].replace(/''/g, "'")) as Array<{ id: string; text: string }>);
    expect(blocks).toHaveLength(2);
    const known = new Set(["tenant.addressee", "request.summary", "building.name", "request.reference"]);
    for (const list of blocks) {
      expect(list.some((b) => b.id.endsWith("-link"))).toBe(true);
      for (const b of list) for (const m of b.text.matchAll(/\{\{([^}]+)\}\}/g)) expect(known.has(m[1])).toBe(true);
    }
  });
});
