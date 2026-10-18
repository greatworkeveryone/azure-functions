#!/usr/bin/env node
// Isolated developer review. Never reads cloud SQL or external-service credentials.
// prepare [--email reviewer@example.com] [--skip-build] | api | storage
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const state = path.join(root, ".review-local");
const runtime = path.join(state, "runtime");
const container = "floorplan-review-sql";
const database = "floorplan_review";
const password = "FloorplanReview2026_LocalOnly"; // Local Docker only, loopback-bound.
const command = process.argv[2];
const localEnv = {
  ...process.env,
  LOCAL_SQL: "true", SQL_SERVER: "localhost", SQL_DATABASE: database,
  SQL_USERNAME: "sa", SQL_PASSWORD: password,
};

function run(bin, args, options = {}) {
  const result = spawnSync(bin, args, { cwd: root, env: localEnv, stdio: "inherit", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${bin} exited ${result.status}`);
  return result;
}

function heavyGate() {
  if (os.loadavg()[0] >= 30) throw new Error("Host load is 30 or higher; retry when the machine is quieter.");
}

function prepareRuntime() {
  fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });
  for (const name of ["dist", "node_modules", "migrations"]) {
    const target = path.join(runtime, name);
    if (!fs.existsSync(target)) fs.symlinkSync(path.join(root, name), target, "dir");
  }
  for (const name of ["package.json", "host.json"]) fs.copyFileSync(path.join(root, name), path.join(runtime, name));
  const values = {
    FUNCTIONS_WORKER_RUNTIME: "node", AzureWebJobsStorage: "UseDevelopmentStorage=true",
    LOCAL_SQL: "true", SQL_SERVER: "localhost", SQL_DATABASE: database,
    SQL_USERNAME: "sa", SQL_PASSWORD: password, AZURE_FUNCTIONS_ENVIRONMENT: "Development",
    DEV_ROLE_OVERRIDE_ENABLED: "true", APP_BASE_URL: "http://localhost:3000",
    GRAPH_MAILBOX_ACTIVE: "dev", ACCESS_LOG_ENABLED: "false", MYOB_WRITES_ENABLED: "false",
    ATTRIBUTED_APPROVAL_ENABLED: "false", SCHEDULER_ENABLED: "false",
    APPLICATIONINSIGHTS_CONNECTION_STRING: "", APPINSIGHTS_INSTRUMENTATIONKEY: "",
  };
  for (const name of fs.readdirSync(path.join(root, "src/functions"))) {
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    const source = fs.readFileSync(path.join(root, "src/functions", name), "utf8");
    for (const match of source.matchAll(/app\.(?:timer|storageBlob|storageQueue|serviceBusQueue|serviceBusTopic|eventGrid|eventHub)\(\s*["']([^"']+)/g)) {
      values[`AzureWebJobs.${match[1]}.Disabled`] = "true";
    }
  }
  fs.writeFileSync(path.join(runtime, "local.settings.json"), JSON.stringify({ IsEncrypted: false, Values: values }, null, 2), { mode: 0o600 });
  console.log("Prepared local-only API settings; external credentials omitted and background triggers disabled.");
}

async function prepare() {
  heavyGate();
  const found = spawnSync("docker", ["inspect", "--format", "{{.State.Running}}", container], { encoding: "utf8" });
  if (found.status === 0) {
    if (found.stdout.trim() !== "true") run("docker", ["start", container]);
  } else {
    run("docker", ["run", "-d", "--name", container, "--platform", "linux/amd64", "--memory", "3g",
      "-e", "ACCEPT_EULA=Y", "-e", "MSSQL_PID=Developer", "-e", `MSSQL_SA_PASSWORD=${password}`,
      "-p", "127.0.0.1:1433:1433", "-v", `${container}:/var/opt/mssql`, "mcr.microsoft.com/mssql/server:2022-latest"]);
  }
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt++) {
    const result = spawnSync("docker", ["exec", container, "/opt/mssql-tools18/bin/sqlcmd", "-S", "localhost", "-U", "sa", "-P", password, "-C", "-I", "-b", "-Q", `IF DB_ID('${database}') IS NULL CREATE DATABASE [${database}];`], { stdio: "ignore" });
    if (result.status === 0) { ready = true; break; }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  if (!ready) throw new Error("Local SQL did not become ready; no cloud fallback is allowed.");
  heavyGate();
  if (!process.argv.includes("--skip-build")) run("npm", ["run", "build"]);
  Object.assign(process.env, {
    LOCAL_SQL: "true", SQL_SERVER: "localhost", SQL_DATABASE: database,
    SQL_USERNAME: "sa", SQL_PASSWORD: password,
  });
  const db = require("../dist/db");
  const { runMigrations } = require("../dist/migrate");
  await runMigrations(db.createLocalConnection, console.log, { target: { server: "localhost", database, source: "local-review" } });
  const connection = await db.createLocalConnection();
  try {
    await db.executeBatch(connection, `
      IF NOT EXISTS (SELECT 1 FROM dbo.Buildings WHERE BuildingID=950001)
        INSERT INTO dbo.Buildings (BuildingID,BuildingName,BuildingCode,ReferenceCode,BuildingAddress,Region,Active)
        VALUES (950001,'Local review building','REV','REV','Synthetic review data','Local review',1);
      IF NOT EXISTS (SELECT 1 FROM dbo.Tenants WHERE BuildingId=950001 AND LegalName='Local review tenant')
        INSERT INTO dbo.Tenants (BuildingId,LegalName,TradingName,CreatedById,CreatedByName,UpdatedById,UpdatedByName)
        VALUES (950001,'Local review tenant','Local review tenant','local-review','Local review','local-review','Local review');
      IF NOT EXISTS (SELECT 1 FROM dbo.Keys WHERE KeyNumber='REVIEW-01')
        INSERT INTO dbo.Keys (BuildingId,Level,KeyNumber,Description,StorageLocation)
        SELECT BuildingID,'Ground','REVIEW-01','Local review sample key','Review key cabinet' FROM dbo.Buildings WHERE BuildingID=950001;
    `);
    const inspectionSeed = fs.readFileSync(path.join(root, "migrations/seeding/086_seed_inspections.sql"), "utf8");
    for (const batch of inspectionSeed.split(/^\s*GO\s*$/mi).filter(value => value.trim())) await db.executeBatch(connection, batch);
    const { loadSeedEntries, runSeed } = require("../dist/proceduresSeed");
    // Local preloaded procedures start awaiting a real endorsement (decisions 24/26).
    const entries = loadSeedEntries().map(entry => ({ ...entry, approvedBy: undefined, approvedOn: undefined, status: "draft" }));
    const report = await runSeed(connection, entries, { apply: true, log: console.log });
    if (report.failed) throw new Error("Procedure seed failed.");
    const { TYPES } = require("tedious");
    const features = ["activity", "assets", "decisionJobs", "escalations", "finance", "incoming", "inspections", "jobs", "keys", "maintenance", "payroll", "procedures", "quotes", "rentReviews", "tenancySchedule", "tenancyVacancies", "timesheets"];
    const roles = Object.values(require("../dist/auth").AppRole);
    await db.executeQuery(connection, `MERGE dbo.FeatureFlags AS t
      USING (SELECT f.[value] AS FeatureKey, r.[value] AS RoleName FROM OPENJSON(@Features) f CROSS JOIN OPENJSON(@Roles) r) s
      ON t.FeatureKey=s.FeatureKey AND t.RoleName=s.RoleName
      WHEN MATCHED THEN UPDATE SET Visibility='enabled', UpdatedBy='local-review', UpdatedAt=SYSUTCDATETIME()
      WHEN NOT MATCHED THEN INSERT (FeatureKey, RoleName, Visibility, UpdatedBy) VALUES (s.FeatureKey,s.RoleName,'enabled','local-review');`, [
      { name: "Features", type: TYPES.NVarChar, value: JSON.stringify(features) },
      { name: "Roles", type: TYPES.NVarChar, value: JSON.stringify(roles) },
    ]);
    const position = process.argv.indexOf("--email");
    const emails = position >= 0 ? [process.argv[position + 1]] : [];
    for (const email of emails) {
      if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Pass a valid --email for the local reviewer.");
      await db.executeQuery(connection, `IF NOT EXISTS (SELECT 1 FROM dbo.AppUsers WHERE Email=@Email AND IsActive=1)
        INSERT INTO dbo.AppUsers (DisplayName, Email, Role, InvitedAt) VALUES ('Local reviewer',@Email,'director',SYSUTCDATETIME());`, [
        { name: "Email", type: TYPES.NVarChar, value: email.toLowerCase() },
      ]);
    }
    console.log("Enabled all module flags in the local database; role permissions still apply.");
  } finally { connection.close(); }
  prepareRuntime();
  console.log("Next: local-review.cjs storage and local-review.cjs api in separate terminals, then the frontend npm run dev.");
}

async function main() {
  fs.mkdirSync(path.join(state, "logs"), { recursive: true, mode: 0o700 });
  if (command === "prepare") return prepare();
  if (command === "storage") return run("azurite", ["--silent", "--location", path.join(state, "storage"), "--blobHost", "127.0.0.1", "--queueHost", "127.0.0.1", "--tableHost", "127.0.0.1"]);
  if (command === "api") {
    if (!fs.existsSync(path.join(runtime, "local.settings.json"))) throw new Error("Run prepare first.");
    return run(path.join(root, "node_modules/.bin/func"), ["start", "--script-root", runtime, "--port", "7071"], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: "development", FUNCTIONS_CORE_TOOLS_TELEMETRY_OPTOUT: "1", DOTNET_CLI_TELEMETRY_OPTOUT: "1" },
    });
  }
  throw new Error("Usage: node scripts/local-review.cjs prepare [--email you@example.com] | storage | api");
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
