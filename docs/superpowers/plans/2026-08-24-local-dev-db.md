# Local Dev Database Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Git note (Will's workflow):** do NOT run `git add`/`git commit`/branch commands. Write/edit files only — Will stages and commits himself. Tasks therefore end at verification, not at a commit step.

**Goal:** Make the local Docker SQL database the default development target so day-to-day work never touches the Azure SQL production DB being handed over to RP.

**Architecture:** Nearly all the plumbing already exists — `docker-compose.yml` runs SQL Server 2022 (`azure-functions-sql-1`), `db.ts` switches to sa-auth via `LOCAL_SQL=true`, `runMigrations()` auto-applies `migrations/*.sql` on host start (recorded in `dbo.schema_migrations`), Azurite emulates blob storage, and the frontend's `.env.local` already points at `http://localhost:7071/api`. The plan flips the default to local, adds a one-command bootstrap/reset script, fills the data gap (myBuildings **stage** sync for buildings + work requests, existing seed 086 for inspections, a new seed 089 for keys), and adds a startup banner so it's always obvious which DB the host is talking to.

**Tech Stack:** Azure Functions v4 (Node/TypeScript), SQL Server 2022 in Docker, sqlcmd (mssql-tools18), Azurite, bash.

**Facts the executor must know (verified 24 Aug 2026):**
- `local.settings.json` is **gitignored** — Task 1 is a machine-local edit; the README (Task 5) is where it gets documented.
- `createLocalConnection()` (src/db.ts) reads `SQL_SERVER`, `SQL_DATABASE`, `SQL_USERNAME`, `SQL_PASSWORD`. The `_LOCAL_*` keys currently in `local.settings.json` are parked values, not read by code.
- Hand-run `sqlcmd` **requires `-I`** (QUOTED_IDENTIFIER ON): migration 009 creates a filtered index, and DML on `dbo.Keys` (filtered index `IX_Keys_Active`) fails without it. The full 001–088 chain has been verified to replay cleanly on a fresh DB with `-I`.
- `runMigrations()` reads only **top-level** `migrations/*.sql`, skips filenames containing `_seed_`, splits on `GO`, records applied files in `dbo.schema_migrations`. Files in `migrations/seeding/` are never auto-run.
- The func host **refuses to start without Azurite** (`AzureWebJobsStorage: UseDevelopmentStorage=true`).
- Local auth: `DEV_ROLE_OVERRIDE_ENABLED=true` + non-Production environment enables the dev bypass; README documents that local curls need no AAD token. If a sync curl returns 401/403, add `-H "X-Dev-Roles: admin"`.
- Buildings and work requests come from the myBuildings **stage** API already configured in `local.settings.json` (`POST /api/syncBuildings`, `POST /api/syncAllWorkRequests`).
- Seed convention (from `migrations/seeding/086_seed_inspections.sql`): filename contains `_seed_`, lives in `migrations/seeding/`, guarded on a stable tag (`CreatedById = 'seed:0NN'`), idempotent, header documents the cleanup DELETE.

---

### Task 1: Flip `local.settings.json` to local SQL by default

**Files:**
- Modify: `local.settings.json` (repo root — gitignored, machine-local)

- [ ] **Step 1: Swap the SQL values**

In the `Values` object, change/add these keys (the `_AZURE_*` keys park the production values for the rare deliberate flip back):

```jsonc
"LOCAL_SQL": "true",
"SQL_SERVER": "localhost",
"SQL_DATABASE": "command_centre_dev",
"SQL_USERNAME": "sa",
"SQL_PASSWORD": "DevPassword123!",
"_AZURE_SQL_SERVER": "rp-cc-sql-server.database.windows.net",
"_AZURE_SQL_DATABASE": "free-sql-db-4148991",
```

Remove the now-redundant `_LOCAL_SQL_SERVER`, `_LOCAL_SQL_DATABASE`, `_LOCAL_SQL_USERNAME`, `_LOCAL_SQL_PASSWORD` keys.

- [ ] **Step 2: Verify the host boots against Docker**

Prerequisites: Azurite running (`azurite --silent --location ~/.azurite`), SQL container up (`docker compose up -d`), DB exists (Task 2's script does this; until then: `docker exec azure-functions-sql-1 /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "DevPassword123!" -No -Q "IF DB_ID('command_centre_dev') IS NULL CREATE DATABASE command_centre_dev"`).

Run: `npm run build && npm start`
Expected startup log: `startup: running migrations` … `migrate: all migrations up to date` (first run applies 001–088; later runs log `migrate: skip` lines).

Run: `curl -sf http://localhost:7071/api/health`
Expected: HTTP 200.

---

### Task 2: One-command bootstrap/reset script

**Files:**
- Create: `scripts/dev-db.sh` (azure-functions repo root — the repo has no `scripts/` dir yet; create it)

- [ ] **Step 1: Write the script**

```bash
#!/usr/bin/env bash
#
# Local dev DB helper. SQL Server 2022 runs in Docker (container
# azure-functions-sql-1, compose service `sql`, volume sql-data).
#
#   ./scripts/dev-db.sh up       start container, create DB, apply migrations
#   ./scripts/dev-db.sh migrate  apply pending migrations (recorded in schema_migrations)
#   ./scripts/dev-db.sh seed     run migrations/seeding/*_seed_*.sql (idempotent)
#   ./scripts/dev-db.sh sync     pull buildings + work requests from myBuildings stage
#                                (func host must be running: npm start)
#   ./scripts/dev-db.sh reset    DROP and recreate the DB, then migrate (asks first;
#                                seed after the first sync — seeds need Buildings)
#
# sqlcmd runs with -I (QUOTED_IDENTIFIER ON) — REQUIRED: the schema has
# filtered indexes (e.g. IX_Keys_Active) and both DDL and DML fail without it.

set -euo pipefail
cd "$(dirname "$0")/.."

CONTAINER=azure-functions-sql-1
SA_PASSWORD='DevPassword123!'
DB=command_centre_dev
FUNC_URL="${FUNC_URL:-http://localhost:7071/api}"

run_sql() {
  docker exec -i "$CONTAINER" /opt/mssql-tools18/bin/sqlcmd \
    -S localhost -U sa -P "$SA_PASSWORD" -No -I -b "$@"
}

wait_ready() {
  for _ in $(seq 1 30); do
    run_sql -Q "SELECT 1" >/dev/null 2>&1 && return 0
    sleep 2
  done
  echo "SQL Server did not become ready" >&2
  exit 1
}

ensure_db() {
  run_sql -Q "IF DB_ID('$DB') IS NULL CREATE DATABASE [$DB];"
}

# Applies pending top-level migrations and records them in schema_migrations,
# mirroring src/migrate.ts (which skips *_seed_* the same way). The func host's
# own runner then has nothing left to do at startup.
apply_migrations() {
  run_sql -d "$DB" -Q "IF OBJECT_ID('dbo.schema_migrations') IS NULL
    CREATE TABLE dbo.schema_migrations (
      migration_name NVARCHAR(255) NOT NULL PRIMARY KEY,
      applied_at     DATETIME2     NOT NULL DEFAULT GETUTCDATE()
    );"
  for f in $(ls migrations/*.sql | sort); do
    base=$(basename "$f")
    case "$base" in *_seed_*) continue ;; esac
    applied=$(run_sql -d "$DB" -h -1 -W -Q \
      "SET NOCOUNT ON; SELECT COUNT(*) FROM dbo.schema_migrations WHERE migration_name = '$base';" \
      | tr -d '[:space:]')
    if [ "$applied" = "1" ]; then
      echo "skip   $base"
      continue
    fi
    echo "apply  $base"
    run_sql -d "$DB" -i /dev/stdin < "$f" >/dev/null
    run_sql -d "$DB" -Q "INSERT INTO dbo.schema_migrations (migration_name) VALUES ('$base');"
  done
  echo "migrations up to date"
}

run_seeds() {
  for f in $(ls migrations/seeding/*_seed_*.sql 2>/dev/null | sort); do
    echo "seed   $(basename "$f")"
    run_sql -d "$DB" -i /dev/stdin < "$f"
  done
}

case "${1:-}" in
  up)
    docker compose up -d
    wait_ready
    ensure_db
    apply_migrations
    ;;
  migrate)
    wait_ready
    ensure_db
    apply_migrations
    ;;
  seed)
    wait_ready
    run_seeds
    ;;
  sync)
    # Buildings must sync before work requests (WRs join onto buildings).
    # If these return 401/403 add: -H "X-Dev-Roles: admin"
    curl -sf -X POST "$FUNC_URL/syncBuildings" && echo " — buildings synced"
    curl -sf -X POST "$FUNC_URL/syncAllWorkRequests" --max-time 600 && echo " — work requests synced"
    ;;
  reset)
    printf 'Drop and recreate %s? ALL local data is lost. [y/N] ' "$DB"
    read -r answer
    [ "$answer" = "y" ] || { echo "aborted"; exit 1; }
    docker compose up -d
    wait_ready
    run_sql -Q "IF DB_ID('$DB') IS NOT NULL BEGIN
      ALTER DATABASE [$DB] SET SINGLE_USER WITH ROLLBACK IMMEDIATE;
      DROP DATABASE [$DB];
    END"
    ensure_db
    apply_migrations
    # Seeds are NOT run here — both seed scripts need Buildings rows, which
    # only exist after a sync (and sync needs the func host running).
    echo "reset complete — next: npm start, then './scripts/dev-db.sh sync', then './scripts/dev-db.sh seed'"
    ;;
  *)
    echo "Usage: $0 <up|migrate|seed|sync|reset>" >&2
    exit 1
    ;;
esac
```

- [ ] **Step 2: Make it executable**

Run: `chmod +x scripts/dev-db.sh`

- [ ] **Step 3: Verify `up` on a cold start**

Run: `docker compose down && ./scripts/dev-db.sh up`
Expected: container starts, then one `apply <file>` line per pending migration (or all `skip` lines on an already-migrated volume), ending `migrations up to date`.

- [ ] **Step 4: Verify idempotency**

Run: `./scripts/dev-db.sh migrate`
Expected: every line reads `skip <file>`, ending `migrations up to date`.

- [ ] **Step 5: Verify host startup is now instant on migrations**

Run: `npm start` (with Azurite running)
Expected log: `migrate: skip` for every file — the script's `schema_migrations` rows are honoured by `src/migrate.ts`.

---

### Task 3: Keys seed (`089_seed_keys.sql`)

Inspections already have seed 086; keys have nothing. This seed gives the Keys screens a realistic register plus checkout history: 7 live keys/codes across two buildings, one lost, one soft-deleted, one overdue checkout batch, one fully-returned batch.

**Files:**
- Create: `migrations/seeding/089_seed_keys.sql`

- [ ] **Step 1: Write the seed**

```sql
-- 089_seed_keys.sql
-- Seed keys + checkout history for local dev, so the Keys screens have data.
--
-- Requires Buildings rows (run ./scripts/dev-db.sh sync first — buildings come
-- from the myBuildings stage API). Fails loudly if none exist.
--
-- Photo blob names are placeholders — the blobs don't exist in Azurite, so
-- photos 404 in the UI. Fine for dev; upload real photos through the app to
-- exercise the blob path.
--
-- Seed file — the migration runner skips "_seed_" filenames. Run via:
--   ./scripts/dev-db.sh seed
--
-- Idempotent: guarded on the seed tag (CreatedById = 'seed:089'). Cleanup:
--   DELETE co FROM dbo.KeyCheckouts co
--     JOIN dbo.Keys k ON k.Id = co.KeyId WHERE k.CreatedById = 'seed:089';
--   DELETE FROM dbo.KeyCheckoutBatches WHERE Notes LIKE 'Seed 089:%';
--   DELETE FROM dbo.Keys WHERE CreatedById = 'seed:089';

IF NOT EXISTS (SELECT 1 FROM dbo.Keys WHERE CreatedById = 'seed:089')
BEGIN
  DECLARE @b1 INT = (SELECT TOP 1 BuildingID FROM dbo.Buildings WHERE Active = 1 ORDER BY NEWID());
  DECLARE @b2 INT = (SELECT TOP 1 BuildingID FROM dbo.Buildings WHERE Active = 1 AND BuildingID <> @b1 ORDER BY NEWID());

  IF @b1 IS NULL
  BEGIN
    RAISERROR('089_seed_keys: no active Buildings — run ./scripts/dev-db.sh sync first', 16, 1);
    RETURN;
  END
  SET @b2 = COALESCE(@b2, @b1);

  -- SubType/StorageLocation values mirror the allowlists in src/functions/keys.ts
  INSERT INTO dbo.Keys
    (BuildingId, Level, KeyNumber, ItemType, SubType, Registration, Description,
     StorageLocation, Status, CreatedById, CreatedByName)
  VALUES
    (@b1, 'G',  'SEED-K1', 'key',  'Normal',     'standard',   'Front entry master',
     'Randazzo Properties Office', 'active', 'seed:089', 'Seed Data'),
    (@b1, 'G',  'SEED-K2', 'key',  'BiLock',     'registered', 'Fire panel cabinet',
     'Randazzo Properties Office', 'active', 'seed:089', 'Seed Data'),
    (@b1, 'L1', 'SEED-K3', 'key',  'Cylinder',   'standard',   'Plant room',
     '9 Cavanagh (Plant Room)',    'active', 'seed:089', 'Seed Data'),
    (@b1, 'B1', 'SEED-K4', 'key',  'Padlock',    'standard',   'Bike cage padlock',
     'Randazzo Properties Office', 'lost',   'seed:089', 'Seed Data'),
    (@b2, 'G',  'SEED-K5', 'key',  'Fob (RFID)', 'standard',   'After-hours access fob',
     'Randazzo Properties Office', 'active', 'seed:089', 'Seed Data'),
    (@b2, 'G',  'SEED-C1', 'code', NULL,         'standard',   'Alarm code — main panel',
     NULL,                         'active', 'seed:089', 'Seed Data'),
    (@b2, 'L2', 'SEED-C2', 'code', NULL,         'standard',   'Roof access lockbox code',
     NULL,                         'active', 'seed:089', 'Seed Data');

  -- One soft-deleted key, so the IsDeleted = 0 filters get exercised.
  INSERT INTO dbo.Keys
    (BuildingId, Level, KeyNumber, ItemType, Registration, Description, Status,
     CreatedById, CreatedByName, IsDeleted, DeletedAt, DeletedById, DeletedByName)
  VALUES
    (@b1, 'G', 'SEED-K9', 'key', 'standard', 'Old cleaner key (deleted)', 'retired',
     'seed:089', 'Seed Data', 1, SYSUTCDATETIME(), 'seed:089', 'Seed Data');

  -- Batch 1: outstanding and OVERDUE (expected back yesterday).
  INSERT INTO dbo.KeyCheckoutBatches
    (CheckedOutBy, CheckedOutTo, CheckedOutAt, ExpectedReturnAt, CheckOutPhotoBlobUrl, Notes)
  VALUES
    ('Seed Data', 'Apex Electrical', DATEADD(day, -3, SYSUTCDATETIME()),
     DATEADD(day, -1, SYSUTCDATETIME()), 'keys/seed-089-out-1.jpg', 'Seed 089: overdue batch');
  DECLARE @batch1 INT = SCOPE_IDENTITY();

  INSERT INTO dbo.KeyCheckouts (BatchId, KeyId)
  SELECT @batch1, Id FROM dbo.Keys
   WHERE CreatedById = 'seed:089' AND KeyNumber IN ('SEED-K1', 'SEED-K3');

  -- Batch 2: fully returned.
  INSERT INTO dbo.KeyCheckoutBatches
    (CheckedOutBy, CheckedOutTo, CheckedOutAt, ExpectedReturnAt, CheckOutPhotoBlobUrl, Notes)
  VALUES
    ('Seed Data', 'HVAC Solutions', DATEADD(day, -10, SYSUTCDATETIME()),
     DATEADD(day, -9, SYSUTCDATETIME()), 'keys/seed-089-out-2.jpg', 'Seed 089: returned batch');
  DECLARE @batch2 INT = SCOPE_IDENTITY();

  INSERT INTO dbo.KeyCheckouts (BatchId, KeyId, CheckedInAt, CheckInPhotoBlobUrl)
  SELECT @batch2, Id, DATEADD(day, -9, SYSUTCDATETIME()), 'keys/seed-089-in-2.jpg'
    FROM dbo.Keys
   WHERE CreatedById = 'seed:089' AND KeyNumber = 'SEED-K5';
END
```

- [ ] **Step 2: Run it and verify counts**

Prerequisite: buildings synced (`./scripts/dev-db.sh sync` with the host running).

Run: `./scripts/dev-db.sh seed`
Then:
```bash
docker exec azure-functions-sql-1 /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P "DevPassword123!" -No -I -d command_centre_dev -W -Q \
  "SELECT (SELECT COUNT(*) FROM dbo.Keys WHERE CreatedById='seed:089') AS SeedKeys,
          (SELECT COUNT(*) FROM dbo.KeyCheckoutBatches WHERE Notes LIKE 'Seed 089:%') AS Batches,
          (SELECT COUNT(*) FROM dbo.KeyCheckouts co JOIN dbo.Keys k ON k.Id=co.KeyId
            WHERE k.CreatedById='seed:089') AS Checkouts;"
```
Expected: `SeedKeys 8`, `Batches 2`, `Checkouts 3`.

- [ ] **Step 3: Verify idempotency**

Run: `./scripts/dev-db.sh seed` again, re-run the count query.
Expected: identical counts (guard short-circuits).

- [ ] **Step 4: Verify in the API**

With the host running: `curl -sf http://localhost:7071/api/getKeys | head -c 600` (add `-H "X-Dev-Roles: admin"` if 401/403).
Expected: JSON containing `SEED-K1`; the soft-deleted `SEED-K9` absent.

---

### Task 4: Startup banner showing the SQL target

Makes "which database am I about to write to?" visible on every boot — the guardrail that matters once the Azure DB belongs to RP.

**Files:**
- Modify: `src/functions/startup.ts` (the `app.hook.appStart` block, currently at the bottom of the file)

- [ ] **Step 1: Add the banner**

In the `appStart` hook, immediately after the two existing `const` lines (`isProduction`, `isLocalSql`), add:

```typescript
  const sqlTarget = `${process.env.SQL_SERVER}/${process.env.SQL_DATABASE}`;
  if (isLocalSql) {
    console.log(`startup: SQL target — local Docker (${sqlTarget})`);
  } else if (!isProduction) {
    console.warn(
      `startup: ⚠ SQL target is REMOTE (${sqlTarget}) from a non-production host — post-handover this should be the exception, not the default`,
    );
  }
```

(The surrounding block already carries an `eslint-disable no-console` for startup diagnostics, so no lint change is needed.)

- [ ] **Step 2: Verify locally**

Run: `npm run build && npm start`
Expected log line: `startup: SQL target — local Docker (localhost/command_centre_dev)`.

- [ ] **Step 3: Verify the warning path**

Temporarily set `"LOCAL_SQL": "false"` in `local.settings.json`, run `npm start`, confirm the `⚠ SQL target is REMOTE` warning appears (the host will then skip migrations — expected), then set it back to `"true"`.

- [ ] **Step 4: Run the checks**

Run: `npm test && npx tsc --noEmit && npm run lint`
Expected: all pass.

---

### Task 5: Rewrite the local-dev section of the README

**Files:**
- Modify: `README.md` (azure-functions — sections 4 "local DB" through 6 "build and run", currently around lines 50–95)

- [ ] **Step 1: Replace the DB setup + migrations steps**

Replace the manual `CREATE DATABASE` / manual sqlcmd migration instructions with the script flow. New content for those sections:

```markdown
### 4. Local database (default)

Development targets a local SQL Server 2022 container by default
(`LOCAL_SQL=true` in `local.settings.json`). The Azure SQL database belongs to
RP post-handover — pointing at it is the exception, done deliberately by
swapping in the parked `_AZURE_SQL_*` values and setting `LOCAL_SQL=false`.
The func host prints its SQL target on every boot; treat the ⚠ REMOTE warning
as a stop sign.

One command brings up the container, creates `command_centre_dev`, and applies
all migrations:

    ./scripts/dev-db.sh up

Other subcommands:

    ./scripts/dev-db.sh migrate   # apply pending migrations only
    ./scripts/dev-db.sh seed      # run migrations/seeding/*_seed_*.sql (idempotent)
    ./scripts/dev-db.sh sync      # buildings + work requests from myBuildings stage
                                  # (requires the func host running: npm start)
    ./scripts/dev-db.sh reset     # drop, recreate, migrate (asks first; seed after sync)

Typical first-time data fill: `up` → `npm start` → `sync` → `seed`.
The container persists data in the `sql-data` Docker volume; `docker compose
down -v` is the nuclear reset.

**sqlcmd gotcha:** any hand-run `sqlcmd` against this schema needs `-I`
(QUOTED_IDENTIFIER ON) — the schema has filtered indexes and both DDL and DML
fail without it. `scripts/dev-db.sh` passes it for you.
```

- [ ] **Step 2: Verify the documented flow end-to-end**

On the current machine, run exactly the documented sequence from a wiped volume:
`docker compose down -v && ./scripts/dev-db.sh up && npm start` (leave running) → `./scripts/dev-db.sh sync` → `./scripts/dev-db.sh seed`.
Expected: no step errors; `curl -sf http://localhost:7071/api/getKeys` and `/api/getInspections` return seeded data.

---

### Task 6: Verify the frontend against the local stack

No file changes expected — `.env.local` already has `NEXT_PUBLIC_USE_LIVE_API=true` and `NEXT_PUBLIC_AZURE_FUNCTIONS_URL=http://localhost:7071/api`.

**Files:**
- Verify only: `command-centre/.env.local`

- [ ] **Step 1: Confirm env values** — the two lines above are present and uncommented.

- [ ] **Step 2: Run the app**

In `command-centre`: `npm run dev`, sign in, and check:
- Buildings list shows myBuildings-stage buildings
- Keys screen shows the `SEED-K*` register, one overdue batch, no `SEED-K9`
- Inspections screen shows the six `seed:086` inspections
- Photos on seeded checkout batches 404 (placeholder blob names) — expected; a photo uploaded through the app displays fine (Azurite round-trip).

Expected: all four hold. If the app renders empty with the host up, check the browser console for CORS or 401s (the host CORS allowlist already covers `http://localhost:3000`).

---

## Execution order

Tasks 1 → 2 → 3 → 4 → 5 → 6. Task 3 needs Task 2's script and a `sync` run (buildings must exist). Tasks 4–6 are independent of each other but come after 1–2.

## Out of scope (deliberate YAGNI)

- **Jobs/tenancy/users seeds** — jobs and work requests come from the myBuildings stage sync; tenancy and app-user data can be entered through the app when a task needs it. Add seeds only when a concrete need appears.
- **Azurite in docker-compose** — the README's standalone-Azurite flow works; folding it into compose is cosmetic.
- **`local.settings.example.json`** — worth doing only if RP's developers take over this repo; revisit at handover.
- **The prod handover clear** — separate, already delivered: `migrations/seeding/handover_clear_keys_inspections.sql` + `_blobs.sh`.
