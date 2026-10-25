# Service Connection Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Git:** This repo's owner stages and commits. Do NOT run `git add` / `git commit` / `git checkout -b`. Commit steps below state the intended message; leave the staging to the user.

**Goal:** Stop authenticating per-request SQL connections as the signed-in user, so no human ever needs an Azure SQL database principal again.

**Architecture:** Every HTTP handler currently calls `createConnection(token)` with the caller's Entra SQL token, which requires each user to exist as a contained database user. That identity does no authorisation work — there is no row-level security, no `SESSION_CONTEXT`, no `SUSER_NAME()` filtering anywhere, and SQL auditing is `Disabled` — so it is a pure liability. We introduce `createRequestConnection()` in `src/db.ts`, which authenticates as the app's existing service principal (`RP Command Centre`) while returning a **fresh** connection per request, preserving today's concurrency semantics exactly. Authorisation stays where it already lives: `requireRole` against `dbo.AppUsers`. An env flag restores the old behaviour for instant rollback.

**Tech Stack:** Azure Functions v4 (Node/TypeScript), `tedious` 18.6.2, Azure SQL Basic tier, Jest.

---

## Why this is needed

Directors Carlo and Paolo could sign in but every screen returned 500. Login worked because `registerSelf` and the role lookup use `createServiceConnection()`; every data read failed because it used the caller's identity, and neither director had a database principal. `sys.database_principals` contains exactly one human (`connor@randazzo.properties`) plus two service principals.

**Why it was built this way originally:** `createConnection(token)` was in the first commit (`2490b42`, 18 Apr 2026) — it is Microsoft's documented "connect on behalf of the user" pattern, and it is genuinely good practice *when paired with per-user grants or RLS*. That half was never built. `createServiceConnection` arrived five days later (`a5e1ba2`, 23 Apr 2026) not as a design decision but out of necessity: that commit added timers and webhooks (`timesheetSyncTimer.ts`, `graphWebhook.ts`, `parseEmails.ts`, `migrate.ts`) which have no user token. It was then adopted opportunistically for role lookups and `registerSelf`. Nobody revisited whether the per-user connection still earned its keep once the grants turned out to be uniform for everyone.

**Scope:** 169 `createConnection(token)` call sites across 29 files in `src/functions/`.

---

## Task 0: Verify the service principal can do the work (BLOCKER)

The whole migration rests on `RP Command Centre` already holding read/write on every table. It currently only touches `AppUsers`, `FeatureFlags` and the timer tables. If it lacks broader grants, flipping the flag breaks **everything**.

**Files:** none — this is a manual check against the database.

- [ ] **Step 1: Check the service principal's role memberships**

Connect to `free-sql-db-4148991` (not `master`) as `connor@randazzo.properties` and run:

```sql
SELECT p.name AS principal, r.name AS role_membership
FROM sys.database_role_members m
JOIN sys.database_principals r ON r.principal_id = m.role_principal_id
JOIN sys.database_principals p ON p.principal_id = m.member_principal_id
WHERE p.name = 'RP Command Centre';
```

Expected: rows for `db_datareader` AND `db_datawriter`.

- [ ] **Step 2: If either is missing, grant it**

```sql
ALTER ROLE db_datareader ADD MEMBER [RP Command Centre];
ALTER ROLE db_datawriter ADD MEMBER [RP Command Centre];
```

- [ ] **Step 3: Confirm there are no object-level DENYs that would bite**

```sql
SELECT pr.name, pe.permission_name, pe.state_desc, OBJECT_NAME(pe.major_id) AS object_name
FROM sys.database_permissions pe
JOIN sys.database_principals pr ON pr.principal_id = pe.grantee_principal_id
WHERE pr.name = 'RP Command Centre' AND pe.state_desc = 'DENY';
```

Expected: zero rows. **Do not proceed past this task until Steps 1–3 pass.**

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/db.ts` | Modify | Add `requestTokenSource()`, `requestConnectionToken()`, `createRequestConnection()`, `clearServiceTokenCache()`. Keeps `createConnection` and `getServiceToken` as private/low-level primitives |
| `src/db.test.ts` | Create | Unit tests for token-source selection |
| `src/functions/payments.ts` | Modify | Drop the `SYSTEM_DB_TOKEN` path; webhook uses the service connection |
| `src/myob-auth.ts` | Modify | Route its token branch through `createRequestConnection` |
| `src/functions/*.ts` (28 handlers) | Modify | `createConnection(token)` → `createRequestConnection(token)` |
| `src/functions/*.test.ts` (9), `src/__tests__/*.test.ts` (2) | Modify | Rename the mocked `createConnection` key so the `../db` mocks still satisfy handlers |
| `src/__tests__/no-user-connection.test.ts` | Create | Regression guard — no handler may reopen a user-scoped connection |
| `docs/db-access.md` | Create | Records the decision and the onboarding consequence |

**Counts for verification:** 169 `createConnection(token)` call sites across 29 non-test handler files (200 bare `createConnection` occurrences including imports), plus 1 `createConnection(systemToken)` in `payments.ts` and 1 `createConnection(sqlToken)` in `myob-auth.ts`, plus 11 test files mocking the name.

---

## Task 1: Token-source selection in `src/db.ts`

**Files:**
- Modify: `src/db.ts:60-107`
- Test: `src/db.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `src/db.test.ts`:

```ts
/// <reference types="jest" />
import {
  clearServiceTokenCache,
  requestConnectionToken,
  requestTokenSource,
} from "./db";

function mockTokenResponse(accessToken: string): void {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ access_token: accessToken, expires_in: 3600 }),
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  jest.clearAllMocks();
  clearServiceTokenCache();
  delete process.env.SQL_USER_CONNECTION;
  process.env.GRAPH_TENANT_ID = "tenant";
  process.env.GRAPH_CLIENT_ID = "client";
  process.env.GRAPH_CLIENT_SECRET = "secret";
});

describe("requestTokenSource", () => {
  it("defaults to the service identity", () => {
    expect(requestTokenSource()).toBe("service");
  });

  it("returns 'user' only when SQL_USER_CONNECTION is exactly 'true'", () => {
    process.env.SQL_USER_CONNECTION = "true";
    expect(requestTokenSource()).toBe("user");
  });

  it("ignores other truthy-looking values", () => {
    process.env.SQL_USER_CONNECTION = "1";
    expect(requestTokenSource()).toBe("service");
  });
});

describe("requestConnectionToken", () => {
  it("returns the service token, not the caller's, by default", async () => {
    mockTokenResponse("service-token");
    await expect(requestConnectionToken("caller-token")).resolves.toBe(
      "service-token",
    );
  });

  it("returns the caller's token when the rollback flag is set", async () => {
    process.env.SQL_USER_CONNECTION = "true";
    await expect(requestConnectionToken("caller-token")).resolves.toBe(
      "caller-token",
    );
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("caches the service token across calls", async () => {
    mockTokenResponse("service-token");
    await requestConnectionToken("caller-token");
    await requestConnectionToken("caller-token");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd /Users/willmcdonald/Documents/azure-functions && npx jest src/db.test.ts
```

Expected: FAIL — `requestTokenSource`, `requestConnectionToken` and `clearServiceTokenCache` are not exported from `./db`.

- [ ] **Step 3: Implement**

In `src/db.ts`, add the cache-clear helper directly beneath the `cachedServiceToken` declaration (line 66). `getServiceToken` stays **private** — `requestConnectionToken` calls it from within the same module, and nothing outside `db.ts` needs it:

```ts
let cachedServiceToken: { value: string; expiresAt: number } | null = null;
const TOKEN_REFRESH_SKEW_MS = 60_000;

/** Test-only: drop the cached service token so cases don't bleed together.
 *  Mirrors clearRoleCache() in auth.ts. */
export function clearServiceTokenCache(): void {
  cachedServiceToken = null;
}

async function getServiceToken(): Promise<string> {
```

Then add this block immediately after `getServiceToken`'s closing brace (currently line 107):

```ts
export type ConnectionTokenSource = "service" | "user";

/**
 * Which identity a per-request handler connection authenticates as.
 *
 * Service by default. SQL_USER_CONNECTION=true restores the legacy per-caller
 * identity, which requires every user to have a contained database principal —
 * kept only as a rollback lever.
 */
export function requestTokenSource(): ConnectionTokenSource {
  return process.env.SQL_USER_CONNECTION === "true" ? "user" : "service";
}

export function requestConnectionToken(userToken: string): Promise<string> {
  return requestTokenSource() === "user"
    ? Promise.resolve(userToken)
    : getServiceToken();
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd /Users/willmcdonald/Documents/azure-functions && npx jest src/db.test.ts
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Typecheck**

```bash
cd /Users/willmcdonald/Documents/azure-functions && npm run typecheck
```

Expected: no output (clean).

- [ ] **Step 6: Commit** — user stages. Message:

```
feat(db): add service/user token source selection for request connections
```

---

## Task 2: `createRequestConnection()`

**Files:**
- Modify: `src/db.ts` (immediately after `createConnection`, currently ending line 210)

- [ ] **Step 1: Implement**

Add after `createConnection`:

```ts
/**
 * Per-request connection for HTTP handler data access.
 *
 * Authenticates as the app's service principal, NOT the caller. Authorisation
 * is enforced by requireRole against dbo.AppUsers — never by SQL grants, which
 * are uniform for every caller (no RLS, no SESSION_CONTEXT, no SUSER_NAME()
 * filtering anywhere in this repo, and server auditing is off). Connecting as
 * the caller bought nothing and meant every new user needed a database
 * principal created by hand, which silently 500'd the whole app when missed.
 *
 * Returns a FRESH connection, never the createServiceConnection() singleton:
 * a tedious Connection cannot serve concurrent Requests, and handler traffic is
 * concurrent. This keeps today's one-connection-per-request semantics exactly.
 *
 * `userToken` is used only when SQL_USER_CONNECTION=true (rollback path).
 */
export async function createRequestConnection(userToken: string): Promise<Connection> {
  if (IS_LOCAL_SQL) return createLocalConnection();
  return createConnection(await requestConnectionToken(userToken));
}
```

- [ ] **Step 2: Verify `closeConnection` needs no change**

Read `src/db.ts` `closeConnection`. It closes anything that is not `_serviceConn`. Because `createRequestConnection` returns a fresh connection, handlers' existing `finally { if (connection) closeConnection(connection); }` blocks keep closing correctly. No change required — confirm by reading, do not edit.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/willmcdonald/Documents/azure-functions && npm run typecheck
```

Expected: no output.

- [ ] **Step 4: Commit** — user stages. Message:

```
feat(db): add createRequestConnection for service-authenticated handler access
```

---

## Task 3: Canary migration — `getBuildings.ts`

One low-risk, heavily-used, read-only endpoint first. Proves the pattern before touching 168 other sites.

**Files:**
- Modify: `src/functions/getBuildings.ts:2` and `:63`

- [ ] **Step 1: Update the import**

`src/functions/getBuildings.ts` line 2, from:

```ts
import { createConnection, executeQuery, closeConnection, SqlRow } from "../db";
```

to:

```ts
import { createRequestConnection, executeQuery, closeConnection, SqlRow } from "../db";
```

- [ ] **Step 2: Update the call site**

Line 63, from:

```ts
    connection = await createConnection(token);
```

to:

```ts
    connection = await createRequestConnection(token);
```

- [ ] **Step 3: Typecheck and run the full suite**

```bash
cd /Users/willmcdonald/Documents/azure-functions && npm run typecheck && npm test
```

Expected: typecheck clean; Jest suite passes with the same count as before this plan started.

- [ ] **Step 4: Commit** — user stages. Message:

```
refactor(getBuildings): use service-authenticated request connection
```

---

## Task 4: Two non-standard call sites

Everything else passes the literal identifier `token`. These two don't, and a blanket rename would leave both subtly wrong. Do them **before** Task 5.

**Files:**
- Modify: `src/functions/payments.ts:358-369`
- Modify: `src/myob-auth.ts:34`

- [ ] **Step 1: Fix `payments.ts` — the `SYSTEM_DB_TOKEN` dead end**

`myobWebhook` has no caller, so it reads a long-lived SQL token out of an app setting and **silently skips all DB work when it is unset**. Its own comment asks for exactly what this migration provides. Replace lines 358-369:

```ts
    // Use a system token for the DB connection (webhook has no user token).
    // If your DB requires user-level tokens, adapt this to use a service account.
    const systemToken = process.env.SYSTEM_DB_TOKEN ?? "";
    if (!systemToken) {
      context.warn("myobWebhook: no SYSTEM_DB_TOKEN configured — skipping DB update");
      return { status: 200, jsonBody: { processed: 0, note: "no system token" } };
    }

    let connection;
    let processed = 0;
    try {
      connection = await createConnection(systemToken);
```

with:

```ts
    let connection;
    let processed = 0;
    try {
      // Webhook has no caller identity — use the app's own service principal.
      connection = await createServiceConnection();
```

Then update the import at the top of `src/functions/payments.ts` to include `createServiceConnection` alongside the existing `../db` imports.

- [ ] **Step 2: Fix `src/myob-auth.ts:34`**

From:

```ts
  return sqlToken ? createConnection(sqlToken) : createServiceConnection();
```

to:

```ts
  return sqlToken ? createRequestConnection(sqlToken) : createServiceConnection();
```

and update its import on line 23 from `createConnection,` to `createRequestConnection,`.

- [ ] **Step 3: Retire the obsolete app setting**

```bash
az functionapp config appsettings delete \
  --name rpcc-api2 --resource-group rp-floorplan-rg \
  --setting-names SYSTEM_DB_TOKEN
```

- [ ] **Step 4: Typecheck**

```bash
cd /Users/willmcdonald/Documents/azure-functions && npm run typecheck
```

Expected: no output.

- [ ] **Step 5: Commit** — user stages. Message:

```
refactor(payments,myob): use service identity for uncredentialed DB access
```

---

## Task 5: Codemod the remaining handlers and their test mocks

A plain word replacement is safe here: `createServiceConnection`, `createLocalConnection` and `createRequestConnection` do **not** contain the substring `createConnection`, so nothing else is touched and re-running is idempotent.

**Do not use `\b` in `sed`** — macOS ships BSD sed, which does not support it. (Verified: `echo "createConnection," | sed 's/\bcreateConnection\b/X/'` prints the input unchanged.) The plain substring form below is what works.

`src/db.ts` is excluded — it defines `createConnection` and still uses it for the service singleton.

**Files:**
- Modify: 28 remaining files under `src/functions/` (handlers)
- Modify: 9 test files under `src/functions/` and 2 under `src/__tests__/` that mock `createConnection`

- [ ] **Step 1: Run the codemod across handlers AND tests**

The test files mock `../db` with a `createConnection: jest.fn()` key. Once handlers call `createRequestConnection`, those mocks no longer supply it and the suite fails with `createRequestConnection is not a function` — so they must be renamed in the same pass.

```bash
cd /Users/willmcdonald/Documents/azure-functions
find src/functions src/__tests__ -name '*.ts' -print0 \
  | xargs -0 sed -i '' 's/createConnection/createRequestConnection/g'
```

- [ ] **Step 2: Verify the rename is complete and `db.ts` is untouched**

```bash
cd /Users/willmcdonald/Documents/azure-functions
echo "leftover createConnection in handlers/tests: $(grep -rlo 'createConnection' src/functions src/__tests__ 2>/dev/null | wc -l)"
echo "db.ts still defines createConnection: $(grep -c 'export function createConnection' src/db.ts)"
```

Expected: `leftover ... : 0` and `db.ts still defines createConnection: 1`.

- [ ] **Step 3: Typecheck — this is the real verification**

```bash
cd /Users/willmcdonald/Documents/azure-functions && npm run typecheck
```

Expected: no output. A missed or mangled import surfaces here as `Cannot find name 'createRequestConnection'` or `has no exported member 'createRequestConnection'`. Fix each by hand and re-run until clean. `strict` is on but `noUnusedLocals` is not set, so handlers where `token` now feeds only the `if (!token) return unauthorizedResponse()` guard still compile.

- [ ] **Step 4: Lint and run the full suite**

```bash
cd /Users/willmcdonald/Documents/azure-functions && npm run lint && npm test
```

Expected: both clean, with the same test count as before this plan started. If any test fails on a missing mock key, add `createRequestConnection` to that file's `jest.mock("../db", ...)` factory.

- [ ] **Step 5: Review the diff by hand before committing**

```bash
cd /Users/willmcdonald/Documents/azure-functions && git diff --stat src/
```

Spot-check `src/functions/parseEmails.ts` (helpers that take `token: string` as a parameter) and `src/functions/graphWebhook.ts:134` (admin handler `setupGraphSubscription`) — both verified to carry genuine caller tokens, but they are the two with the least obvious plumbing.

- [ ] **Step 6: Commit** — user stages. Message:

```
refactor: route all handler DB access through createRequestConnection
```

---

## Task 6: Regression guard

Stops a future handler silently reintroducing a user-scoped connection and recreating this outage.

**Files:**
- Create: `src/__tests__/no-user-connection.test.ts`

- [ ] **Step 1: Write the test**

```ts
/// <reference types="jest" />
import { readdirSync, readFileSync } from "fs";
import { join } from "path";

// Handlers must not connect to SQL as the caller. Authorisation lives in
// requireRole against dbo.AppUsers; SQL grants are uniform for every user, so
// a per-caller connection buys nothing and means each new user needs a database
// principal created by hand — which 500s the entire app when missed.
// Use createRequestConnection(token) instead. See docs/db-access.md.
describe("handlers never open a user-scoped SQL connection", () => {
  const dir = join(__dirname, "..", "functions");
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );

  it("finds handler files to check", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  // Matches createConnection(anything) but NOT createRequestConnection(...)
  // or createServiceConnection(...) — the leading boundary is what excludes
  // them, since neither contains the substring "createConnection".
  it.each(files)("%s does not call createConnection() directly", (file) => {
    const text = readFileSync(join(dir, file), "utf8");
    expect(text).not.toMatch(/(?<![A-Za-z])createConnection\s*\(/);
  });
});
```

- [ ] **Step 2: Run it**

```bash
cd /Users/willmcdonald/Documents/azure-functions && npx jest src/__tests__/no-user-connection.test.ts
```

Expected: PASS. (It fails if Task 5 left anything behind — that is the point.)

- [ ] **Step 3: Commit** — user stages. Message:

```
test: guard against reintroducing user-scoped SQL connections
```

---

## Task 7: Deploy behind the rollback flag, then flip

Deploy with the **old** behaviour active so the deploy itself is proven inert, then flip one app setting.

- [ ] **Step 1: Set the rollback flag BEFORE deploying**

```bash
az functionapp config appsettings set \
  --name rpcc-api2 --resource-group rp-floorplan-rg \
  --settings SQL_USER_CONNECTION=true
```

- [ ] **Step 2: Deploy, then confirm nothing changed**

Deploy as normal. Sign in as `connor@randazzo.properties` and load `/inspections`. Expected: works exactly as before — this path still connects as the caller.

- [ ] **Step 3: Flip to the service identity**

```bash
az functionapp config appsettings set \
  --name rpcc-api2 --resource-group rp-floorplan-rg \
  --settings SQL_USER_CONNECTION=false
```

This restarts the Function App. Wait for it to come back.

- [ ] **Step 4: Verify with an account that has NO database principal**

This is the actual acceptance test. Have Carlo or Paolo sign in **without** creating a database user for them, and load `/inspections`, `/buildings` and a tenancy page.

Expected: all load. If they were already granted users as a stopgap, verify instead by checking that a freshly-invited account works with no SQL step.

- [ ] **Step 5: Watch Sentry**

Check the backend Sentry project for 30 minutes. Expected: no new `Query failed`, `Failed to fetch inspections`, `Failed to fetch portfolio occupancy` or `Get procedures failed` issues.

**Rollback at any point:** set `SQL_USER_CONNECTION=true`. No redeploy needed.

---

## Task 8: Document the decision

**Files:**
- Create: `docs/db-access.md`

- [ ] **Step 1: Write it**

```markdown
# Database access model

Handlers connect to Azure SQL as the app's service principal
(`RP Command Centre`), via `createRequestConnection()` in `src/db.ts` —
never as the signed-in user.

**Authorisation is `requireRole` against `dbo.AppUsers`.** It is not the SQL
grant. SQL grants are uniform for every caller: there is no row-level security,
no `SESSION_CONTEXT`, no `SUSER_NAME()` filtering, and server auditing is off.
A per-caller connection therefore enforced nothing, while requiring a contained
database user per person — a manual step that, when missed, made every screen
return 500 while login still worked (login uses the service connection).

## Onboarding a new user

1. Admin invites them in Floorplan (Admin → Users), or they sign in once and
   `registerSelf` creates a Pending row with `Role = NULL`.
2. Admin assigns a role. That is the whole process.

**No SQL step. Do not create database users for people.**

## Rollback

`SQL_USER_CONNECTION=true` restores per-caller connections. Every user then
needs `CREATE USER [x] FROM EXTERNAL PROVIDER` plus `db_datareader` and
`db_datawriter`. Kept as a lever only.

## If auditing is ever turned on

Server auditing is currently `Disabled`. If it is enabled and per-user
attribution is wanted, do NOT go back to per-caller connections — stamp the
caller's OID on writes at the application layer instead, as the
`CreatedById` / `LastModifiedBy` columns already do.
```

- [ ] **Step 2: Link it from the repo README**

Add under the existing docs links in `README.md`:

```markdown
- [Database access model](docs/db-access.md) — why handlers connect as the service principal, and how to onboard users
```

- [ ] **Step 3: Commit** — user stages. Message:

```
docs: record the database access model and user onboarding steps
```

---

## Out of scope (deliberately)

- **Connection pooling.** This plan keeps one fresh connection per request, exactly as today. Pooling is a separate performance change, and a risky one: `createServiceConnection()` returns a *singleton* tedious connection, and tedious cannot serve concurrent Requests — `auth.ts` already carries de-duplication logic written after that exact collision caused spurious 403s. Do not route handler traffic onto the singleton.
- **Removing the `userToken` parameter** from `createRequestConnection`. Keep it until the service path has run clean in production for a few weeks; it is what makes the rollback flag a one-setting change.
- **Revoking Connor's or the directors' database users.** Harmless, and useful for manual querying.
- **The ungated endpoints** found during the audit (`getFeatureFlags`, `getProcedures` read path). Worth a look separately — this change does not make them worse, since a caller still needs a valid Entra token.
