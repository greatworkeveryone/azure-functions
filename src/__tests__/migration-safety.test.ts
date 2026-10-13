import { readFileSync } from "node:fs";
import { join } from "node:path";

// Production applies migrations automatically at startup (src/migrate.ts), and
// a migration that throws stops the whole API. Migrations for money tables must
// therefore be additive and safe to run twice: nothing destructive, and every
// CREATE / ALTER behind an existence check. This is a regex tripwire over the
// raw files, not a SQL parser.

const MIGRATIONS = [
  "114_payments_invoice_link.sql",
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
