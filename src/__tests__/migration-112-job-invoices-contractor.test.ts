/// <reference types="jest" />
// Migration 112 runs automatically at startup in production: a failure stops the
// whole API, and a destructive statement can lose money data. These checks read
// the file as text; the two-run proof on a scratch SQL Server is recorded with
// the commit. They pin what must never regress: additive, NULLable, re-runnable,
// no backfill, and a foreign key that is skipped, not thrown, when its target
// isn't there.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const RAW = readFileSync(join(root, "migrations", "112_job_invoices_contractor_id.sql"), "utf8");

function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
}

const CODE = stripComments(RAW);

/** The runner's own batch split (src/migrate.ts), on the file without comments. */
const BATCHES = CODE.split(/^GO\s*$/im)
  .map((b) => b.trim())
  .filter(Boolean);

const column = BATCHES.find((b) => /\bADD\s+ContractorID\b/i.test(b)) as string;
const foreignKey = BATCHES.find((b) => /\bADD\s+CONSTRAINT\s+FK_JobInvoices_Contractors\b/i.test(b)) as string;
const skipNote = BATCHES.find((b) => /^\s*IF NOT EXISTS[\s\S]*\bPRINT\b/i.test(b)) as string;
const index = BATCHES.find((b) => /\bCREATE\s+INDEX\s+IX_JobInvoices_ContractorID\b/i.test(b)) as string;

describe("migration 112 is purely additive and re-runnable", () => {
  it("has four batches: the column, the foreign key, a note when it was skipped, the index", () => {
    expect(BATCHES).toHaveLength(4);
    expect(BATCHES).toEqual([column, foreignKey, skipNote, index]);
  });

  it("changes no data and drops nothing", () => {
    expect(CODE).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE|INSERT|MERGE|ALTER\s+COLUMN)\b/i);
  });

  it("has no backfill: it never writes a ContractorID into an existing row", () => {
    expect(CODE).not.toMatch(/\bSET\b/i);
    expect(RAW).toMatch(/There is no backfill/);
  });

  it("adds ContractorID as a NULLable INT, once", () => {
    expect(column).toMatch(/^IF COL_LENGTH\('dbo\.JobInvoices', 'ContractorID'\) IS NULL\s+ALTER TABLE dbo\.JobInvoices ADD ContractorID INT NULL;$/i);
    expect(CODE.match(/\bADD\s+ContractorID\b/gi)).toHaveLength(1);
  });

  it("guards the foreign key by its name on JobInvoices", () => {
    expect(foreignKey).toMatch(
      /^IF NOT EXISTS \(\s*SELECT 1 FROM sys\.foreign_keys\s+WHERE name = 'FK_JobInvoices_Contractors'\s+AND parent_object_id = OBJECT_ID\('dbo\.JobInvoices'\)\s*\)/i,
    );
  });

  it("guards the index by its name on JobInvoices", () => {
    expect(index).toMatch(
      /^IF NOT EXISTS \(\s*SELECT 1 FROM sys\.indexes\s+WHERE name = 'IX_JobInvoices_ContractorID'\s+AND object_id = OBJECT_ID\('dbo\.JobInvoices'\)\s*\)\s+CREATE INDEX IX_JobInvoices_ContractorID ON dbo\.JobInvoices\(ContractorID\);?$/i,
    );
  });

  it("puts every CREATE and ALTER behind an existence check", () => {
    const guard = /^IF\s+(NOT\s+EXISTS|COL_LENGTH|OBJECT_ID|INDEXPROPERTY)\b/i;
    for (const batch of BATCHES) {
      const ddl = batch.search(/\b(CREATE|ALTER)\b/i);
      if (ddl === -1) continue;
      expect(batch).toMatch(guard);
      expect(batch.search(guard)).toBeLessThan(ddl);
    }
  });

  it("never uses the column in the batch that adds it, which would not compile", () => {
    expect(column).not.toMatch(/FOREIGN KEY|CREATE INDEX/i);
    for (const batch of [foreignKey, index]) expect(batch).not.toMatch(/\bADD\s+ContractorID\b/i);
  });
});

describe("migration 112's foreign key", () => {
  it("points at the contractor's ContractorID, the id quotes and orders carry", () => {
    expect(foreignKey).toMatch(/FOREIGN KEY \(ContractorID\) REFERENCES dbo\.Contractors\(ContractorID\)/i);
  });

  it("is only added when Contractors has a single-column, unfiltered unique key on ContractorID", () => {
    expect(foreignKey).toMatch(/\bAND EXISTS\s*\(/i);
    expect(foreignKey).toMatch(/i\.object_id = OBJECT_ID\('dbo\.Contractors'\)/);
    expect(foreignKey).toMatch(/i\.is_unique = 1/);
    expect(foreignKey).toMatch(/i\.has_filter = 0/);
    expect(foreignKey).toMatch(/c\.name = 'ContractorID'/);
    expect(foreignKey).toMatch(/ic\.is_included_column = 0/);
    // ...and that key has no other column in it.
    expect(foreignKey).toMatch(/SELECT COUNT\(\*\) FROM sys\.index_columns k[\s\S]*is_included_column = 0\s*\) = 1/);
  });

  it("is skipped with a message, not thrown, so a database without that key still starts", () => {
    expect(skipNote).toMatch(/\bPRINT N'112: /);
    expect(CODE).not.toMatch(/\bTHROW\b|\bRAISERROR\b/i);
  });

  it("has a key to point at: Contractors.ContractorID is declared UNIQUE in migration 002", () => {
    const creation = readFileSync(join(root, "migrations", "002_add_work_requests_and_invoices.sql"), "utf8");
    expect(creation).toMatch(/CREATE TABLE Contractors \([\s\S]*?\bContractorID\s+INT\s+NOT NULL UNIQUE\b/);
  });

  it("references a table that exists by then: JobInvoices is created in migration 017", () => {
    expect(readFileSync(join(root, "migrations", "017_job_invoices.sql"), "utf8")).toMatch(/CREATE TABLE dbo\.JobInvoices/);
  });
});

describe("migration 112 and the code that relies on it", () => {
  const invoices = readFileSync(join(root, "src", "functions", "invoices.ts"), "utf8");
  const emails = readFileSync(join(root, "src", "functions", "emails.ts"), "utf8");

  it("is what the invoice writes fill in: the column name matches", () => {
    expect(invoices).toMatch(/INSERT INTO JobInvoices\s+\(JobID, InvoiceNumber, Seq, ContractorID, ContractorName,/);
    expect(emails).toMatch(/INSERT INTO JobInvoices\s+\(JobID, Amount, ContractorID, ContractorName,/);
  });

  it("is the only migration numbered 112, and sorts between 095 and 113, the order the runner applies them in", () => {
    expect(readdirSync(join(root, "migrations")).filter((f) => f.startsWith("112_"))).toEqual(["112_job_invoices_contractor_id.sql"]);
    expect("112_job_invoices_contractor_id.sql" > "095_cpi_index_metadata.sql").toBe(true);
    expect("112_job_invoices_contractor_id.sql" < "113_locations_and_assets.sql").toBe(true);
  });
});
