#!/usr/bin/env node
/* eslint-disable no-console */
// npm run backfill:lease-options -- [--dry-run | --apply] --target <server>/<database>
//
// The one-off option backfill (PLAN WP32, §12): fills Tenants.OptionsTotal,
// OptionsRemaining and OptionTermMonths (migration 106) from the free-text
// OptionPeriods with WP19's parser, and lists the tenancies whose text it
// can't read, for accounts to fix. A dry run unless --apply; it fills only
// columns still NULL, so a re-run changes nothing (src/leaseEvents/optionBackfill.ts).
// There is no default database: pass --target or set SQL_SERVER and SQL_DATABASE.

const { runOptionBackfill } = require("../dist/leaseEvents/optionBackfill");
const { parseMigrateArgs, resolveMigrationTarget } = require("../dist/migrate-cli");
const { connectionFactory } = require("./lib/sql-connection.cjs");

const USAGE = `Usage: npm run backfill:lease-options -- [--dry-run | --apply] [--target <server>/<database>]

  (no flag) / --dry-run   list what would be filled and what can't be read; changes nothing
  --apply                 fill the structured option columns that are still empty
  --target s/d            the database to use; otherwise SQL_SERVER + SQL_DATABASE

Apply migration 106 first.`;

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
    const report = await runOptionBackfill(connection, { apply, log: console.log });
    if (!apply) console.log(`Dry run: re-run with --apply to fill ${report.plan.fill.length}.`);
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
