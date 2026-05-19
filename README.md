# RPCC Azure Functions

Azure Functions that sync building data from the myBuildings API into Azure SQL Database.

## Functions

### POST /api/syncBuildings
Fetches all buildings from the myBuildings API and upserts them into the Azure SQL `Buildings` table. Handles paging automatically (300 records per page).

### GET /api/getBuildings
Returns buildings from the database. Supports optional query parameters:
- `?buildingId=123` — filter by specific building ID
- `?region=NSW` — filter by region

## Setup

### 1. Prerequisites
- **Node.js 22** — check with `node --version`.
- **Azure Functions Core Tools v4** — already pinned as a devDependency, so `npm install` provides the local `func` binary at `node_modules/.bin/func`. The npm scripts in this repo (`npm start` etc.) resolve that local copy, so you do **not** need a global install. If you want `func` on your `PATH` for ad-hoc commands, install globally with `npm install -g azure-functions-core-tools@4 --unsafe-perm true`.
- **Azurite** (local Azure Storage emulator) — required because `local.settings.json` sets `AzureWebJobsStorage: "UseDevelopmentStorage=true"`. Without it the func host refuses to start. Install once and leave running in a separate terminal:
  ```bash
  npm install -g azurite
  azurite --silent --location ~/.azurite --debug ~/.azurite/debug.log
  ```
  (Alternatively run via VS Code's Azurite extension, or via Docker: `docker run -p 10000:10000 -p 10001:10001 -p 10002:10002 mcr.microsoft.com/azure-storage/azurite`.)
- **Azure CLI** — needed to acquire SQL tokens for local curl-testing (`az login`).
- **Extension bundles** — listed in `host.json` (`Microsoft.Azure.Functions.ExtensionBundle`, v4.x). These are downloaded automatically by the func host on the first run; **no manual install required**.
- **VS Code with Azure Functions extension** — optional but recommended for the in-IDE deploy flow.

### 2. Install dependencies
```bash
npm install
```

### 3. Configure local.settings.json
Update the values in `local.settings.json`:
- `MYBUILDINGS_API_URL` — the myBuildings base URL
- `MYBUILDINGS_BEARER_TOKEN` — your myBuildings API Bearer token
- `SQL_SERVER` — your Azure SQL server (e.g. `rpcc-server.database.windows.net`)
- `SQL_DATABASE` — your database name

Dev-only flags (already present in the checked-in `local.settings.json`; safe to leave on locally, never set in prod):
- `DEV_EMAIL_OVERRIDE` — when set, email handlers send to this address instead of the real recipient.
- `DEV_ROLE_OVERRIDE_ENABLED: "true"` — makes `rolesForRequest()` honour the `X-Dev-Roles` header sent by the frontend's DEV role switcher. Lets you exercise role-gated endpoints (e.g. director approval) without re-assigning Entra app roles. Logs a `[auth] DEV ROLE OVERRIDE active` warning to the func terminal whenever it takes effect.

### 4. Start the local SQL Server (Docker)

The local dev DB runs in Docker — no Azure SQL costs, no IP firewall rules, no AAD token required.

**Prerequisites:** [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running.

```bash
# Start (or restart) the SQL Server container
docker compose up -d

# First time only — create the dev database
docker exec -it azure-functions-sql-1 \
  /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P "DevPassword123!" -C \
  -Q "CREATE DATABASE command_centre_dev"
```

The container persists data in a named Docker volume (`sql-data`), so it survives restarts. To wipe and start fresh:

```bash
docker compose down -v   # removes the volume
docker compose up -d
```

The `local.settings.json` is already configured for Docker (`LOCAL_SQL=true`, `SQL_SERVER=localhost`). To switch back to Azure SQL temporarily, set `LOCAL_SQL=false` and restore the `SQL_SERVER` / `SQL_DATABASE` values.

### 5. Apply database migrations
The full schema (and any incremental changes) lives in `migrations/` as numbered `.sql` files. The function host applies them automatically on startup via `runMigrations()`. For a brand-new Docker DB, just start the app and all migrations will run.

To apply manually (e.g. to inspect state):
```bash
docker exec -it azure-functions-sql-1 \
  /opt/mssql-tools18/bin/sqlcmd \
  -S localhost -U sa -P "DevPassword123!" -No -d command_centre_dev \
  -i migrations/001_initial.sql
```

### 6. Build and run locally
```bash
npm run build
npm start
```

To test endpoints locally (Docker DB, no AAD token needed):
```bash
curl http://localhost:7071/api/getBuildings
curl -X POST http://localhost:7071/api/syncBuildings
```

### 7. Deploy to Azure
1. Run `npm run build`
2. In VS Code → Azure panel → right-click **rpcc-functions** → **Deploy to Function App...**

All functions deploy together as a single app. To add a new function, create a file in `src/functions/`, register it with `app.http()`, build, and redeploy.

### 8. Set environment variables in Azure
In Azure Portal → Function App → Configuration → Application settings. Add:
- `MYBUILDINGS_API_URL`
- `MYBUILDINGS_BEARER_TOKEN`
- `SQL_SERVER`
- `SQL_DATABASE`

These are NOT deployed from `local.settings.json` — that file is local only.

### 9. Enable Entra ID authentication (Easy Auth)
After deploying and confirming the functions work:

1. Azure Portal → Function App → **Authentication** → **Add identity provider** → **Microsoft**
2. **Workforce configuration** (current tenant)
3. **App registration type** → Pick existing → select **RP Command Centre**
4. **Client secret expiration** → pick the longest option (e.g. 24 months)
5. **Supported account types** → Current tenant - Single tenant
6. **Client application requirement** → Allow requests only from this application itself
7. **Restrict access** → Require authentication
8. **Unauthenticated requests** → HTTP 401 Unauthorized
9. **Token store** → enabled
10. Click **Add**

This protects all endpoints at the platform level — unauthenticated requests are rejected before your code runs. The `authLevel: "anonymous"` in code is correct; it means no function key is required (Entra ID handles auth instead).

> **Maintenance:** The client secret expires after the chosen period. When it does, auth stops working. Azure sends email warnings before expiry. To rotate: Azure Portal → App registrations → RP Command Centre → Certificates & secrets → generate new secret → update the Function App authentication settings.

## Notes
- **myBuildings staging** uses a self-signed SSL cert. For local dev, `NODE_TLS_REJECT_UNAUTHORIZED=0` is set in `local.settings.json`. Do NOT set this in production — only needed if the staging cert is still self-signed.
- **Tokens expire** after ~1 hour. If you get connection timeouts locally, get a fresh token with `az account get-access-token`.
- **Azure Functions Core Tools** is a devDependency — `npm start` resolves the local `func` binary from `node_modules/.bin/`. Use `npx func <cmd>` for ad-hoc commands rather than installing globally.
- **Azurite must be running** before `npm start`, otherwise the func host fails on `AzureWebJobsStorage` initialisation. See the Prerequisites for install + run commands.
- The Function App is on the **Consumption plan** (Linux). To upgrade to Flex Consumption (VNet, warm instances), you need a paid subscription and must create a new Function App and redeploy.

## How it works

1. React app authenticates user via MSAL (Entra ID)
2. React app acquires a token scoped to `https://database.windows.net/user_impersonation`
3. React app calls the Azure Function with that token in the Authorization header
4. Azure Function uses the user's token to connect to Azure SQL (permissions enforced per user)
5. For sync: Function also calls myBuildings API with the stored Bearer token to fetch data
6. Data is upserted into the Buildings table

## Auth flow

```
User → MSAL login → React App → Azure Function → Azure SQL (user's token)
                                       ↓
                              myBuildings API (static Bearer token)
```
