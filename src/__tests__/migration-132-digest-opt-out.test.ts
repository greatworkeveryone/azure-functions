/// <reference types="jest" />
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Migration 132 runs automatically at startup in production and a failing one
// stops the API (database-safety rules), so the file is held to the rules here.
// This is a regex tripwire over the raw file, not a SQL parser.

const FILE = "132_digest_opt_out.sql";
const raw = readFileSync(join(__dirname, "..", "..", "migrations", FILE), "utf8");
const stripComments = (sql: string): string => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const code = stripComments(raw);
const batches = code.split(/^GO\s*$/im).map((b) => b.trim()).filter(Boolean);

describe("132_digest_opt_out.sql", () => {
  it("is additive: nothing destructive, comments included, and no rewriting of values", () => {
    expect(raw).not.toMatch(/\bDROP\s+(TABLE|COLUMN)\b|\bTRUNCATE\b|\bDELETE\s+FROM\b|\bALTER\s+COLUMN\b|\bsp_rename\b/i);
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE|MERGE|INSERT)\b/i);
  });

  it("adds exactly one column, dbo.AppUsers.DigestOptOut, as a nullable bit", () => {
    const adds = code.match(/ALTER\s+TABLE\s+[\w.[\]]+\s+ADD\s+[^;]+;/gi) ?? [];
    expect(adds).toHaveLength(1);
    expect(adds[0]).toMatch(/dbo\.AppUsers\s+ADD\s+DigestOptOut\s+BIT\s+NULL\s*;/i);
  });

  it("is safe to run twice: the ALTER sits behind a column check, ahead of the ALTER", () => {
    const guard = /^IF\s+(NOT\s+EXISTS|COL_LENGTH)\b/i;
    const altering = batches.filter((b) => /\bALTER\b/i.test(b));
    expect(altering).toHaveLength(1);
    expect(altering[0]).toMatch(guard);
    expect(altering[0].search(guard)).toBeLessThan(altering[0].search(/\bALTER\b/i));
    expect(altering[0]).toMatch(/COL_LENGTH\('dbo\.AppUsers',\s*'DigestOptOut'\)\s+IS\s+NULL/i);
  });

  it("says in a comment that null and 0 both mean the person receives the digest", () => {
    expect(raw).toMatch(/NULL.*0.*receive/is);
  });
});
