// Manual migration runner for Azure SQL. Connects as whoever is signed in to
// the Azure CLI (`az login`) — that account needs DDL rights; the app's own
// principal doesn't have them.
//
//   npm run build
//   npm run migrate              # list pending migrations (read-only)
//   npm run migrate -- --apply   # apply them
//
// Target defaults to prod; override with SQL_SERVER / SQL_DATABASE.

process.env.SQL_SERVER ??= "rp-cc-sql-server.database.windows.net";
process.env.SQL_DATABASE ??= "free-sql-db-4148991";

const { execFileSync } = require("node:child_process");
const { createConnection } = require("../dist/db.js");
const { pendingMigrations, runMigrations } = require("../dist/migrate.js");

const apply = process.argv.includes("--apply");

function azSqlToken() {
  return execFileSync(
    "az",
    ["account", "get-access-token", "--resource", "https://database.windows.net/", "--query", "accessToken", "-o", "tsv"],
    { encoding: "utf-8" },
  ).trim();
}

async function main() {
  const token = azSqlToken();
  const connect = () => createConnection(token);
  console.log(`Target: ${process.env.SQL_SERVER} / ${process.env.SQL_DATABASE}`);

  const pending = await pendingMigrations(connect);
  if (pending.length === 0) {
    console.log("Nothing pending.");
    return;
  }
  console.log(`Pending (${pending.length}):\n  ${pending.join("\n  ")}`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to apply them.");
    return;
  }
  await runMigrations((msg) => console.log(msg), connect);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
