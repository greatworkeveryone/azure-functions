/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Migration 136 runs by hand against production and at startup elsewhere; a
// failing one stops the API (database-safety rules), so the file is held to
// the rules here. A regex tripwire over the raw file, not a SQL parser.

const FILE = "136_building_category_owner.sql";
const raw = readFileSync(join(__dirname, "..", "..", "migrations", FILE), "utf8");
const stripComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const code = stripComments(raw);
const batches = code.split(/^GO\s*$/im).map((b) => b.trim()).filter(Boolean);

describe("136_building_category_owner.sql", () => {
  it("is additive: nothing destructive and no rewriting of existing rows", () => {
    expect(raw).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+COLUMN\b|\bsp_rename\b/i);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE|MERGE|INSERT)\b/i);
  });

  it("adds Category as NOT NULL with a 'commercial' default, so no row needs a backfill", () => {
    expect(code).toMatch(
      /ALTER\s+TABLE\s+dbo\.Buildings\s+ADD\s+Category\s+NVARCHAR\(20\)\s+NOT\s+NULL\s+CONSTRAINT\s+DF_Buildings_Category\s+DEFAULT\s+N'commercial'\s*;/i,
    );
  });

  it("adds OwnerName as a nullable NVARCHAR(200)", () => {
    expect(code).toMatch(/ALTER\s+TABLE\s+dbo\.Buildings\s+ADD\s+OwnerName\s+NVARCHAR\(200\)\s+NULL\s*;/i);
  });

  it("limits Category to commercial and residence with a CHECK constraint", () => {
    const check = code.match(/ADD\s+CONSTRAINT\s+CK_Buildings_Category\s+CHECK\s*\(([^)]*)\)/i);
    expect(check).not.toBeNull();
    const allowed = [...(check as RegExpMatchArray)[1].matchAll(/N'([^']+)'/g)].map((m) => m[1]);
    expect(allowed.sort()).toEqual(["commercial", "residence"]);
    expect((check as RegExpMatchArray)[1]).toMatch(/^\s*Category\s+IN\b/i);
  });

  it("adds exactly three things, each in its own GO batch, so the CHECK compiles after the column exists", () => {
    const altering = batches.filter((b) => /\bALTER\b/i.test(b));
    expect(altering).toHaveLength(3);
    expect(batches).toHaveLength(3);
    expect(altering.find((b) => /CK_Buildings_Category/.test(b))).not.toMatch(/\bADD\s+(Category|OwnerName)\b/i);
  });

  it("is safe to run twice: every ALTER sits behind a COL_LENGTH or OBJECT_ID check ahead of it", () => {
    const guard = /^IF\s+(COL_LENGTH|OBJECT_ID)\b/i;
    for (const batch of batches.filter((b) => /\bALTER\b/i.test(b))) {
      expect(batch).toMatch(guard);
      expect(batch.search(guard)).toBeLessThan(batch.search(/\bALTER\b/i));
    }
    expect(code).toMatch(/COL_LENGTH\('dbo\.Buildings',\s*'Category'\)\s+IS\s+NULL/i);
    expect(code).toMatch(/COL_LENGTH\('dbo\.Buildings',\s*'OwnerName'\)\s+IS\s+NULL/i);
    expect(code).toMatch(/OBJECT_ID\('dbo\.CK_Buildings_Category',\s*'C'\)\s+IS\s+NULL/i);
  });

  it("tells the operator to apply it before the build that reads the new columns", () => {
    expect(raw).toMatch(/RUNBOOK:\s*apply 136 before/i);
  });
});
