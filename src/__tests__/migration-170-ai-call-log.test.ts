/// <reference types="jest" />
// Migration 170 (dbo.AiCallLog, SC-AI1) is applied by hand and must never fail
// because the database refuses ledger tables, nor change anything that exists. These
// read the file as text; the two runs against a local database (apply, apply again)
// are recorded in the package report.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findDestructiveStatements, migrationFromSql, validateMigration } from "../migrate-files";

const FILE = "170_ai_call_log.sql";
const raw = readFileSync(join(__dirname, "..", "..", "migrations", FILE), "utf8");
const stripComments = (sql: string) => sql.replace(/\/\*[\s\S]*?\*\//g, "").replace(/--[^\n]*/g, "");
const code = stripComments(raw);
const batches = code
  .split(/^GO\s*$/im)
  .map((batch) => batch.trim())
  .filter(Boolean);

/** The column list exactly as written in the N'...' literal (quotes doubled), and as the engine receives it. */
const columnsLiteral = raw.match(/DECLARE @cols NVARCHAR\(MAX\) = N'([\s\S]*?)';/)?.[1] ?? "";
const columnsSql = columnsLiteral.replace(/''/g, "'");

/** Column name -> its definition, from lines that open a column. */
const columns = new Map<string, string>(
  columnsSql.split("\n").flatMap((line): Array<[string, string]> => {
    const match = line.match(/^\s{4}([A-Za-z0-9]+)\s+(\S.*?),?$/);
    return match && !["CONSTRAINT", "CHECK"].includes(match[1]) ? [[match[1], match[2]]] : [];
  }),
);

const EXEC_CREATE_TABLE = /EXEC\(N'CREATE TABLE dbo\.AiCallLog \(' \+ @cols \+ N'\)([^']*)'\);/g;

describe("migration 170 can't stop the API", () => {
  it("tries an append-only ledger table first, then the same without the extra option", () => {
    const attempts = [...code.matchAll(EXEC_CREATE_TABLE)];
    expect(attempts).toHaveLength(3);
    expect(attempts[0][1]).toBe(" WITH (SYSTEM_VERSIONING = OFF, LEDGER = ON (APPEND_ONLY = ON));");
    expect(attempts[1][1]).toBe(" WITH (LEDGER = ON (APPEND_ONLY = ON));");
    expect(attempts[2][1]).toBe(";");
    expect(attempts.map((attempt) => attempt.index)).toEqual([...attempts.map((attempt) => attempt.index)].sort((a, b) => a! - b!));
  });

  it("builds all three tables from the one column variable, so they cannot drift apart", () => {
    expect(code.match(/DECLARE @cols/g)).toHaveLength(1);
    expect(code.match(/CREATE TABLE/g)).toHaveLength(3);
  });

  it("falls back to an ordinary table with a trigger that refuses UPDATE and DELETE, created through EXEC", () => {
    expect(code).toContain(
      "EXEC(N'CREATE TRIGGER dbo.TR_AiCallLog_AppendOnly ON dbo.AiCallLog INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''AiCallLog is append-only'', 1; END;');",
    );
    expect(code.match(/CREATE TRIGGER/g)).toHaveLength(1);
  });

  it("makes the fallback table and its trigger atomic: both, or neither", () => {
    const fallback = code.slice(code.indexOf("BEGIN TRANSACTION;"), code.indexOf("COMMIT TRANSACTION;") + "COMMIT TRANSACTION;".length);
    const at = (needle: string) => fallback.indexOf(needle);
    expect(at("CREATE TABLE")).toBeGreaterThan(at("BEGIN TRANSACTION;"));
    expect(at("CREATE TRIGGER")).toBeGreaterThan(at("CREATE TABLE"));
    expect(at("COMMIT TRANSACTION;")).toBeGreaterThan(at("CREATE TRIGGER"));
    expect(code.slice(code.lastIndexOf("BEGIN CATCH"))).toMatch(/IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;\s*THROW;/);
  });

  it("only creates the fallback when no table exists yet", () => {
    expect(code.match(/IF OBJECT_ID\('dbo\.AiCallLog', 'U'\) IS NULL/g)).toHaveLength(2);
    expect(code.indexOf("BEGIN TRANSACTION;")).toBeGreaterThan(code.lastIndexOf("IF OBJECT_ID('dbo.AiCallLog', 'U') IS NULL"));
  });

  it("keeps the whole table block in one batch, with the two indexes in theirs", () => {
    expect(batches).toHaveLength(3);
    expect(batches[0]).toContain("DECLARE @cols");
    expect(batches[0].trimEnd().endsWith("END")).toBe(true);
    expect(columnsLiteral).not.toMatch(/^GO\s*$/im);
  });

  it("doubles every quote inside the column variable so the literal stays closed", () => {
    expect(columnsLiteral.replace(/''/g, "")).not.toContain("'");
    expect(columnsSql).toContain("ActorKind IN ('user', 'system')");
  });

  it("is run by the runner without a wrapping transaction, as 094 and 115 are (TRY/CATCH cannot continue inside one)", () => {
    const file = migrationFromSql(FILE, raw);
    expect(file.transactional).toBe(false);
    expect(file.batches).toHaveLength(3);
  });
});

describe("migration 170 is additive and re-runnable", () => {
  it("passes the runner's own destructive-statement scan with no approval header needed", () => {
    expect(findDestructiveStatements(raw)).toEqual([]);
    expect(validateMigration(migrationFromSql(FILE, raw))).toEqual([]);
    expect(raw).not.toMatch(/^--\s*DESTRUCTIVE:/im);
  });

  it("contains no DROP, TRUNCATE, DELETE or UPDATE outside comments but the trigger's own event list", () => {
    const withoutTriggerEvents = code.replace(/INSTEAD\s+OF\s+UPDATE\s*,\s*DELETE/gi, "");
    expect(withoutTriggerEvents).not.toMatch(/\b(DROP|TRUNCATE|DELETE|UPDATE|ALTER)\b/i);
  });

  it("puts every CREATE behind an existence guard that comes first in its batch", () => {
    const guard = /^IF\s+(NOT\s+EXISTS|OBJECT_ID)\b/i;
    for (const batch of batches) {
      const ddl = batch.search(/\bCREATE\b/i);
      expect(ddl).toBeGreaterThan(-1);
      expect(batch).toMatch(guard);
    }
  });

  it("creates the two indexes the activity screen reads by, each only if missing", () => {
    expect(code).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM sys\.indexes\s+WHERE name = 'IX_AiCallLog_CreatedAt'\s+AND object_id = OBJECT_ID\('dbo\.AiCallLog'\)\s*\)\s+CREATE INDEX IX_AiCallLog_CreatedAt ON dbo\.AiCallLog\(CreatedAt\);/);
    expect(code).toMatch(/IF NOT EXISTS \(\s*SELECT 1 FROM sys\.indexes\s+WHERE name = 'IX_AiCallLog_Purpose'\s+AND object_id = OBJECT_ID\('dbo\.AiCallLog'\)\s*\)\s+CREATE INDEX IX_AiCallLog_Purpose ON dbo\.AiCallLog\(Purpose, CreatedAt\);/);
    expect(code.match(/CREATE INDEX/g)).toHaveLength(2);
  });
});

describe("the columns", () => {
  it.each([
    ["Id", /^BIGINT\s+IDENTITY\(1,1\)\s+NOT NULL\s+CONSTRAINT PK_AiCallLog PRIMARY KEY$/],
    ["CreatedAt", /^DATETIME2\(3\)\s+NOT NULL\s+CONSTRAINT DF_AiCallLog_CreatedAt DEFAULT SYSUTCDATETIME\(\)$/],
    ["ActorKind", /^NVARCHAR\(10\)\s+NOT NULL\b/],
    ["ActorUserId", /^INT\s+NULL$/],
    ["ActorEmail", /^NVARCHAR\(320\)\s+NULL$/],
    ["ActorName", /^NVARCHAR\(200\)\s+NOT NULL$/],
    ["ActorRole", /^NVARCHAR\(32\)\s+NULL$/],
    ["Purpose", /^NVARCHAR\(64\)\s+NOT NULL$/],
    ["PromptVersion", /^NVARCHAR\(80\)\s+NOT NULL$/],
    ["Provider", /^NVARCHAR\(40\)\s+NOT NULL$/],
    ["Model", /^NVARCHAR\(200\)\s+NULL$/],
    ["InputChars", /^INT\s+NOT NULL$/],
    ["OutputChars", /^INT\s+NULL$/],
    ["RedactionCount", /^INT\s+NOT NULL\s+CONSTRAINT DF_AiCallLog_RedactionCount DEFAULT 0$/],
    ["LatencyMs", /^INT\s+NULL$/],
    ["Outcome", /^NVARCHAR\(10\)\s+NOT NULL\b/],
    ["ErrorCode", /^NVARCHAR\(40\)\s+NULL$/],
    ["RecordType", /^NVARCHAR\(40\)\s+NULL$/],
    ["RecordId", /^NVARCHAR\(64\)\s+NULL$/],
    ["CorrelationId", /^UNIQUEIDENTIFIER\s+NULL$/],
    ["InputSha256", /^CHAR\(64\)\s+NOT NULL$/],
    ["InputText", /^NVARCHAR\(MAX\)\s+NULL$/],
    ["OutputText", /^NVARCHAR\(MAX\)\s+NULL$/],
  ])("%s", (name, definition) => {
    expect(columns.get(name)).toMatch(definition);
  });

  it("has no column beyond these", () => {
    expect([...columns.keys()]).toHaveLength(23);
  });

  it("allows only the three outcomes and the two kinds of actor, and ties the error code to the outcome", () => {
    expect(columnsSql).toContain("Outcome IN ('ok', 'refused', 'failed')");
    expect(columnsSql).toContain("ActorKind IN ('user', 'system')");
    expect(columnsSql).toMatch(/\(Outcome = 'ok' AND ErrorCode IS NULL\) OR \(Outcome <> 'ok' AND ErrorCode IS NOT NULL\)/);
  });
});
