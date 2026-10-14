import { readdir, readFile } from "fs/promises";
import path from "path";
import { TYPES, type Connection } from "tedious";
import { closeConnection, createServiceConnection, executeQuery } from "./db";

// ─────────────────────────────────────────────────────────────────────────────
// Migration runner
//
// Applies any SQL files in /migrations that haven't been recorded in
// dbo.schema_migrations yet. Seed files (filename contains "_seed_") are
// always skipped.
//
// Production applies migrations by hand (`npm run migrate`, as an admin with
// DDL rights) — the app's service principal is read/write only. Startup just
// reports what's pending; see startupMigrationMode.
//
// Safe to re-run — already-applied migrations are a no-op.
// Safe under concurrent runs (duplicate inserts are caught and ignored).
// ─────────────────────────────────────────────────────────────────────────────

// At runtime this file lives at dist/migrate.js → migrations/ is one level up.
const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

export type StartupMigrationMode = "apply" | "check" | "skip";

// apply: local Docker DB (SA has DDL), or prod with RUN_MIGRATIONS_ON_STARTUP=true.
// check: prod default — log pending migrations, never block startup.
// skip:  anywhere else (per-user dev connections have no DDL).
export function startupMigrationMode(env: NodeJS.ProcessEnv): StartupMigrationMode {
  if (env.LOCAL_SQL === "true") return "apply";
  if (env.AZURE_FUNCTIONS_ENVIRONMENT !== "Production") return "skip";
  return env.RUN_MIGRATIONS_ON_STARTUP === "true" ? "apply" : "check";
}

export function pendingFrom(files: readonly string[], applied: ReadonlySet<string>): string[] {
  return files.filter((f) => !applied.has(f));
}

async function migrationFiles(): Promise<string[]> {
  return (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql") && !f.includes("_seed_"))
    .sort();
}

async function appliedMigrations(connection: Connection): Promise<Set<string>> {
  const rows = await executeQuery(
    connection,
    `IF OBJECT_ID('dbo.schema_migrations', 'U') IS NOT NULL
       SELECT migration_name FROM dbo.schema_migrations`,
  );
  return new Set(rows.map((r) => r.migration_name as string));
}

// Read-only: needs SELECT on dbo.schema_migrations, nothing more.
export async function pendingMigrations(
  connect: () => Promise<Connection> = createServiceConnection,
): Promise<string[]> {
  const connection = await connect();
  try {
    return pendingFrom(await migrationFiles(), await appliedMigrations(connection));
  } finally {
    closeConnection(connection);
  }
}

export async function runMigrations(
  log: (msg: string) => void,
  connect: () => Promise<Connection> = createServiceConnection,
): Promise<void> {
  const connection = await connect();
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

    const appliedSet = await appliedMigrations(connection);

    for (const file of await migrationFiles()) {
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
