#!/usr/bin/env node
/*
 * export-roles.cjs - writes the who-can-do-what table (src/action-roles.ts) as
 * exports/action-roles.json: capability -> the roles that may, sorted. The
 * frontend keeps a byte-identical copy as src/constants/action-roles.json and
 * reads it as CAPABILITY_ROLES; both repos pin its SHA-256 in a test.
 *
 *   npm run export-roles            compile, then write the file
 *   npm run export-roles -- --check compile, then exit 1 if the file is stale
 *
 * After writing it: copy it to the frontend, and update the pinned hash in
 * src/__tests__/action-roles.test.ts here and src/constants/actionRoles.test.ts
 * there.
 */
"use strict";

const fs = require("fs");
const path = require("path");

const root = path.join(__dirname, "..");
const { exportActionRoles } = require(path.join(root, "dist", "action-roles.js"));
const target = path.join(root, "exports", "action-roles.json");
const json = `${JSON.stringify(exportActionRoles(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : "";
  if (current !== json) {
    console.error("exports/action-roles.json is stale: run npm run export-roles and copy it to the frontend.");
    process.exit(1);
  }
  console.log("exports/action-roles.json matches src/action-roles.ts");
} else {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, json);
  console.log(`wrote ${path.relative(root, target)} (${Object.keys(JSON.parse(json)).length} capabilities)`);
}
