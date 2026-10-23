/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GST_BASES } from "../gstBasis";
import { findDestructiveStatements } from "../migrate-files";

// Migration 160 runs by hand against production and at startup elsewhere; a
// failing one stops the API (database-safety rules), so the file is held to
// the rules here. A regex tripwire over the raw file, not a SQL parser.

const FILE = "160_tenancy_gst_basis.sql";
const raw = readFileSync(join(__dirname, "..", "..", "migrations", FILE), "utf8");
const stripComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const code = stripComments(raw);
const batches = code.split(/^GO\s*$/im).map((b) => b.trim()).filter(Boolean);

describe("160_tenancy_gst_basis.sql", () => {
  it("is additive: nothing destructive, no backfill and no rewriting of existing rows", () => {
    expect(findDestructiveStatements(raw)).toEqual([]);
    expect(raw).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b|\bTRUNCATE\b|\bDELETE\b|\bALTER\s+COLUMN\b|\bsp_rename\b/i);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE|MERGE|INSERT)\b/i);
  });

  it("adds GstBasis as a nullable NVARCHAR(3), so every existing tenancy reads as not recorded", () => {
    expect(code).toMatch(/ALTER\s+TABLE\s+dbo\.Tenants\s+ADD\s+GstBasis\s+NVARCHAR\(3\)\s+NULL\s*;/i);
    expect(code).not.toMatch(/GstBasis\s+NVARCHAR\(3\)\s+NOT\s+NULL/i);
    expect(code).not.toMatch(/\bDEFAULT\b/i);
  });

  it("limits it to NULL, ex or inc, the same list the code enforces", () => {
    const check = code.match(/ADD\s+CONSTRAINT\s+CK_Tenants_GstBasis\s+CHECK\s*\(((?:[^()]|\([^)]*\))*)\)\s*;/i);
    expect(check).not.toBeNull();
    const body = (check as RegExpMatchArray)[1];
    expect(body).toMatch(/^\s*GstBasis\s+IS\s+NULL\s+OR\s+GstBasis\s+IN\b/i);
    const allowed = [...body.matchAll(/N'([^']+)'/g)].map((m) => m[1]);
    expect(allowed).toEqual([...GST_BASES]);
  });

  it("adds exactly two things, each in its own GO batch, so the CHECK compiles after the column exists", () => {
    const altering = batches.filter((b) => /\bALTER\b/i.test(b));
    expect(altering).toHaveLength(2);
    expect(batches).toHaveLength(2);
    expect(altering.find((b) => /CK_Tenants_GstBasis/.test(b))).not.toMatch(/\bADD\s+GstBasis\b/i);
    expect(batches.findIndex((b) => /ADD\s+GstBasis\b/i.test(b))).toBeLessThan(batches.findIndex((b) => /CK_Tenants_GstBasis/.test(b)));
  });

  it("is safe to run twice: each ALTER sits behind a COL_LENGTH or OBJECT_ID check ahead of it", () => {
    const guard = /^IF\s+(COL_LENGTH|OBJECT_ID)\b/i;
    for (const batch of batches.filter((b) => /\bALTER\b/i.test(b))) {
      expect(batch).toMatch(guard);
      expect(batch.search(guard)).toBeLessThan(batch.search(/\bALTER\b/i));
    }
    expect(code).toMatch(/COL_LENGTH\('dbo\.Tenants',\s*'GstBasis'\)\s+IS\s+NULL/i);
    expect(code).toMatch(/OBJECT_ID\('dbo\.CK_Tenants_GstBasis',\s*'C'\)\s+IS\s+NULL/i);
  });

  it("tells the operator to apply it before the build that reads the new column", () => {
    expect(raw).toMatch(/RUNBOOK:\s*apply 160 before/i);
  });
});
