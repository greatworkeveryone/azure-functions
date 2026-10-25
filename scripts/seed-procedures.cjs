#!/usr/bin/env node
/* eslint-disable no-console */
// npm run seed:procedures -- [--dry-run | --apply] --target <server>/<database>
//
// Loads the procedures library's starting documents (migrations/seeding/
// procedures.seed.json, the frontend's content/procedures as blocks) into
// dbo.Procedures and dbo.ProcedureVersions, under the operator's `az login`
// identity. Dry run unless --apply. Idempotent by slug and version and it only
// adds: a procedure that already has any version is left alone (src/proceduresSeed.ts).
// There is no default database: pass --target or set SQL_SERVER and SQL_DATABASE.

const { loadSeedEntries, runSeed } = require("../dist/proceduresSeed");
const { parseMigrateArgs, resolveMigrationTarget } = require("../dist/migrate-cli");
const { connectionFactory } = require("./lib/sql-connection.cjs");

const USAGE = `Usage: npm run seed:procedures -- [--dry-run | --apply] [--target <server>/<database>]

  (no flag) / --dry-run   say what would be added; changes nothing
  --apply                 add the documents the library does not have yet
  --target s/d            the database to use; otherwise SQL_SERVER + SQL_DATABASE

Apply migration 142 first (the library reads columns it adds), then this once.`;

async function main() {
  const args = parseMigrateArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  const target = resolveMigrationTarget(args, process.env);
  const apply = args.mode === "apply";
  console.log(`Target: ${target.server}/${target.database} (from ${target.source})`);
  console.log(`Mode:   ${apply ? "APPLY" : "dry run (nothing is changed)"}`);

  const connection = await connectionFactory(target)();
  try {
    const report = await runSeed(connection, loadSeedEntries(), { apply, log: console.log });
    console.log(
      apply
        ? `${report.inserted} added, ${report.skipped} left alone, ${report.failed} failed.`
        : `${report.wouldInsert} would be added, ${report.skipped} left alone. Re-run with --apply to add them.`,
    );
    return report.failed > 0 ? 1 : 0;
  } finally {
    connection.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);
