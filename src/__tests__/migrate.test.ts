/// <reference types="jest" />
// The migration runner against a mocked connection (DL-11): one transaction
// per file, an applock around the run, SHA-256 checksums, an explicit target.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

jest.mock("../db", () => ({
  beginTransaction: jest.fn(),
  closeConnection: jest.fn(),
  commitTransaction: jest.fn(),
  executeBatch: jest.fn(),
  executeQuery: jest.fn(),
  rollbackTransaction: jest.fn(),
}));

import { checkMigrations, runMigrations, startupMigrationMode } from "../migrate";
import { parseMigrateArgs, resolveMigrationTarget } from "../migrate-cli";
import { findDestructiveStatements, loadMigrations, migrationChecksum, migrationFromSql, validateMigration } from "../migrate-files";
import type { MigrationFile } from "../migrate-files";

const db = jest.requireMock("../db") as Record<
  "beginTransaction" | "closeConnection" | "commitTransaction" | "executeBatch" | "executeQuery" | "rollbackTransaction",
  jest.Mock
>;

const MIGRATIONS_DIR = join(__dirname, "..", "..", "migrations");
const TARGET = { database: "free-sql-db-staging", server: "rp.database.windows.net", source: "--target" as const };

let journal: string[];
let lockResult: number;
let recorded: { migration_name: string; Checksum: string | null }[];
let shape: { checksumLen: number | null; tableId: number | null };
let listeners: Record<string, (info: { message: string }) => void>;
const connection = {
  on: jest.fn((event: string, fn: (info: { message: string }) => void) => {
    listeners[event] = fn;
  }),
  removeListener: jest.fn(),
};
const connect = jest.fn(async () => connection as never);
const log = jest.fn();

beforeEach(() => {
  jest.clearAllMocks();
  journal = [];
  lockResult = 0;
  recorded = [];
  shape = { checksumLen: 128, tableId: 1 };
  listeners = {};
  db.beginTransaction.mockImplementation(async () => void journal.push("BEGIN"));
  db.commitTransaction.mockImplementation(async () => void journal.push("COMMIT"));
  db.rollbackTransaction.mockImplementation(async () => void journal.push("ROLLBACK"));
  db.executeBatch.mockImplementation(async (_c: unknown, sql: string) => void journal.push(`batch: ${sql}`));
  db.executeQuery.mockImplementation(async (_c: unknown, sql: string) => {
    journal.push(sql);
    if (/sp_getapplock/.test(sql)) return [{ result: lockResult }];
    if (/OBJECT_ID\(N'dbo\.schema_migrations', N'U'\) AS tableId/.test(sql)) return [shape];
    if (/SELECT migration_name/.test(sql)) return recorded;
    if (/fail-here/.test(sql)) throw new Error("Invalid column name 'Nope'.");
    return [];
  });
});

const file = (name: string, sql: string): MigrationFile => migrationFromSql(name, sql);
const ran = (fragment: string) => journal.filter((sql) => sql.includes(fragment));
const insertParams = () =>
  db.executeQuery.mock.calls
    .filter((c: unknown[]) => /INSERT INTO dbo\.schema_migrations/.test(String(c[1])))
    .map((c: unknown[]) => Object.fromEntries((c[2] as { name: string; value: unknown }[]).map((p) => [p.name, p.value])));

describe("runMigrations", () => {
  it("applies each pending file in one transaction and records name, checksum and SUSER_SNAME() inside it", async () => {
    const a = file("120_a.sql", "CREATE TABLE dbo.A (Id INT);\nGO\nCREATE INDEX IX_A ON dbo.A(Id);");
    await runMigrations(connect, log, { files: [a], target: TARGET });

    const begin = journal.indexOf("BEGIN");
    const commit = journal.indexOf("COMMIT");
    const insert = journal.findIndex((sql) => /INSERT INTO dbo\.schema_migrations/.test(sql));
    // A plain batch, not sp_executesql, or the session setting would revert.
    expect(journal[begin - 1]).toBe("batch: SET XACT_ABORT ON;");
    expect(journal.slice(begin + 1, begin + 3)).toEqual(["CREATE TABLE dbo.A (Id INT);", "CREATE INDEX IX_A ON dbo.A(Id);"]);
    expect(insert).toBeGreaterThan(begin);
    expect(insert).toBeLessThan(commit);
    expect(journal[insert]).toMatch(/SUSER_SNAME\(\)/);
    expect(insertParams()).toEqual([{ checksum: a.checksum, name: "120_a.sql" }]);
    expect(db.closeConnection).toHaveBeenCalledWith(connection);
  });

  it("rolls the file back, records nothing and stops when a batch fails", async () => {
    const a = file("120_a.sql", "CREATE TABLE dbo.A (Id INT);\nGO\nSELECT fail-here;");
    const b = file("121_b.sql", "CREATE TABLE dbo.B (Id INT);");

    await expect(runMigrations(connect, log, { files: [a, b], target: TARGET })).rejects.toThrow(
      /120_a\.sql failed in batch 2 of 2.*rolled back/,
    );
    expect(journal).toContain("ROLLBACK");
    expect(journal).not.toContain("COMMIT");
    expect(insertParams()).toEqual([]);
    expect(ran("dbo.B")).toEqual([]);
  });

  it("takes the floorplan_migrations applock before reading anything", async () => {
    await runMigrations(connect, log, { files: [], target: TARGET });
    expect(journal[0]).toMatch(/sp_getapplock @Resource = N'floorplan_migrations', @LockMode = 'Exclusive', @LockOwner = 'Session'/);
    expect(journal[journal.length - 1]).toMatch(/sp_releaseapplock @Resource = N'floorplan_migrations'/);
  });

  it("refuses to run while another run holds the lock", async () => {
    lockResult = -1;
    const a = file("120_a.sql", "CREATE TABLE dbo.A (Id INT);");
    await expect(runMigrations(connect, log, { files: [a], target: TARGET })).rejects.toThrow(/another migration run/);
    expect(ran("dbo.A")).toEqual([]);
    expect(ran("sp_releaseapplock")).toEqual([]);
    expect(db.closeConnection).toHaveBeenCalled();
  });

  it("releases the lock even when a file fails", async () => {
    const a = file("120_a.sql", "SELECT fail-here;");
    await expect(runMigrations(connect, log, { files: [a], target: TARGET })).rejects.toThrow();
    expect(ran("sp_releaseapplock")).toHaveLength(1);
  });

  it("fails loudly, before applying anything, when an applied file's checksum changed", async () => {
    const a = file("120_a.sql", "CREATE TABLE dbo.A (Id INT, Extra INT);");
    const b = file("121_b.sql", "CREATE TABLE dbo.B (Id INT);");
    recorded = [{ Checksum: migrationChecksum("CREATE TABLE dbo.A (Id INT);"), migration_name: "120_a.sql" }];

    await expect(runMigrations(connect, log, { files: [a, b], target: TARGET })).rejects.toThrow(
      /120_a\.sql has changed since it was applied/,
    );
    expect(ran("dbo.B")).toEqual([]);
  });

  it("skips files already applied with the same checksum, and never re-applies one recorded without a checksum", async () => {
    const a = file("120_a.sql", "CREATE TABLE dbo.A (Id INT);");
    const legacy = file("050_legacy.sql", "CREATE TABLE dbo.L (Id INT);");
    recorded = [
      { Checksum: a.checksum, migration_name: "120_a.sql" },
      { Checksum: null, migration_name: "050_legacy.sql" },
    ];
    const result = await runMigrations(connect, log, { files: [legacy, a], target: TARGET });
    expect(result.applied).toEqual([]);
    expect(ran("dbo.A")).toEqual([]);
    expect(ran("dbo.L")).toEqual([]);
  });

  it("runs a file that declares -- NOTRANSACTION without the runner's transaction", async () => {
    const a = file("120_a.sql", "-- Ledger table: cannot run inside a transaction.\n-- NOTRANSACTION\nCREATE TABLE dbo.A (Id INT);");
    expect(a.transactional).toBe(false);
    await runMigrations(connect, log, { files: [a], target: TARGET });
    expect(journal).not.toContain("BEGIN");
    expect(ran("batch: SET XACT_ABORT OFF")).toHaveLength(1);
    expect(insertParams()).toHaveLength(1);
  });

  it("treats a file that manages its own transaction or TRY/CATCH as non-transactional", () => {
    expect(file("120_a.sql", "BEGIN TRY\n  CREATE TABLE dbo.A (Id INT);\nEND TRY\nBEGIN CATCH\nEND CATCH").transactional).toBe(false);
    expect(file("120_b.sql", "BEGIN TRANSACTION;\nCREATE TABLE dbo.B (Id INT);\nCOMMIT;").transactional).toBe(false);
    for (const name of ["094_decision_ledger.sql", "115_myob_api_log.sql", "116_reference_codes.sql"]) {
      expect(file(name, readFileSync(join(MIGRATIONS_DIR, name), "utf8")).transactional).toBe(false);
    }
    expect(file("114_payments_invoice_link.sql", readFileSync(join(MIGRATIONS_DIR, "114_payments_invoice_link.sql"), "utf8")).transactional).toBe(true);
  });

  it("refuses to apply anything when a pending file fails validation", async () => {
    const ok = file("120_a.sql", "CREATE TABLE dbo.A (Id INT);");
    const bad = file("121_b.sql", "DELETE FROM dbo.Jobs WHERE JobID < 0;");
    await expect(runMigrations(connect, log, { files: [ok, bad], target: TARGET })).rejects.toThrow(/121_b\.sql.*DESTRUCTIVE/s);
    expect(ran("dbo.A")).toEqual([]);
  });

  it("adds Checksum and AppliedBy to schema_migrations behind existence guards", async () => {
    await runMigrations(connect, log, { files: [], target: TARGET });
    expect(ran("CREATE TABLE dbo.schema_migrations")[0]).toMatch(/IF OBJECT_ID\(N'dbo\.schema_migrations', N'U'\) IS NULL/);
    expect(ran("ADD Checksum")[0]).toMatch(/IF COL_LENGTH\(N'dbo\.schema_migrations', N'Checksum'\) IS NULL[\s\S]*NVARCHAR\(64\) NULL/);
    expect(ran("ADD AppliedBy")[0]).toMatch(/IF COL_LENGTH\(N'dbo\.schema_migrations', N'AppliedBy'\) IS NULL[\s\S]*NULL/);
  });

  it("prints the target first and passes SQL PRINT output to the log", async () => {
    await runMigrations(connect, log, { files: [], target: TARGET });
    expect(log.mock.calls[0][0]).toMatch(/target rp\.database\.windows\.net\/free-sql-db-staging/);
    listeners.infoMessage({ message: "Skipped UX_Emails_MessageID: duplicates exist" });
    expect(log).toHaveBeenLastCalledWith(expect.stringMatching(/sql: Skipped UX_Emails_MessageID/));
  });
});

describe("checkMigrations", () => {
  it("lists pending and changed files without locking, creating or recording anything", async () => {
    const a = file("120_a.sql", "CREATE TABLE dbo.A (Id INT);");
    const b = file("121_b.sql", "CREATE TABLE dbo.B (Id INT);");
    recorded = [{ Checksum: "0".repeat(64), migration_name: "120_a.sql" }];
    const status = await checkMigrations(connect, { files: [a, b] });
    expect(status.pending.map((f) => f.name)).toEqual(["121_b.sql"]);
    expect(status.changed.map((c) => c.name)).toEqual(["120_a.sql"]);
    expect(journal.some((sql) => /sp_getapplock|CREATE TABLE|ALTER TABLE|INSERT/.test(sql))).toBe(false);
  });

  it("reads a tracking table that predates Checksum, and a database that has none", async () => {
    const a = file("120_a.sql", "CREATE TABLE dbo.A (Id INT);");
    const b = file("121_b.sql", "CREATE TABLE dbo.B (Id INT);");
    shape = { checksumLen: null, tableId: 1 };
    recorded = [{ Checksum: null, migration_name: "120_a.sql" }];
    const legacy = await checkMigrations(connect, { files: [a, b] });
    expect(journal.find((sql) => /SELECT migration_name/.test(sql))).toMatch(/CAST\(NULL AS NVARCHAR\(64\)\) AS Checksum/);
    expect(legacy.unverified).toEqual(["120_a.sql"]);
    expect(legacy.pending.map((f) => f.name)).toEqual(["121_b.sql"]);

    shape = { checksumLen: null, tableId: null };
    const fresh = await checkMigrations(connect, { files: [a, b] });
    expect(fresh.pending.map((f) => f.name)).toEqual(["120_a.sql", "121_b.sql"]);
  });
});

describe("startupMigrationMode", () => {
  it.each([
    [{ AZURE_FUNCTIONS_ENVIRONMENT: "Production" }, "check"],
    [{ AZURE_FUNCTIONS_ENVIRONMENT: "Production", RUN_MIGRATIONS_ON_STARTUP: "true" }, "apply"],
    [{ AZURE_FUNCTIONS_ENVIRONMENT: "Production", RUN_MIGRATIONS_ON_STARTUP: "TRUE" }, "check"],
    [{ LOCAL_SQL: "true" }, "apply"],
    [{}, "skip"],
  ])("%p → %s", (env, mode) => {
    expect(startupMigrationMode(env)).toBe(mode);
  });
});

describe("migration target", () => {
  it("refuses to run without an explicit target", () => {
    expect(() => resolveMigrationTarget(parseMigrateArgs(["--apply"]), {})).toThrow(/explicit target/);
    expect(() => resolveMigrationTarget(parseMigrateArgs([]), { SQL_SERVER: "rp.database.windows.net" })).toThrow(/explicit target/);
  });

  it("reads --target <server>/<database>", () => {
    expect(resolveMigrationTarget(parseMigrateArgs(["--target", "rp.database.windows.net/free-sql-db-staging"]), {})).toEqual(TARGET);
    expect(() => resolveMigrationTarget(parseMigrateArgs(["--target", "rp.database.windows.net"]), {})).toThrow(/server>\/<database/);
  });

  it("falls back to SQL_SERVER + SQL_DATABASE together", () => {
    expect(resolveMigrationTarget(parseMigrateArgs([]), { SQL_DATABASE: "db", SQL_SERVER: "srv" })).toEqual({
      database: "db",
      server: "srv",
      source: "SQL_SERVER/SQL_DATABASE",
    });
  });

  it("parses the modes and refuses unknown flags", () => {
    expect(parseMigrateArgs([]).mode).toBe("check");
    expect(parseMigrateArgs(["--dry-run"]).mode).toBe("check");
    expect(parseMigrateArgs(["--apply"]).mode).toBe("apply");
    expect(() => parseMigrateArgs(["--apply", "--dry-run"])).toThrow(/either/);
    expect(() => parseMigrateArgs(["--force"])).toThrow(/Unknown option --force/);
  });
});

describe("validateMigration and the destructive scan", () => {
  it("passes every migration in the repository", () => {
    const names = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql") && !f.includes("_seed_"));
    for (const name of names) {
      expect([name, validateMigration(file(name, readFileSync(join(MIGRATIONS_DIR, name), "utf8")))]).toEqual([name, []]);
    }
  });

  it("requires the approval header for a destructive file numbered 094 or later, and grandfathers older ones", () => {
    expect(validateMigration(file("121_x.sql", "DROP TABLE dbo.Old;"))).toEqual([expect.stringMatching(/DROP TABLE.*DESTRUCTIVE/)]);
    expect(validateMigration(file("121_x.sql", "-- DESTRUCTIVE: retire Old · approved by Connor 2026-10-14\nDROP TABLE dbo.Old;"))).toEqual([]);
    expect(validateMigration(file("050_x.sql", "DROP TABLE dbo.Old;"))).toEqual([]);
    expect(validateMigration(file("121_x.sql", "  \n-- nothing\n"))).toEqual([expect.stringMatching(/no SQL/)]);
  });

  it.each([
    ["alias delete", "DELETE r FROM dbo.InspectionRaisedJobs r WHERE r.JobId IS NULL;"],
    ["delete without FROM", "DELETE dbo.Jobs WHERE JobID = 1;"],
    ["drop index", "DROP INDEX IX_A ON dbo.A;"],
    ["drop constraint", "ALTER TABLE dbo.A DROP CONSTRAINT FK_A;"],
    ["disable trigger", "DISABLE TRIGGER dbo.TR_DecisionLedger_AppendOnly ON dbo.DecisionLedger;"],
    ["merge delete", "MERGE dbo.A AS t USING dbo.B AS s ON t.Id = s.Id WHEN NOT MATCHED BY SOURCE THEN DELETE;"],
    ["EXEC fragments", "EXEC(N'DROP ' + N'TABLE dbo.Old');"],
    ["sp_executesql", "EXEC sp_executesql N'TRUNCATE TABLE dbo.Jobs';"],
    ["variable", "DECLARE @sql NVARCHAR(MAX) = N'DELETE FROM dbo.Jobs';\nEXEC(@sql);"],
    ["-- inside a string", "SELECT '--'; DELETE FROM dbo.Jobs;"],
  ])("finds %s", (_label, sql) => {
    expect(findDestructiveStatements(sql)).not.toEqual([]);
  });

  it.each([
    ["FK action", "ALTER TABLE dbo.A ADD CONSTRAINT FK_A FOREIGN KEY (B) REFERENCES dbo.B(Id) ON DELETE CASCADE;"],
    ["trigger events", "EXEC(N'CREATE TRIGGER t ON dbo.A INSTEAD OF UPDATE, DELETE AS BEGIN THROW 51000, ''append-only'', 1; END;');"],
    ["comment", "-- DROP TABLE dbo.Jobs\n/* DELETE FROM dbo.Jobs */\nSELECT 1;"],
    ["message", "PRINT 'Nothing to DELETE FROM here';"],
  ])("ignores %s", (_label, sql) => {
    expect(findDestructiveStatements(sql)).toEqual([]);
  });
});

// The runner applies what loadMigrations returns, to production by hand. Demo
// data lives in migrations/seeding/ and in any file named *_seed_*; neither may
// ever reach it (database-safety rule 3: migrations are additive and boring).
describe("loadMigrations", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "floorplan-migrations-"));
    mkdirSync(join(dir, "seeding"));
    writeFileSync(join(dir, "001_a.sql"), "CREATE TABLE dbo.A (Id INT);");
    writeFileSync(join(dir, "002_seed_x.sql"), "INSERT INTO dbo.A (Id) VALUES (1);");
    writeFileSync(join(dir, "seeding", "003_b.sql"), "CREATE TABLE dbo.B (Id INT);");
  });

  afterEach(() => {
    rmSync(dir, { force: true, recursive: true });
  });

  it("returns no file whose name contains _seed_", async () => {
    const names = (await loadMigrations(dir)).map((f) => f.name);
    expect(names).not.toContain("002_seed_x.sql");
    expect(names.filter((name) => name.includes("_seed_"))).toEqual([]);
  });

  it("returns nothing from a sub-directory", async () => {
    const names = (await loadMigrations(dir)).map((f) => f.name);
    expect(names).not.toContain("003_b.sql");
    expect(names).not.toContain("seeding");
    expect(names.filter((name) => name.includes("/") || name.includes("seeding"))).toEqual([]);
  });

  it("is left with the top-level migration, parsed as the runner will apply it", async () => {
    const files = await loadMigrations(dir);
    expect(files.map((f) => f.name)).toEqual(["001_a.sql"]);
    expect(files[0].batches).toEqual(["CREATE TABLE dbo.A (Id INT);"]);
    expect(files[0].checksum).toBe(migrationChecksum("CREATE TABLE dbo.A (Id INT);"));
  });

  it("holds for the repository's own migrations folder: its seeding/ files are never loaded", async () => {
    const names = (await loadMigrations(MIGRATIONS_DIR)).map((f) => f.name);
    const seeding = readdirSync(join(MIGRATIONS_DIR, "seeding"));
    expect(seeding.length).toBeGreaterThan(0);
    for (const name of seeding) expect(names).not.toContain(name);
    expect(names.filter((name) => name.includes("_seed_"))).toEqual([]);
  });
});
