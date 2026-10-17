/// <reference types="jest" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findDestructiveStatements, migrationFromSql, scanSql, splitBatches, validateMigration } from "../migrate-files";

// Migration 139 is applied by hand (`npm run migrate -- --apply`) and there is no
// SQL Server in the unit tests. Pin what can be pinned: it adds the one column the
// key version check reads, once, behind a guard in a batch of its own, and changes
// nothing else. migration-safety.test.ts runs the general scans over it as well.

const FILE = "139_keys_rowversion.sql";
const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");
const sql = readFileSync(join(MIGRATIONS_DIR, FILE), "utf8");
const code = scanSql(sql).code; // comments gone, string literals blanked
const statements = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, ""); // comments gone, strings kept

describe("migration 139: keys rowversion", () => {
  it("adds Keys.Version as a ROWVERSION, and adds nothing else", () => {
    expect(code).toMatch(/ALTER TABLE dbo\.Keys ADD Version ROWVERSION;/);
    expect(code.match(/\bALTER\b/gi)).toHaveLength(1);
    expect(code).not.toMatch(/\b(CREATE|INSERT|MERGE|EXECUTE)\b/i);
    expect([...new Set(code.match(/\bdbo\.\w+/g))]).toEqual(["dbo.Keys"]);
  });

  it("is safe to run twice: the only DDL sits behind a COL_LENGTH check on the very column it adds", () => {
    const guarded = statements.match(/IF COL_LENGTH\('dbo\.Keys', '(\w+)'\) IS NULL\s+ALTER TABLE dbo\.Keys ADD (\w+) ROWVERSION;/);
    expect(guarded).not.toBeNull();
    expect(guarded?.[1]).toBe(guarded?.[2]);
  });

  it("is one batch, and the batch opens with the guard", () => {
    const batches = splitBatches(statements);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toMatch(/^IF COL_LENGTH\('dbo\.Keys', 'Version'\) IS NULL/);
  });

  it("drops, narrows, renames and rewrites nothing", () => {
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER COLUMN|sp_rename)\b/i);
    expect(findDestructiveStatements(sql)).toEqual([]);
  });

  it("passes the runner's own checks and may run inside its transaction", () => {
    const file = migrationFromSql(FILE, sql);
    expect(validateMigration(file)).toEqual([]);
    expect(file.transactional).toBe(true);
  });

  it("is the only migration numbered 139", () => {
    expect(readdirSync(MIGRATIONS_DIR).filter((name) => name.startsWith("139_"))).toEqual([FILE]);
  });

  it("gives the keys screens the column they now select", () => {
    const source = readFileSync(join(__dirname, "..", "functions", "keys.ts"), "utf8");
    const columns = source.match(/const KEY_COLUMNS = `([\s\S]*?)`;/)?.[1] ?? "";
    expect(columns).toMatch(/\bk\.Version\b/);
  });
});
