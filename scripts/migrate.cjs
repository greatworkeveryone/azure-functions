#!/usr/bin/env node
/* eslint-disable no-console */
// npm run migrate -- [--dry-run | --apply] [--target <server>/<database>] [--allow-dirty]
//
// Applies migrations by hand under the operator's `az login` identity (the
// app identity has no DDL rights). `npm run migrate` compiles first, so this
// always runs the runner in src/migrate.ts as checked out. There is no default
// database: pass --target or set SQL_SERVER and SQL_DATABASE. See DL-11.

const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { Connection } = require("tedious");
const { checkMigrations, runMigrations } = require("../dist/migrate");
const { MIGRATE_USAGE, parseMigrateArgs, resolveMigrationTarget } = require("../dist/migrate-cli");

const ROOT = path.join(__dirname, "..");

function azureSqlToken() {
  try {
    return execFileSync(
      "az",
      ["account", "get-access-token", "--resource", "https://database.windows.net/", "--query", "accessToken", "-o", "tsv"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ).trim();
  } catch {
    throw new Error("Could not get a SQL token from the Azure CLI. Run `az login` as the operator and try again.");
  }
}

function connectionFactory(target) {
  const local = process.env.LOCAL_SQL === "true";
  const authentication = local
    ? { type: "default", options: { userName: process.env.SQL_USERNAME, password: process.env.SQL_PASSWORD } }
    : { type: "azure-active-directory-access-token", options: { token: azureSqlToken() } };
  return () =>
    new Promise((resolve, reject) => {
      const connection = new Connection({
        server: target.server,
        authentication,
        options: {
          database: target.database,
          encrypt: true,
          trustServerCertificate: local,
          connectTimeout: 30_000,
          // An index build or backfill can outlast tedious' 15 s default.
          requestTimeout: 10 * 60_000,
        },
      });
      connection.on("connect", (err) => (err ? reject(err) : resolve(connection)));
      connection.connect();
    });
}

// Apply only what is committed: a migration edited or added in the working
// tree must not reach a shared database unreviewed.
function assertCleanMigrations() {
  let dirty;
  try {
    dirty = execFileSync("git", ["status", "--porcelain", "--", "migrations"], { cwd: ROOT, encoding: "utf8" }).trim();
  } catch {
    throw new Error("Cannot check migrations/ with git. Apply from a clean checkout, or pass --allow-dirty deliberately.");
  }
  if (dirty) {
    throw new Error(`migrations/ has uncommitted changes:\n${dirty}\nCommit them (or pass --allow-dirty deliberately).`);
  }
}

function printStatus(status) {
  for (const file of status.pending) {
    console.log(`  pending  ${file.name}${file.transactional ? "" : `  [no transaction: ${file.transactionNote}]`}`);
  }
  for (const c of status.changed) console.log(`  CHANGED  ${c.name} (recorded ${c.recorded}, file ${c.current})`);
  for (const i of status.invalid) for (const e of i.errors) console.log(`  INVALID  ${e}`);
  for (const name of status.outOfOrder) console.log(`  out of order  ${name}`);
  for (const name of status.missing) console.log(`  recorded but not on disk  ${name}`);
  if (status.unverified.length) console.log(`  ${status.unverified.length} applied file(s) predate checksums (unverified)`);
  console.log(status.pending.length ? `${status.pending.length} pending.` : "Nothing pending.");
}

async function main() {
  const args = parseMigrateArgs(process.argv.slice(2));
  if (args.help) {
    console.log(MIGRATE_USAGE);
    return 0;
  }
  const target = resolveMigrationTarget(args, process.env);
  console.log(`Target: ${target.server}/${target.database} (from ${target.source})`);
  console.log(`Mode:   ${args.mode === "apply" ? "APPLY" : "dry run (nothing is changed)"}`);
  if (args.mode === "apply" && !args.allowDirty) assertCleanMigrations();

  const connect = connectionFactory(target);
  if (args.mode === "apply") {
    await runMigrations(connect, console.log, { lockTimeoutMs: 5_000, target });
    return 0;
  }
  const status = await checkMigrations(connect);
  printStatus(status);
  return status.changed.length || status.invalid.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
