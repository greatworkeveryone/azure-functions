import { readdir, readFile } from "fs/promises";
import path from "path";
import { TYPES } from "tedious";
import { closeConnection, createServiceConnection, executeQuery } from "./db";

// ─────────────────────────────────────────────────────────────────────────────
// Migration runner
//
// Applies any SQL files in /migrations that haven't been recorded in
// dbo.schema_migrations yet. Seed files (filename contains "_seed_") are
// always skipped.
//
// Safe to call on every startup — already-applied migrations are a no-op.
// Safe under concurrent startup (duplicate inserts are caught and ignored).
// ─────────────────────────────────────────────────────────────────────────────

// At runtime this file lives at dist/migrate.js → migrations/ is one level up.
const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

export async function runMigrations(
  log: (msg: string) => void,
): Promise<void> {
  const connection = await createServiceConnection();
  try {
    // Create the tracking table if this is the first run.
    await executeQuery(
      connection,
      `IF NOT EXISTS (SELECT 1 FROM sys.tables WHERE name = 'schema_migrations')
       CREATE TABLE dbo.schema_migrations (
         migration_name NVARCHAR(255) NOT NULL PRIMARY KEY,
         applied_at     DATETIME2     NOT NULL DEFAULT GETUTCDATE()
       )`,
    );

    const applied = await executeQuery(
      connection,
      "SELECT migration_name FROM dbo.schema_migrations",
    );
    const appliedSet = new Set(applied.map((r) => r.migration_name as string));

    const files = (await readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith(".sql") && !f.includes("_seed_"))
      .sort();

    for (const file of files) {
      if (appliedSet.has(file)) {
        log(`migrate: skip   ${file}`);
        continue;
      }

      log(`migrate: apply  ${file}`);
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), "utf-8");

      // Split on GO batch separators (Azure SQL convention).
      const batches = sql
        .split(/^GO\s*$/im)
        .map((b) => b.trim())
        .filter(Boolean);

      for (const batch of batches) {
        await executeQuery(connection, batch);
      }

      try {
        await executeQuery(
          connection,
          "INSERT INTO dbo.schema_migrations (migration_name) VALUES (@name)",
          [{ name: "name", type: TYPES.NVarChar, value: file }],
        );
      } catch (err: unknown) {
        // Another instance beat us to it — not a problem.
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes("PRIMARY KEY")) throw err;
        log(`migrate: already recorded by another instance — ${file}`);
      }

      log(`migrate: done   ${file}`);
    }

    log("migrate: all migrations up to date");
  } finally {
    closeConnection(connection);
  }
}
