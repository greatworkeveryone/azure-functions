import path from "path";
import { TYPES, type Connection } from "tedious";
import { beginTransaction, closeConnection, commitTransaction, executeBatch, executeQuery, rollbackTransaction } from "./db";
import type { MigrationTarget } from "./migrate-cli";
import { loadMigrations, validateMigration, type MigrationFile } from "./migrate-files";

// ─────────────────────────────────────────────────────────────────────────────
// Migration runner (DL-11)
//
// Applies the SQL files in /migrations that dbo.schema_migrations hasn't
// recorded, in filename order. Per file: one transaction (SET XACT_ABORT ON)
// that also writes the schema_migrations row, unless the file declares
// `-- NOTRANSACTION` or manages its own transaction/TRY-CATCH (then batches
// run as before). A session applock (floorplan_migrations) serialises runs;
// the row stores the file's SHA-256 and SUSER_SNAME(), and an applied file
// whose checksum changed stops the run before anything is applied.
//
// Production startup only checks (startupMigrationMode); applying is
// `npm run migrate -- --apply` under the operator's identity, or
// RUN_MIGRATIONS_ON_STARTUP=true.
// ─────────────────────────────────────────────────────────────────────────────

// At runtime this file lives at dist/migrate.js → migrations/ is one level up.
export const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");
const LOCK = "floorplan_migrations";
const SELECT_RECORDED = "SELECT migration_name, Checksum FROM dbo.schema_migrations";
// Read-only check against a database whose tracking table predates Checksum.
const SELECT_RECORDED_BEFORE_CHECKSUMS =
  "SELECT migration_name, CAST(NULL AS NVARCHAR(64)) AS Checksum FROM dbo.schema_migrations";

export type MigrationLog = (msg: string) => void;
export type ConnectionFactory = () => Promise<Connection>;

export interface MigrationStatus {
  /** Applied files whose recorded checksum differs from the file on disk. */
  changed: { name: string; recorded: string; current: string }[];
  invalid: { name: string; errors: string[] }[];
  /** Recorded names with no file on disk. */
  missing: string[];
  /** Pending files that sort before the newest applied one. */
  outOfOrder: string[];
  pending: MigrationFile[];
  /** Applied before checksums existed; can't be verified. */
  unverified: string[];
}

interface Options {
  files?: MigrationFile[];
}

export function startupMigrationMode(env: Record<string, string | undefined>): "apply" | "check" | "skip" {
  if (env.LOCAL_SQL === "true") return "apply";
  if (env.AZURE_FUNCTIONS_ENVIRONMENT !== "Production") return "skip";
  return env.RUN_MIGRATIONS_ON_STARTUP === "true" ? "apply" : "check";
}

async function readStatus(connection: Connection, files: MigrationFile[]): Promise<MigrationStatus> {
  const [shape] = await executeQuery(
    connection,
    `SELECT OBJECT_ID(N'dbo.schema_migrations', N'U') AS tableId,
            COL_LENGTH(N'dbo.schema_migrations', N'Checksum') AS checksumLen`,
  );
  const rows = shape?.tableId
    ? await executeQuery(connection, shape.checksumLen ? SELECT_RECORDED : SELECT_RECORDED_BEFORE_CHECKSUMS)
    : [];
  const recorded = new Map(rows.map((r) => [r.migration_name as string, (r.Checksum as string | null) ?? null]));
  const onDisk = new Map(files.map((f) => [f.name, f]));
  const newestApplied = [...recorded.keys()].filter((n) => onDisk.has(n)).sort().at(-1) ?? "";
  const pending = files.filter((f) => !recorded.has(f.name));
  const status: MigrationStatus = {
    changed: [],
    invalid: pending.map((f) => ({ errors: validateMigration(f), name: f.name })).filter((i) => i.errors.length > 0),
    missing: [...recorded.keys()].filter((n) => !onDisk.has(n)),
    outOfOrder: pending.filter((f) => f.name < newestApplied).map((f) => f.name),
    pending,
    unverified: [],
  };
  for (const [name, checksum] of recorded) {
    const file = onDisk.get(name);
    if (!file) continue;
    if (checksum === null) status.unverified.push(name);
    else if (checksum !== file.checksum) status.changed.push({ current: file.checksum, name, recorded: checksum });
  }
  return status;
}

function listenForPrint(connection: Connection, log: MigrationLog): () => void {
  const onInfo = (info: { message: string }) => log(`migrate:   sql: ${info.message}`);
  connection.on("infoMessage", onInfo);
  return () => connection.removeListener("infoMessage", onInfo);
}

/** Read-only: what is pending, changed or unverified. Takes no lock and
 *  creates nothing, so the app identity (no DDL) can run it at startup. */
export async function checkMigrations(connect: ConnectionFactory, options: Options = {}): Promise<MigrationStatus> {
  const files = options.files ?? (await loadMigrations(MIGRATIONS_DIR));
  const connection = await connect();
  try {
    return await readStatus(connection, files);
  } finally {
    closeConnection(connection);
  }
}

async function ensureTrackingTable(connection: Connection): Promise<void> {
  await executeQuery(
    connection,
    `IF OBJECT_ID(N'dbo.schema_migrations', N'U') IS NULL
       CREATE TABLE dbo.schema_migrations (
         migration_name NVARCHAR(255) NOT NULL PRIMARY KEY,
         applied_at     DATETIME2     NOT NULL DEFAULT GETUTCDATE()
       )`,
  );
  await executeQuery(
    connection,
    `IF COL_LENGTH(N'dbo.schema_migrations', N'Checksum') IS NULL
       ALTER TABLE dbo.schema_migrations ADD Checksum NVARCHAR(64) NULL`,
  );
  await executeQuery(
    connection,
    `IF COL_LENGTH(N'dbo.schema_migrations', N'AppliedBy') IS NULL
       ALTER TABLE dbo.schema_migrations ADD AppliedBy NVARCHAR(256) NULL`,
  );
}

async function applyFile(connection: Connection, file: MigrationFile): Promise<void> {
  // A session setting, so a plain batch: through sp_executesql it would revert.
  await executeBatch(connection, `SET XACT_ABORT ${file.transactional ? "ON" : "OFF"};`);
  if (file.transactional) await beginTransaction(connection);
  let batch = 0;
  try {
    for (const sql of file.batches) {
      batch += 1;
      await executeQuery(connection, sql);
    }
    batch = 0;
    await executeQuery(
      connection,
      `INSERT INTO dbo.schema_migrations (migration_name, Checksum, AppliedBy)
       VALUES (@name, @checksum, SUSER_SNAME())`,
      [
        { name: "name", type: TYPES.NVarChar, value: file.name },
        { name: "checksum", type: TYPES.NVarChar, value: file.checksum },
      ],
    );
    if (file.transactional) await commitTransaction(connection);
  } catch (err) {
    if (file.transactional) await rollbackTransaction(connection).catch(() => {});
    const where = batch ? `batch ${batch} of ${file.batches.length}` : "recording it";
    const kept = file.transactional
      ? "rolled back, nothing from this file was kept"
      : `NOT transactional (${file.transactionNote}): earlier batches may have committed`;
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`migrate: ${file.name} failed in ${where}; ${kept}: ${reason}`, { cause: err });
  }
}

function refuseIfUnsafe(status: MigrationStatus): void {
  const problems = [
    ...status.changed.map((c) => `${c.name} has changed since it was applied (recorded ${c.recorded.slice(0, 12)}…, file ${c.current.slice(0, 12)}…); fix forward with a new migration`),
    ...status.invalid.flatMap((i) => i.errors),
  ];
  if (problems.length > 0) throw new Error(`migrate: refusing to apply anything:\n  ${problems.join("\n  ")}`);
}

/** Applies every pending file to `target`. Throws on the first failure. */
export async function runMigrations(
  connect: ConnectionFactory,
  log: MigrationLog,
  options: Options & { lockTimeoutMs?: number; target: MigrationTarget },
): Promise<{ applied: string[] }> {
  const { server, database, source } = options.target;
  log(`migrate: target ${server}/${database} (from ${source})`);
  const files = options.files ?? (await loadMigrations(MIGRATIONS_DIR));
  const connection = await connect();
  const stopListening = listenForPrint(connection, log);
  let locked = false;
  const applied: string[] = [];
  try {
    const [lock] = await executeQuery(
      connection,
      `DECLARE @result INT;
       EXEC @result = sp_getapplock @Resource = N'${LOCK}', @LockMode = 'Exclusive', @LockOwner = 'Session', @LockTimeout = @timeout;
       SELECT @result AS result;`,
      [{ name: "timeout", type: TYPES.Int, value: options.lockTimeoutMs ?? 10_000 }],
    );
    if (!lock || (lock.result as number) < 0) {
      throw new Error(`migrate: another migration run holds the ${LOCK} lock (sp_getapplock returned ${lock?.result}); try again when it finishes`);
    }
    locked = true;

    await ensureTrackingTable(connection);
    const status = await readStatus(connection, files);
    refuseIfUnsafe(status);
    for (const name of status.unverified) log(`migrate: unverified ${name} (applied before checksums)`);
    if (status.outOfOrder.length) log(`migrate: WARNING applying out of order: ${status.outOfOrder.join(", ")}`);

    for (const file of status.pending) {
      log(`migrate: apply  ${file.name}${file.transactional ? "" : ` (no transaction: ${file.transactionNote})`}`);
      await applyFile(connection, file);
      applied.push(file.name);
      log(`migrate: done   ${file.name}`);
    }
    log(applied.length ? `migrate: applied ${applied.length} file(s)` : "migrate: all migrations up to date");
    return { applied };
  } finally {
    if (locked) {
      await executeQuery(connection, `EXEC sp_releaseapplock @Resource = N'${LOCK}', @LockOwner = 'Session';`).catch(() => {});
    }
    stopListening();
    closeConnection(connection);
  }
}
