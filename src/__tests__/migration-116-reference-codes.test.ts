import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEGACY_BUILDING_CODES } from "../reference-codes";

// Production applies migrations automatically at startup (src/migrate.ts) and
// a migration that throws stops the API, so 116 must stay additive and
// re-runnable. These checks read the file as text; nothing touches a database.

const RAW = readFileSync(join(__dirname, "..", "..", "migrations", "116_reference_codes.sql"), "utf8");

function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

const SQL = stripComments(RAW);

// Same split as runMigrations in src/migrate.ts.
const BATCHES = SQL.split(/^GO\s*$/im)
  .map((b) => b.trim())
  .filter(Boolean);

describe("migration 116 is purely additive", () => {
  it("has no DROP, TRUNCATE or DELETE outside comments", () => {
    expect(SQL).not.toMatch(/\bDROP\b/i);
    expect(SQL).not.toMatch(/\bTRUNCATE\b/i);
    expect(SQL).not.toMatch(/\bDELETE\b/i);
  });

  it("never alters an existing column", () => {
    expect(SQL).not.toMatch(/\bALTER\s+COLUMN\b/i);
    const alters = SQL.match(/\bALTER\s+TABLE\b/gi) ?? [];
    const nullableAdds = SQL.match(/\bALTER\s+TABLE\s+dbo\.\w+\s+ADD\s+\w+\s+NVARCHAR\(\d+\)\s+NULL\b/gi) ?? [];
    expect(alters).toHaveLength(3);
    expect(nullableAdds).toHaveLength(3);
  });

  it("guards every ADD COLUMN with an existence check", () => {
    for (const batch of BATCHES.filter((b) => /\bALTER\s+TABLE\b/i.test(b))) {
      const column = batch.match(/\bADD\s+(\w+)/i)?.[1];
      expect(column).toBeDefined();
      expect(batch).toMatch(new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM sys\\.columns[\\s\\S]*?name = '${column}'`, "i"));
    }
  });

  it("guards every CREATE INDEX with an existence check", () => {
    for (const batch of BATCHES.filter((b) => /\bCREATE\s+(UNIQUE\s+)?INDEX\b/i.test(b))) {
      expect(batch).toMatch(/sys\.indexes/i);
      expect(batch).toMatch(/\b(IF NOT EXISTS|IF EXISTS)\b/i);
    }
  });

  it("defines the three columns with the intended types", () => {
    expect(SQL).toMatch(/dbo\.Buildings ADD ReferenceCode NVARCHAR\(4\) NULL/);
    expect(SQL).toMatch(/dbo\.JobInvoices ADD SupplierInvoiceNumber NVARCHAR\(255\) NULL/);
    expect(SQL).toMatch(/dbo\.PurchaseOrders ADD ChargeCode NVARCHAR\(4\) NULL/);
  });
});

describe("migration 116 seed", () => {
  const updates = SQL.match(/\bUPDATE\b[^;]*;/gi) ?? [];

  it("has exactly one UPDATE and it only backfills ReferenceCode", () => {
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatch(/SET\s+b\.ReferenceCode\s*=/i);
  });

  it("every UPDATE is limited to rows where ReferenceCode IS NULL", () => {
    for (const update of updates) expect(update).toMatch(/ReferenceCode\s+IS\s+NULL/i);
  });

  it("never sets a code another building already holds", () => {
    for (const update of updates) {
      expect(update).toMatch(/NOT EXISTS\s*\(\s*SELECT 1 FROM dbo\.Buildings b2 WHERE b2\.ReferenceCode = h\.RefCode\s*\)/i);
    }
  });

  it("only considers active buildings and requires a single match", () => {
    expect(SQL).toMatch(/b\.Active\s*=\s*1/);
    expect(SQL).toMatch(/HAVING COUNT\(\*\) = 1/i);
    expect(SQL.match(/HAVING COUNT\(\*\) = 1/gi)).toHaveLength(2);
  });

  it("creates the unique index before the seed UPDATE", () => {
    const indexBatch = BATCHES.findIndex((b) => /UX_Buildings_ReferenceCode/.test(b) && /CREATE UNIQUE INDEX/i.test(b));
    const seedBatch = BATCHES.findIndex((b) => /\bUPDATE\b/i.test(b));
    expect(indexBatch).toBeGreaterThanOrEqual(0);
    expect(seedBatch).toBeGreaterThan(indexBatch);
  });

  it("keeps the unique index filtered to non-null codes", () => {
    expect(SQL).toMatch(/ON dbo\.Buildings\(ReferenceCode\) WHERE ReferenceCode IS NOT NULL/);
  });

  it("does not seed HB, whose handwriting on the sheet is unclear", () => {
    expect(SQL).not.toMatch(/N'HB'/);
  });

  it("seeds only codes that exist on the sheet", () => {
    const seeded = new Set((SQL.match(/\(N'([^']+)',\s*N'/g) ?? []).map((m) => m.match(/N'([^']+)'/)![1]));
    expect(seeded.size).toBeGreaterThan(15);
    for (const code of seeded) expect(Object.keys(LEGACY_BUILDING_CODES)).toContain(code);
  });
});

describe("migration 116 against the runner's batch splitting", () => {
  it("never uses a column in the batch that adds it", () => {
    for (const column of ["ReferenceCode", "SupplierInvoiceNumber", "ChargeCode"]) {
      const adding = BATCHES.filter((b) => new RegExp(`\\bADD\\s+${column}\\b`).test(b));
      expect(adding).toHaveLength(1);
      const outsideCheck = adding[0].replace(new RegExp(`name = '${column}'`, "g"), "").replace(
        new RegExp(`ADD\\s+${column}`),
        "",
      );
      expect(outsideCheck).not.toMatch(new RegExp(`\\b${column}\\b`));
    }
  });

  it("adds each column in an earlier batch than any other use of it", () => {
    for (const column of ["ReferenceCode", "SupplierInvoiceNumber"]) {
      const addIdx = BATCHES.findIndex((b) => new RegExp(`\\bADD\\s+${column}\\b`).test(b));
      const useIdx = BATCHES.findIndex((b, i) => i !== addIdx && new RegExp(`\\b${column}\\b`).test(b));
      expect(useIdx).toBeGreaterThan(addIdx);
    }
  });

  it("splits into batches that all contain a statement", () => {
    expect(BATCHES.length).toBeGreaterThanOrEqual(7);
    for (const batch of BATCHES) expect(batch.replace(/\s+/g, "")).not.toBe("");
  });

  it("has no line that is only GO inside a batch's text other than separators", () => {
    for (const batch of BATCHES) expect(batch).not.toMatch(/^GO\s*$/im);
  });
});
