/// <reference types="jest" />
// Migration 094 runs automatically at startup in production: a failure stops
// the whole API and a destructive statement can lose data. These checks read the
// file as text; they cannot prove it runs (the local-container proof recorded in
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

/** The text between CREATE TABLE ... ( and the closing ) WITH (LEDGER ...). */
function tableBody(): string {
  const start = migration.indexOf("CREATE TABLE dbo.DecisionLedger (");
  const end = migration.indexOf(") WITH (LEDGER");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return migration.slice(start + "CREATE TABLE dbo.DecisionLedger (".length, end);
}

/** Column name -> its type text, from lines that open a column definition. */
function columns(): Map<string, string> {
  const found = new Map<string, string>();
  for (const line of tableBody().split("\n")) {
    const m = line.match(
      /^\s{4}(\[?[A-Za-z]+\]?)\s+(BIGINT|INT|BIT|UNIQUEIDENTIFIER|DATETIME2\(\d+\)|NVARCHAR\((?:\d+|MAX)\)|DECIMAL\(\d+,\d+\))/,
    );
    if (m) found.set(m[1].replace(/[[\]]/g, ""), m[2]);
  }
  return found;
}

describe("migration 094 safety", () => {
  it("creates an append-only ledger table", () => {
    expect(migration).toContain("WITH (LEDGER = ON (APPEND_ONLY = ON))");
  });

  it("guards the table so a second run is a no-op", () => {
    expect(migration).toContain("IF OBJECT_ID('dbo.DecisionLedger') IS NULL");
    expect(migration.match(/CREATE TABLE/g)).toHaveLength(1);
  });

  it("guards every index so a second run is a no-op", () => {
    const creates = migration.match(/CREATE INDEX/g) ?? [];
    const guards = migration.match(/IF NOT EXISTS \(SELECT 1 FROM sys\.indexes WHERE name = '[A-Za-z_]+' AND object_id = OBJECT_ID\('dbo\.DecisionLedger'\)\)\s+CREATE INDEX/g) ?? [];
    expect(creates.length).toBeGreaterThanOrEqual(4);
    expect(guards).toHaveLength(creates.length);
  });

  it("is purely additive: no destructive statement or word anywhere, comments included", () => {
    // The guard that arrives from the money-controls branch fails a migration
    // >= 094 that mentions any of these without an approval header.
    const destructive = migration.match(/\b(drop|truncate|delete|deleted|update|updated|alter|sp_rename|rename)\b/gi);
    expect(destructive).toBeNull();
  });

  it("has no line the runner would split on inside the table definition", () => {
    expect(tableBody()).not.toMatch(/^GO\s*$/im);
  });

  it("points at the fallback in one comment line, and the fallback document exists", () => {
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

  it("makes the attribution columns nullable", () => {
    for (const name of ["AttributedUserId", "AttributedName", "AttributedRole"]) {
      const line = tableBody().split("\n").find((l) => l.trim().startsWith(name));
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
