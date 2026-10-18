/// <reference types="jest" />
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { findDestructiveStatements, migrationFromSql, scanSql, validateMigration } from "../migrate-files";

// Migration 117 is applied by hand. Pin what can be pinned: the three nullable
// Quotes columns the attributed approval writes, the two R13 tables, the two
// seeded facts and the four escalation policies, all additive and re-runnable.
// migration-safety.test.ts runs the general scans over it as well.

const FILE = "117_quote_approval_attribution.sql";
const DIR = join(__dirname, "..", "..", "migrations");
const sql = readFileSync(join(DIR, FILE), "utf8");
const code = scanSql(sql).code;
const statements = sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");

describe("migration 117: quote approval attribution and the R13 variance margin", () => {
  it.each(["ApprovalAttributedToUserID INT NULL", "ApprovalAttributionDeclaredAt DATETIME2(3) NULL", "AttributionAnsweredAt DATETIME2(3) NULL"])(
    "adds Quotes.%s behind a COL_LENGTH guard on that column",
    (column) => {
      const name = column.split(" ")[0];
      expect(statements).toContain(`IF COL_LENGTH('dbo.Quotes', '${name}') IS NULL\n  ALTER TABLE dbo.Quotes ADD ${column};`);
    },
  );

  it("creates ApprovalFacts and MoneyVariances only when missing", () => {
    expect(statements).toMatch(/IF OBJECT_ID\('dbo\.ApprovalFacts', 'U'\) IS NULL\s+CREATE TABLE dbo\.ApprovalFacts/);
    expect(statements).toMatch(/IF OBJECT_ID\('dbo\.MoneyVariances', 'U'\) IS NULL\s+CREATE TABLE dbo\.MoneyVariances/);
  });

  it("ties each accepted rise to the quote it was measured against (MoneyVariances.QuoteID, nullable)", () => {
    expect(statements).toMatch(/QuoteID\s+INT\s+NULL,/);
  });

  it("seeds the default margin and cap, and the four policies, without overwriting an admin's values", () => {
    expect(statements).toContain("(N'po_variance_margin_percent', CAST(10 AS DECIMAL(18, 4)))");
    expect(statements).toContain("(N'po_variance_cap', CAST(1000 AS DECIMAL(18, 4)))");
    for (const key of ["quote.attribution_notice", "quote.attribution_disputed", "po.variance_notice", "po.variance_disputed"]) {
      expect(statements).toContain(`(N'${key}',`);
    }
    expect(statements.match(/WHEN NOT MATCHED BY TARGET THEN/g)).toHaveLength(2);
    expect(statements).not.toMatch(/WHEN MATCHED/);
  });

  it("drops, narrows, renames and rewrites nothing", () => {
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER COLUMN|sp_rename)\b/i);
    expect(findDestructiveStatements(sql)).toEqual([]);
  });

  it("passes the runner's own checks", () => {
    expect(validateMigration(migrationFromSql(FILE, sql))).toEqual([]);
  });

  it("is the only migration numbered 117", () => {
    expect(readdirSync(DIR).filter((name) => name.startsWith("117_"))).toEqual([FILE]);
  });
});
