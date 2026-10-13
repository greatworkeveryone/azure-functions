/// <reference types="jest" />
// Migration 094 runs automatically at startup in production: a failure stops
// the whole API and a destructive statement can lose data. These checks read the
// file as text; they cannot prove it runs (the two-path local proof recorded in
// the WP19b report does), but they pin the properties that must never regress.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Connection } from "tedious";
import { LEDGER_ACTIONS, record } from "../ledger";
import { LEDGER_LIMITS } from "../ledger/validate";

jest.mock("../db", () => ({ executeQuery: jest.fn() }));

const db = require("../db") as { executeQuery: jest.Mock };
const root = join(__dirname, "..", "..");
const migration = readFileSync(join(root, "migrations", "094_decision_ledger.sql"), "utf8");

/** The runner's own batch split (src/migrate.ts). */
const batches = migration
  .split(/^GO\s*$/im)
  .map((b) => b.trim())
  .filter(Boolean);

/** The column list exactly as written inside the N'...' literal (quotes doubled). */
function columnsLiteral(): string {
  const m = migration.match(/DECLARE @cols NVARCHAR\(MAX\) = N'([\s\S]*?)';/);
  expect(m).not.toBeNull();
  return m![1];
}

/** The SQL the engine receives: the doubled quotes undone. */
const columnsSql = (): string => columnsLiteral().replace(/''/g, "'");

/** Column name -> its type text, from lines that open a column definition. */
function columns(): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of columnsSql().split("\n")) {
    const m = line.match(
      /^\s{4}(\[?[A-Za-z]+\]?)\s+(BIGINT|INT|BIT|UNIQUEIDENTIFIER|DATETIME2\(\d+\)|NVARCHAR\((?:\d+|MAX)\)|DECIMAL\(\d+,\d+\))/,
    );
    if (m) found.set(m[1].replace(/[[\]]/g, ""), m[2]);
  }
  return found;
}

const EXEC_CREATE_TABLE = /EXEC\(N'CREATE TABLE dbo\.DecisionLedger \(' \+ @cols \+ N'\)([^']*)'\);/g;

describe("migration 094 can't stop startup", () => {
  it("tries an append-only ledger table first", () => {
    const attempts = [...migration.matchAll(EXEC_CREATE_TABLE)];
    expect(attempts).toHaveLength(2);
    expect(attempts[0][1]).toContain(" WITH (LEDGER = ON (APPEND_ONLY = ON))");
    expect(attempts[0].index).toBeLessThan(attempts[1].index!);
  });

  it("builds exactly two tables, ledger and fallback, from the one column variable", () => {
    expect(migration.match(/CREATE TABLE/g)).toHaveLength(2);
    const [ledger, fallback] = [...migration.matchAll(EXEC_CREATE_TABLE)];
    expect(ledger[1]).toBe(" WITH (LEDGER = ON (APPEND_ONLY = ON));");
    // The fallback is the same definition with nothing after the column list.
    expect(fallback[1]).toBe(";");
    expect(migration.match(/DECLARE @cols/g)).toHaveLength(1);
  });

  it("falls back to an ordinary table with a trigger that refuses UPDATE and DELETE", () => {
    expect(migration).toContain(
      "CREATE TRIGGER dbo.TR_DecisionLedger_AppendOnly ON dbo.DecisionLedger INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''DecisionLedger is append-only'', 1; END;",
    );
    expect(migration.match(/CREATE TRIGGER/g)).toHaveLength(1);
  });

  it("makes the fallback table and its trigger atomic: both, or neither", () => {
    const fallback = migration.slice(migration.indexOf("BEGIN TRANSACTION;"), migration.indexOf("PRINT N'094: fallback taken"));
    const at = (needle: string) => fallback.indexOf(needle);
    expect(at("BEGIN TRANSACTION;")).toBe(0);
    expect(at("CREATE TABLE")).toBeGreaterThan(at("BEGIN TRANSACTION;"));
    expect(at("CREATE TRIGGER")).toBeGreaterThan(at("CREATE TABLE"));
    expect(at("COMMIT TRANSACTION;")).toBeGreaterThan(at("CREATE TRIGGER"));
    // A failure in either rolls back and is rethrown, so the start fails loudly
    // and tries again rather than leaving a table with no trigger.
    expect(fallback).toMatch(/BEGIN CATCH\s+IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;\s+THROW;\s+END CATCH/);
  });

  it("only creates the fallback when no table exists yet", () => {
    expect(migration.match(/IF OBJECT_ID\('dbo\.DecisionLedger', 'U'\) IS NULL/g)).toHaveLength(2);
    expect(migration.indexOf("BEGIN TRANSACTION;")).toBeGreaterThan(migration.lastIndexOf("IF OBJECT_ID('dbo.DecisionLedger', 'U') IS NULL"));
  });

  it("says which path it took and why the ledger was refused", () => {
    expect(migration).toContain("PRINT N'094: dbo.DecisionLedger created as an append-only ledger table.';");
    expect(migration).toMatch(/PRINT N'094: ledger table not available \(error ' \+ CAST\(ERROR_NUMBER\(\) AS NVARCHAR\(10\)\) \+ N': ' \+ ERROR_MESSAGE\(\)/);
    expect(migration).toContain("PRINT N'094: fallback taken");
  });

  it("keeps the whole table block in one batch for the runner", () => {
    // 1 table batch + 6 index batches; none of them is split mid-block.
    expect(batches).toHaveLength(7);
    expect(batches[0]).toContain("DECLARE @cols");
    expect(batches[0]).toContain("PRINT N'094: fallback taken");
    expect(batches[0].trimEnd().endsWith("END")).toBe(true);
    expect(columnsLiteral()).not.toMatch(/^GO\s*$/im);
  });

  it("doubles every quote inside the column variable so the literal stays closed", () => {
    expect(columnsLiteral().replace(/''/g, "")).not.toContain("'");
    expect(columnsSql()).toContain("ActorKind IN (N'user', N'system')");
  });
});

describe("migration 094 is additive and re-runnable", () => {
  it("guards the table so a second run is a no-op", () => {
    expect(migration.indexOf("IF OBJECT_ID('dbo.DecisionLedger', 'U') IS NULL")).toBeLessThan(migration.indexOf("DECLARE @cols"));
  });

  it("guards every index so a second run is a no-op", () => {
    const creates = migration.match(/CREATE INDEX/g) ?? [];
    const guards =
      migration.match(
        /IF NOT EXISTS \(SELECT 1 FROM sys\.indexes WHERE name = '[A-Za-z_]+' AND object_id = OBJECT_ID\('dbo\.DecisionLedger'\)\)\s+CREATE INDEX/g,
      ) ?? [];
    expect(creates.length).toBeGreaterThanOrEqual(4);
    expect(guards).toHaveLength(creates.length);
  });

  it("contains none of the statements the database-safety guard refuses, comments included", () => {
    const guarded = migration.match(/\b(DROP\s+TABLE|DROP\s+COLUMN|TRUNCATE|DELETE\s+FROM|ALTER\s+COLUMN|sp_rename)\b/gi);
    expect(guarded).toBeNull();
  });

  it("points at the fallback document in one comment line, and the document exists", () => {
    expect(migration.match(/decision-ledger-fallback\.md/g)).toHaveLength(1);
    expect(existsSync(join(root, "docs", "decision-ledger-fallback.md"))).toBe(true);
  });

  it("backs every index named in PLAN 3.12", () => {
    for (const [name, cols] of [
      ["IX_DecisionLedger_Subject", "(SubjectType, SubjectId, OccurredAt)"],
      ["IX_DecisionLedger_Tenant", "(TenantId, OccurredAt)"],
      ["IX_DecisionLedger_Actor", "(ActorUserId, OccurredAt)"],
      ["IX_DecisionLedger_Action", "(Action, OccurredAt)"],
    ]) {
      expect(migration).toContain(`CREATE INDEX ${name} ON dbo.DecisionLedger ${cols}`);
    }
  });
});

describe("migration 094 matches the code", () => {
  it("has the columns PLAN 3.12 names, plus attribution", () => {
    expect([...columns().keys()]).toEqual([
      "LedgerId", "OccurredAt", "Action", "SubjectType", "SubjectId", "TenantId", "JobId", "BuildingId",
      "ActorUserId", "ActorName", "ActorRole", "ActorKind", "AttributedUserId", "AttributedName", "AttributedRole",
      "Reason", "Before", "After", "Computed", "FinancialImpact", "RuleApplied", "CorrelationId", "AppVersion", "IsException",
    ]);
  });

  it("carries the primary key and the six CHECK constraints in the shared definition", () => {
    const sql = columnsSql();
    expect(sql).toContain("CONSTRAINT PK_DecisionLedger PRIMARY KEY CLUSTERED (LedgerId)");
    for (const name of ["ActorKind", "Attribution", "AttributionNotActor", "BeforeJson", "AfterJson", "ComputedJson"]) {
      expect(sql).toMatch(new RegExp(`CONSTRAINT CK_DecisionLedger_${name}\\s+CHECK`));
    }
    expect(sql.match(/CONSTRAINT CK_DecisionLedger_/g)).toHaveLength(6);
  });

  it("makes the attribution columns nullable", () => {
    for (const name of ["AttributedUserId", "AttributedName", "AttributedRole"]) {
      const line = columnsSql().split("\n").find((l) => l.trim().startsWith(name));
      expect(line).toBeDefined();
      expect(line).toMatch(/\bNULL\b/);
      expect(line).not.toMatch(/NOT NULL/);
    }
  });

  it("has column widths that hold what validation lets through", () => {
    const widths = columns();
    expect(widths.get("SubjectId")).toBe(`NVARCHAR(${LEDGER_LIMITS.subjectId})`);
    expect(widths.get("ActorName")).toBe(`NVARCHAR(${LEDGER_LIMITS.name})`);
    expect(widths.get("AttributedName")).toBe(`NVARCHAR(${LEDGER_LIMITS.name})`);
    expect(widths.get("ActorRole")).toBe(`NVARCHAR(${LEDGER_LIMITS.role})`);
    expect(widths.get("AttributedRole")).toBe(`NVARCHAR(${LEDGER_LIMITS.role})`);
    expect(widths.get("Reason")).toBe(`NVARCHAR(${LEDGER_LIMITS.reason})`);
    expect(widths.get("RuleApplied")).toBe(`NVARCHAR(${LEDGER_LIMITS.ruleApplied})`);
    expect(widths.get("Action")).toBe("NVARCHAR(64)");
    expect(widths.get("SubjectType")).toBe("NVARCHAR(32)");
    expect(widths.get("FinancialImpact")).toBe("DECIMAL(14,2)");
    expect(widths.get("OccurredAt")).toBe("DATETIME2(3)");
  });

  it("has room for every registered action code and subject type", () => {
    for (const [code, def] of Object.entries(LEDGER_ACTIONS)) {
      expect(code.length).toBeLessThanOrEqual(64);
      if (def.subjects !== "any") for (const subject of def.subjects) expect(subject.length).toBeLessThanOrEqual(32);
    }
  });

  it("is written to by record() with exactly the columns that have no default", async () => {
    db.executeQuery.mockResolvedValue([]);
    await record({} as Connection, {
      action: "user.role_change",
      actor: { kind: "user", name: "Ada Admin", role: "admin", userId: 3 },
      subject: { id: 7, type: "app_user" },
    });

    const sql = db.executeQuery.mock.calls[0][1] as string;
    const insertColumns = sql
      .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
      .split(",")
      .map((c) => c.replace(/[[\]\s]/g, ""))
      .filter(Boolean);
    const expected = [...columns().keys()].filter((c) => c !== "LedgerId" && c !== "OccurredAt");
    expect([...insertColumns].sort()).toEqual([...expected].sort());
    // and every placeholder has a matching parameter
    const placeholders = [...sql.matchAll(/@([A-Za-z]+)/g)].map((m) => m[1]);
    const sent = (db.executeQuery.mock.calls[0][2] as { name: string }[]).map((p) => p.name);
    expect([...placeholders].sort()).toEqual([...sent].sort());
  });
});
