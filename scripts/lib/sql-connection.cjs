#!/usr/bin/env node
// The operator's connection to a target database, shared by the scripts that run
// by hand under `az login` (migrate.cjs, seed-procedures.cjs): the app identity has
// no DDL rights and no business writing seed data either.

const { execFileSync } = require("node:child_process");
const { Connection } = require("tedious");

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

module.exports = { connectionFactory };
