import { readFileSync } from "node:fs";
import { join } from "node:path";

// Production applies migrations automatically at startup (src/migrate.ts), and
// a migration that throws stops the whole API. Migrations for money tables must
// therefore be additive and safe to run twice: nothing destructive, and every
// CREATE / ALTER behind an existence check. This is a regex tripwire over the
// raw files, not a SQL parser.

const MIGRATIONS = [
  "114_payments_invoice_link.sql",
  "115_myob_api_log.sql",
];

// The one destructive-looking phrase the money migrations need: the trigger
// that makes the append-only log refuse changes. It never changes data itself.
const ALLOWED_PHRASES = [/INSTEAD\s+OF\s+UPDATE\s*,\s*DELETE/gi];

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

function batches(sql: string): string[] {
  // Same split migrate.ts uses.
  return stripComments(sql)
    .split(/^GO\s*$/im)
    .map((b) => b.trim())
    .filter(Boolean);
}

function read(file: string): string {
  return readFileSync(join(__dirname, "..", "..", "migrations", file), "utf8");
}

describe.each(MIGRATIONS)("migration %s", (file) => {
  const raw = read(file);

  it("contains no DROP, TRUNCATE, DELETE or UPDATE outside comments", () => {
    let code = stripComments(raw);
    for (const phrase of ALLOWED_PHRASES) code = code.replace(phrase, "");
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE)\b/i);
  });

  it("puts every CREATE and ALTER behind an existence guard", () => {
    const guard = /^IF\s+(NOT\s+EXISTS|COL_LENGTH|OBJECT_ID|INDEXPROPERTY)\b/i;
    for (const batch of batches(raw)) {
      const ddl = batch.search(/\b(CREATE|ALTER)\b/i);
      if (ddl === -1) continue;
      expect(batch).toMatch(guard);
      expect(batch.search(guard)).toBeLessThan(ddl);
    }
  });

  it("adds columns only as NULLable or with a default", () => {
    const code = stripComments(raw);
    const adds = code.match(/ALTER\s+TABLE\s+[\w.[\]]+\s+ADD\s+(?!CONSTRAINT\b)[^;]+;/gi) ?? [];
    for (const add of adds) {
      expect(add).toMatch(/(?<!NOT\s)NULL\b|\bDEFAULT\b/i);
    }
  });
});

// Migration 115 must never fail because the database rejects ledger tables: a
// throwing migration stops the API. These pin the shape of that guarantee.
describe("migration 115_myob_api_log.sql", () => {
  const raw = read("115_myob_api_log.sql");
  const code = stripComments(raw);

  it("tries an append-only ledger table first", () => {
    expect(code).toMatch(/SYSTEM_VERSIONING = OFF, LEDGER = ON \(APPEND_ONLY = ON\)/);
  });

  it("falls back to an ordinary table, automatically, in the innermost CATCH", () => {
    const afterCatch = code.slice(code.lastIndexOf("BEGIN CATCH"));
    expect(afterCatch).toMatch(/CREATE TABLE dbo\.MyobApiLog/);
    expect(afterCatch).not.toMatch(/LEDGER/);
  });

  it("makes the fallback refuse UPDATE and DELETE with THROW 51000", () => {
    expect(code).toMatch(/CREATE TRIGGER dbo\.TR_MyobApiLog_AppendOnly ON dbo\.MyobApiLog INSTEAD OF UPDATE, DELETE/);
    expect(code).toMatch(/THROW 51000, ''MyobApiLog is append-only'', 1/);
  });

  it("creates the trigger through EXEC, since CREATE TRIGGER must be first in its batch", () => {
    expect(code).toMatch(/EXEC\(N'CREATE TRIGGER/);
  });

  it("wraps the whole table creation in an existence check on the table", () => {
    expect(batches(raw)[0]).toMatch(/^IF OBJECT_ID\('dbo\.MyobApiLog', 'U'\) IS NULL/);
  });

  it("says in a comment that the fallback is not tamper-evident and where to see which path ran", () => {
    expect(raw).toMatch(/NOT TAMPER-EVIDENT/);
    expect(raw).toMatch(/ledger_type_desc FROM sys\.tables/);
  });

  it("creates the three indexes", () => {
    for (const name of ["IX_MyobApiLog_OccurredAt", "IX_MyobApiLog_CorrelationId", "IX_MyobApiLog_ActorName_OccurredAt"]) {
      expect(code).toContain(name);
    }
  });

  it("has every column that src/myob-api-log.ts inserts", () => {
    const source = readFileSync(join(__dirname, "..", "myob-api-log.ts"), "utf8");
    const insert = /INSERT INTO dbo\.MyobApiLog\s*\(([^)]*)\)/.exec(source);
    expect(insert).not.toBeNull();
    const columns = (insert as RegExpExecArray)[1].split(",").map((c) => c.trim());
    expect(columns.length).toBeGreaterThan(10);
    for (const column of columns) {
      expect(code).toMatch(new RegExp(`\\b${column}\\b`));
    }
  });
});
