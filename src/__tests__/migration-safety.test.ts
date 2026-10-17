import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { APPROVAL_HEADER, FIRST_GUARDED_MIGRATION, findDestructiveStatements, scanSql } from "../migrate-files";

// Migrations are applied by hand (`npm run migrate -- --apply`, src/migrate.ts)
// or at startup when RUN_MIGRATIONS_ON_STARTUP=true, where a migration that
// throws stops the whole API. Migrations for money tables must therefore be
// additive and safe to run twice: nothing destructive, and every CREATE /
// ALTER behind an existence check. This is a regex tripwire over the raw
// files, not a SQL parser.

const MIGRATIONS = [
  "099_schedule_change_requests.sql",
  "112_job_invoices_contractor_id.sql",
  "114_payments_invoice_link.sql",
  "115_myob_api_log.sql",
  "117_quote_approval_attribution.sql",
  "124_myob_controls.sql",
  "123_graph_subscriptions.sql",
  "128_timer_runs.sql",
  "129_email_intake_watermark.sql",
  "133_email_archive_columns.sql",
  "134_invoice_attachments.sql",
  "135_attachment_archive.sql",
  "136_building_category_owner.sql",
  "139_keys_rowversion.sql",
  "137_job_decision_requests.sql",
  "138_job_decisions.sql",
  "125_myob_reference_cache.sql",
  "126_myob_proposals.sql",
  "119_defects_periods.sql",
  "120_service_schedules.sql",
];

// Destructive-looking phrases that change no data themselves: the trigger that
// makes the append-only log refuse changes, the names of the MYOB update
// operations in 124's CHECK constraint, and a link table's foreign key removing
// its own link row when the parent goes (134, as migration 010 does).
const ALLOWED_PHRASES = [/INSTEAD\s+OF\s+UPDATE\s*,\s*DELETE/gi, /N'(quotes|orders)\.update'/g, /\bON\s+DELETE\s+CASCADE\b/gi];

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

  it("adds columns only as NULLable, with a default, or as a ROWVERSION", () => {
    const code = stripComments(raw);
    const adds = code.match(/ALTER\s+TABLE\s+[\w.[\]]+\s+ADD\s+(?!CONSTRAINT\b)[^;]+;/gi) ?? [];
    for (const add of adds) {
      // The server stamps a ROWVERSION on every row itself (096, 101, 139), so a statement that
      // adds nothing but one needs neither NULL nor a default and cannot fail on existing rows.
      if (/^ALTER\s+TABLE\s+[\w.[\]]+\s+ADD\s+\w+\s+ROWVERSION\s*;$/i.test(add)) continue;
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

  it("creates the fallback table and its trigger in one transaction, without the ledger clause", () => {
    const tx = code.slice(code.indexOf("BEGIN TRANSACTION"), code.indexOf("COMMIT TRANSACTION"));
    expect(tx).toMatch(/CREATE TABLE dbo\.MyobApiLog/);
    expect(tx).toMatch(/CREATE TRIGGER dbo\.TR_MyobApiLog_AppendOnly/);
    expect(tx).not.toMatch(/LEDGER/);
  });

  it("rolls the fallback back and rethrows rather than leave an unprotected table", () => {
    const lastCatch = code.slice(code.lastIndexOf("BEGIN CATCH"));
    expect(lastCatch).toMatch(/IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;\s*THROW;/);
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

// The tables 123 and 129 create must hold every column the code writes.
describe("migrations 123 and 129 match the code that uses them", () => {
  // Each of these files creates exactly one table.
  const columnsIn = (sql: string) => {
    const create = stripComments(sql).match(/CREATE TABLE dbo\.\w+ \(([\s\S]*?)\n  \);/);
    return (create?.[1] ?? "").split("\n").map((line) => line.trim().split(/\s+/)[0]).filter(Boolean);
  };
  // The MERGE's INSERT column list (each source file has one).
  const inserted = (source: string) =>
    source.match(/INSERT \(([^)]*)\)\s*VALUES/)?.[1].split(",").map((c) => c.trim()) ?? [];

  it("GraphSubscriptions has every column graphWebhook.ts writes", () => {
    const source = readFileSync(join(__dirname, "..", "functions", "graphWebhook.ts"), "utf8");
    const columns = columnsIn(read("123_graph_subscriptions.sql"));
    expect(inserted(source)).toEqual(["SubscriptionID", "Mailbox", "Resource", "ExpiresAt", "ClientStateHash"]);
    for (const column of inserted(source)) expect(columns).toContain(column);
  });

  it("EmailSyncState has every column mail-sync.ts writes", () => {
    const source = readFileSync(join(__dirname, "..", "email", "mail-sync.ts"), "utf8");
    const columns = columnsIn(read("129_email_intake_watermark.sql"));
    expect(inserted(source)).toEqual(["Mailbox", "LastReceivedAt", "LastMessageId"]);
    for (const column of inserted(source)) expect(columns).toContain(column);
  });

  it("129 also adds Tenants.ArchivedAt/ArchivedBy (D4) and WorkRequests.SourceHost (D8), nullable", () => {
    const code = stripComments(read("129_email_intake_watermark.sql"));
    expect(code).toMatch(/ALTER TABLE dbo\.Tenants ADD ArchivedAt DATETIME2 NULL;/);
    expect(code).toMatch(/ALTER TABLE dbo\.Tenants ADD ArchivedBy NVARCHAR\(255\) NULL;/);
    expect(code).toMatch(/ALTER TABLE dbo\.WorkRequests ADD SourceHost NVARCHAR\(255\) NULL;/);
  });

  it("123 refuses, rather than skips, a unique index it can't build", () => {
    expect(stripComments(read("123_graph_subscriptions.sql"))).toMatch(/HAVING COUNT\(\*\) > 1\)\s*BEGIN\s*;THROW 51123/);
  });
});

describe("migration 135 matches the code that uses it", () => {
  it("adds Attachments.ArchivedAt and ArchivedBy, nullable, which archiveTenancyDocument stamps", () => {
    const code = stripComments(read("135_attachment_archive.sql"));
    expect(code).toMatch(/ALTER TABLE dbo\.Attachments ADD ArchivedAt DATETIME2 NULL;/);
    expect(code).toMatch(/ALTER TABLE dbo\.Attachments ADD ArchivedBy NVARCHAR\(255\) NULL;/);
    const source = readFileSync(join(__dirname, "..", "functions", "archiveTenancyDocument.ts"), "utf8");
    expect(source).toMatch(/UPDATE dbo\.Attachments SET ArchivedAt = SYSUTCDATETIME\(\), ArchivedBy = @By/);
  });
});

// db-safety-guards reads the raw text, so a destructive statement assembled in
// dynamic SQL — EXEC(N'DROP ' + N'TABLE …'), sp_executesql, a @sql variable —
// slipped past it (data-loss audit §6.2). These read the string literals that
// reach EXEC / sp_executesql / an assignment, fragments joined across `+`.
describe("dynamic SQL in guarded migrations", () => {
  const guarded = readdirSync(join(__dirname, "..", "..", "migrations")).filter(
    (f) => f.endsWith(".sql") && Number.parseInt(f, 10) >= FIRST_GUARDED_MIGRATION,
  );

  it.each(guarded)("%s has no destructive EXEC / sp_executesql string without an approval header", (file) => {
    const raw = read(file);
    const hits = scanSql(raw).dynamic.flatMap((text) => findDestructiveStatements(text));
    if (hits.length > 0) expect(raw).toMatch(APPROVAL_HEADER);
  });

  it("actually sees the dynamic SQL (the ledger triggers are built through EXEC)", () => {
    for (const file of ["094_decision_ledger.sql", "115_myob_api_log.sql"]) {
      expect(scanSql(read(file)).dynamic.some((text) => /CREATE TRIGGER/.test(text))).toBe(true);
    }
  });

  it.each([
    "EXEC(N'DROP ' + N'TABLE dbo.Old');",
    "EXEC sp_executesql N'DELETE dbo.Jobs WHERE JobID = @id', N'@id INT', @id = 1;",
    "DECLARE @sql NVARCHAR(MAX) = N'DISABLE TRIGGER dbo.TR_DecisionLedger_AppendOnly ON dbo.DecisionLedger';\nEXEC(@sql);",
    "EXEC(N'EXEC(N''TRUNCATE TABLE dbo.Jobs'')');",
  ])("flags %s", (sql) => {
    expect(scanSql(sql).dynamic.flatMap((text) => findDestructiveStatements(text))).not.toEqual([]);
  });
});

// Destructive migrations approved in writing (database-safety rule 3). Each
// carries the approval header on its first line, never drops or truncates,
// copies the table it changes to a dated backup before its first DELETE or
// UPDATE (creating the backup only once, so a re-run keeps the first copy),
// and runs in one transaction that rolls back and rethrows.
const APPROVED_DESTRUCTIVE = ["121_approval_limits_normalise.sql"];

describe.each(APPROVED_DESTRUCTIVE)("approved destructive migration %s", (file) => {
  const raw = read(file);
  const code = stripComments(raw);

  it("starts with the DESTRUCTIVE approval header", () => {
    expect(raw.split("\n")[0]).toMatch(/^-- DESTRUCTIVE: .+ · approved by .+ \d{4}-\d{2}-\d{2}$/);
  });

  it("never drops, truncates, renames or alters a column", () => {
    expect(code).not.toMatch(/\b(DROP|TRUNCATE|sp_rename)\b|\bALTER\s+COLUMN\b/i);
  });

  it("copies to a dated backup table before its first DELETE or UPDATE", () => {
    const backup = code.search(/\bSELECT\b[^;]*?\bINTO\s+dbo\.\w+_bak_\d{8}\b/i);
    const firstChange = code.search(/\b(DELETE|UPDATE)\b/i);
    expect(backup).toBeGreaterThan(-1);
    expect(firstChange).toBeGreaterThan(backup);
  });

  it("creates the backup only when it does not exist yet", () => {
    const table = /\bINTO\s+(dbo\.\w+_bak_\d{8})\b/i.exec(code)?.[1];
    expect(table).toBeDefined();
    const guard = code.search(new RegExp(`IF OBJECT_ID\\('${table}', 'U'\\) IS NULL`));
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(code.search(/\bINTO\s+dbo\.\w+_bak_\d{8}\b/i));
  });

  it("runs in one transaction that rolls back and rethrows", () => {
    expect(code).toMatch(/BEGIN TRY\s+BEGIN TRANSACTION;/);
    expect(code).toMatch(/COMMIT TRANSACTION;\s*END TRY/);
    expect(code).toMatch(/BEGIN CATCH\s+IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION;\s*THROW;\s*END CATCH;/);
  });
});
